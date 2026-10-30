const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const express = require("express");
const Stripe = require("stripe");
const crypto = require("crypto");
const { defineSecret } = require("firebase-functions/params");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { admin, database, storage, storageStatusDatabase } = require("./firebase");
const {
  ENQUIRY_STATUS,
  LISTING_STATUS,
  USER_ROLES,
  normalizeUkPostcode,
  isValidUkPostcode,
  validateAdminCarPayload,
  validateAdminEnquiryPayload,
  validateAdminUserPayload,
  validateEnquiryPayload,
  validateListingPayload,
  validatePublishListing,
  validateSellerPublishRequirements,
  hasActiveSubscription,
  selectVehicleHistoryForPublish,
  prepareVehicleHistoryUpdate,
} = require("./validators");
const {
  DEALER_STATUS,
  DEALER_LISTING_STATUS,
  DEALER_APPLICATION_STATUS,
  canTransitionApplication,
  normalizedEmailHash,
  publicDealerCar,
  serializeDealer,
  serializeAdminDealer,
  serializeDealerApplication,
  validateDealerApplication,
} = require("./dealers");
const { sendDealerActivationEmail, sendDealerPlanActivatedEmail } = require("./dealerEmail");
const { approveDealer: approveDealerLifecycle, createRequireDealer, resendDealerActivation: resendDealerActivationLifecycle } = require("./dealerLifecycle");
const { VehicleLookupError, fetchVehicleCheckReport, lookupVehicle } = require("./vehicleLookup");
const { refreshVehicleDataForPublish } = require("./vehiclePublish");
const { createVehicleCheckStore } = require("./vehicleCheckStore");
const { publicCar, safeVehicleLookup } = require("./publicCar");
const { EnquiryEmailDeliveryError, sendEnquiryEmail } = require("./enquiryEmail");
const { DEFAULT_OWNER_ID: SCS_OWNER_ID, syncScsStock } = require("./scsImporter");
const { updateScsStockStatus } = require("./scsStockAdmin");
const { DEALER_TIERS, publicDealerTiers } = require("./dealerTiers");
const { LEGAL_POLICY_VERSION, buildSubscriptionAcceptance, validateSubscriptionAcknowledgement } = require("./legal");
const { buildSellerCheckoutUrls, createCustomerPortalSession, prepareSellerListingPlanUpdate, unpublishPublicListingsAfterAccessEnds, validateRecurringPrice } = require("./billing");
const { applyDealerSubscriptionLifecycle, cancelDeletedAccountSubscription, processDueAccountDeletions } = require("./accountLifecycle");
const { createAccountRoutes, createRequireAccountActive } = require("./accountRoutes");
const { privateSellerPatch, isPublicMarketplaceCar, dealerSubmission, validateSellerIdentity, validatePrivateImageReferences, dateMillis } = require("./sellerPolicy");
const { isLegacyPublicAdvert, expireLegacySellerAdverts } = require("./sellerRetirement");
const { protectExistingSellerMedia } = require("./sellerRetirementMedia");
const { createSellerMediaRouter, prepareSellerListingImages, finalizeSellerListingImages, scrubPrivateImageTokens } = require("./sellerMedia");

const sellerSplitEnabled = () => process.env.SELLER_PLATFORM_SPLIT_ENABLED !== "false";
const dealershipUrl = () => (process.env.DEALER_FRONTEND_URL || "https://dealer.mintmotor.co.uk").replace(/\/$/, "");

const app = express();
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY_MINT");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET_MINT");
const vehicleCheckStore = createVehicleCheckStore({ database, fetchReport: fetchVehicleCheckReport });

function getConfiguredSecret(name, secretParameter) {
  if (process.env[name]) return process.env[name];
  try {
    return secretParameter.value() || "";
  } catch {
    return "";
  }
}

function getStripeClient() {
  const key = getConfiguredSecret("STRIPE_SECRET_KEY_MINT", stripeSecretKey) || process.env.STRIPE_SECRET_KEY;
  return key ? new Stripe(key) : null;
}

// Validates required Stripe environment variables and secrets for seller billing
function getMissingStripeBillingConfig(stripeClient = getStripeClient()) {
  return [
    ["STRIPE_SECRET_KEY_MINT", stripeClient],
    ["STRIPE_SELLER_PRICE_ID", process.env.STRIPE_SELLER_PRICE_ID],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
}

app.post("/billing/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const stripe = getStripeClient();
  const webhookSecret = getConfiguredSecret("STRIPE_WEBHOOK_SECRET_MINT", stripeWebhookSecret) || process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !webhookSecret) {
    res.status(503).json({ error: "Stripe webhook is not configured." });
    return;
  }

  const signature = req.get("stripe-signature");
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (error) {
    logger.warn("Stripe webhook signature verification failed", error);
    res.status(400).send("Invalid Stripe signature.");
    return;
  }

  try {
    await handleStripeEvent(event, stripe);
    res.json({ received: true });
  } catch (error) {
    logger.error("Failed to handle Stripe webhook", error);
    res.status(500).json({ error: "Unable to process Stripe webhook." });
  }
});

app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", req.get("origin") || "*");
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  next();
});

app.use(createSellerMediaRouter({ admin, database, storage, storageStatusDatabase, logger }));

async function syncSellerStorageStatus(id, car, accountActive = true) {
  if (!storageStatusDatabase) return;
  await storageStatusDatabase.collection("storageSellerListings").doc(id).set({
    ownerId: car.ownerId || "", sellerType: car.sellerType || "private",
    listingPlan: car.listingPlan || "", visibility: car.visibility || "public", status: car.status || "draft",
    legacyPublicUntil: Number.isFinite(dateMillis(car.legacyPublicUntil)) ? Timestamp.fromMillis(dateMillis(car.legacyPublicUntil)) : null,
    accountActive,
  });
}

// Persist the private copies before revoking the old public URLs. Both phases are
// retryable; revocation must never delete the only recoverable copy of a photo.
async function protectPrivateSellerImages(id, car) {
  const progressRef = database.collection("sellerPlanRetirementMedia").doc(id);
  const progress = (await progressRef.get()).data();
  const plan = progress?.status === "prepared" ? progress.plan : await prepareSellerListingImages({ bucket: storage.bucket(), car, carId: id, dryRun: false });
  if (progress?.status !== "prepared") await progressRef.set({ status: "prepared", plan, inputImages: car.images || [], updatedAt: FieldValue.serverTimestamp() });
  if (plan.changed) await database.collection("cars").doc(id).set({ images: plan.images }, { merge: true });
  await finalizeSellerListingImages({ bucket: storage.bucket(), plan, persistedImages: plan.images, dryRun: false });
  await progressRef.set({ status: "complete", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return plan.images;
}

app.use("/me/account-deletion", createAccountRoutes({
  admin,
  database,
  storageStatusDatabase,
  storage,
  getStripeClient,
  timestamp: () => FieldValue.serverTimestamp(),
  logger,
}));

async function optionalAuth(req, _res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) {
    next();
    return;
  }

  try {
    req.user = await admin.auth().verifyIdToken(token);
  } catch (error) {
    logger.warn("Invalid auth token", error);
  }

  next();
}

async function requireAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) {
    res.status(401).json({ error: "Authentication is required." });
    return;
  }

  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (error) {
    logger.warn("Auth verification failed", error);
    res.status(401).json({ error: "Invalid authentication token." });
  }
}

async function requireAdmin(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) {
    res.status(401).json({ error: "Authentication is required." });
    return;
  }

  try {
    req.user = await admin.auth().verifyIdToken(token);
    const hasAdminClaim = req.user.admin === true || req.user.role === USER_ROLES.ADMIN;

    if (hasAdminClaim) {
      next();
      return;
    }

    const profile = await database.collection("users").doc(req.user.uid).get();
    const profileData = profile.exists ? profile.data() : {};
    const hasAdminProfile = profileData?.role === USER_ROLES.ADMIN || profileData?.isAdmin === true;

    if (!hasAdminProfile) {
      res.status(403).json({ error: "Admin access is required." });
      return;
    }

    next();
  } catch (error) {
    logger.warn("Admin verification failed", error);
    res.status(401).json({ error: "Invalid authentication token." });
  }
}

function serializeDate(value) {
  return value?.toDate?.().toISOString?.() || value || null;
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  return new Date(value).getTime();
}

async function lookupPostcode(postcode) {
  const normalized = normalizeUkPostcode(postcode);

  if (!isValidUkPostcode(normalized)) {
    return null;
  }

  try {
    const response = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(normalized)}`);
    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    const result = payload?.result;
    if (!result || typeof result.latitude !== "number" || typeof result.longitude !== "number") {
      return null;
    }

    return {
      postcode: result.postcode || normalized,
      geo: {
        lat: result.latitude,
        lng: result.longitude,
      },
    };
  } catch (error) {
    logger.warn("Postcode lookup failed", error);
    return null;
  }
}

function toRadians(value) {
  return value * Math.PI / 180;
}

function calculateDistanceMiles(from, to) {
  const earthRadiusMiles = 3958.8;
  const dLat = toRadians(to.lat - from.lat);
  const dLng = toRadians(to.lng - from.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(from.lat)) * Math.cos(toRadians(to.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(earthRadiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

async function buildSellerLocationPatch(sellerPostcode) {
  if (!sellerPostcode) return {};
  const lookup = await lookupPostcode(sellerPostcode);
  if (!lookup) {
    throw new Error("Enter a valid UK seller postcode.");
  }

  return {
    sellerPostcode: lookup.postcode,
    sellerGeo: lookup.geo,
  };
}


function serializeCar(docOrSnapshot) {
  const data = typeof docOrSnapshot.data === "function" ? docOrSnapshot.data() : docOrSnapshot;
  const id = docOrSnapshot.id || data.id;

  return {
    id,
    ...data,
    createdAt: serializeDate(data.createdAt),
    updatedAt: serializeDate(data.updatedAt),
    publishedAt: serializeDate(data.publishedAt),
  };
}


function serializeEnquiry(docOrSnapshot) {
  const data = typeof docOrSnapshot.data === "function" ? docOrSnapshot.data() : docOrSnapshot;
  const id = docOrSnapshot.id || data.id;

  return {
    id,
    ...data,
    createdAt: serializeDate(data.createdAt),
    updatedAt: serializeDate(data.updatedAt),
  };
}

function serializeUser(docOrSnapshot) {
  const data = typeof docOrSnapshot.data === "function" ? docOrSnapshot.data() : docOrSnapshot;
  const id = docOrSnapshot.id || data.uid || data.id;

  return {
    id,
    uid: data.uid || id,
    email: data.email || "",
    displayName: data.displayName || data.email || "MintMotor user",
    phone: data.phone || "",
    role: data.role || (data.isAdmin ? USER_ROLES.ADMIN : USER_ROLES.USER),
    isAdmin: data.isAdmin === true || data.role === USER_ROLES.ADMIN,
    createdAt: serializeDate(data.createdAt),
    updatedAt: serializeDate(data.updatedAt),
  };
}

function applyCarFilters(cars, query) {
  let results = [...cars];
  const text = String(query.q || query.search || "").trim().toLowerCase();

  if (query.make) results = results.filter((car) => String(car.make).toLowerCase() === String(query.make).toLowerCase());
  if (query.body) results = results.filter((car) => String(car.bodyType).toLowerCase() === String(query.body).toLowerCase());
  if (query.fuel) {
    results = results.filter((car) => String(car.fuelType).toLowerCase() === String(query.fuel).toLowerCase());
  }
  if (query.transmission) results = results.filter((car) => String(car.transmission).toLowerCase() === String(query.transmission).toLowerCase());
  if (query.featured === "true") results = results.filter((car) => car.isFeatured);
  if (query.condition === "new" || query.isNew === "true") results = results.filter((car) => car.isNew === true);
  if (query.condition === "used" || query.isNew === "false") results = results.filter((car) => car.isNew !== true);
  if (query.minPrice) results = results.filter((car) => Number(car.price) >= Number(query.minPrice));
  if (query.maxPrice) results = results.filter((car) => Number(car.price) <= Number(query.maxPrice));
  if (text) {
    results = results.filter((car) => {
      const haystack = [car.make, car.model, car.variant, car.description, car.location].join(" ").toLowerCase();
      return haystack.includes(text);
    });
  }

  switch (query.sort) {
    case "price-asc":
      results.sort((a, b) => Number(a.price) - Number(b.price));
      break;
    case "price-desc":
      results.sort((a, b) => Number(b.price) - Number(a.price));
      break;
    case "mileage-asc":
      results.sort((a, b) => Number(a.mileage) - Number(b.mileage));
      break;
    default:
      results.sort((a, b) => toMillis(b.publishedAt || b.createdAt) - toMillis(a.publishedAt || a.createdAt));
  }

  const limit = Math.min(Number(query.limit) || 60, 100);
  return results.slice(0, limit);
}

function applyAdminCarFilters(cars, query) {
  let results = [...cars];
  const text = String(query.q || query.search || "").trim().toLowerCase();

  if (query.status) {
    results = results.filter((car) => car.status === query.status);
  }

  if (text) {
    results = results.filter((car) => {
      const haystack = [
        car.make,
        car.model,
        car.variant,
        car.registrationNumber,
        car.location,
        car.ownerEmail,
        car.contactEmail,
        car.contactName,
      ].join(" ").toLowerCase();
      return haystack.includes(text);
    });
  }

  results.sort((a, b) => toMillis(b.updatedAt || b.createdAt) - toMillis(a.updatedAt || a.createdAt));

  const limit = Math.min(Number(query.limit) || 100, 200);
  return results.slice(0, limit);
}

async function ensureUserProfile(user, payload = {}) {
  const userRef = database.collection("users").doc(user.uid);
  const snapshot = await userRef.get();
  const now = FieldValue.serverTimestamp();

  const profile = {
    uid: user.uid,
    email: user.email || payload.email || "",
    displayName: payload.displayName || user.name || user.email || "MintMotor Seller",
    phone: payload.phone || "",
    updatedAt: now,
  };

  if (!snapshot.exists) {
    profile.createdAt = now;
    profile.role = USER_ROLES.USER;
    profile.isAdmin = false;
  }

  await userRef.set(profile, { merge: true });
  return profile;
}


function serializeSubscription(profile = {}) {
  const currentPeriodEnd = serializeDate(profile.subscriptionCurrentPeriodEnd);
  const active = hasActiveSubscription(profile);

  return {
    active,
    status: profile.subscriptionStatus || "inactive",
    currentPeriodEnd,
    stripeCustomerId: profile.stripeCustomerId || "",
    cancelAtPeriodEnd: profile.subscriptionCancelAtPeriodEnd === true,
    retired: sellerSplitEnabled(),
  };
}

function isDealerOwnedCar(car = {}) {
  return car.sellerType === "dealer" || car.ownerType === "dealer";
}

const requireAccountActive = createRequireAccountActive({ database, logger });

function serializeDealerCar(docOrSnapshot, privateData = {}) {
  return {
    ...serializeCar(docOrSnapshot),
    tradePrice: privateData.tradePrice ?? null,
    dealerNotes: privateData.dealerNotes || "",
  };
}

function dealerPrivateRef(carId) {
  return database.collection("dealerCarPrivate").doc(carId);
}

const dealerLifecycleDependencies = {
  admin,
  database,
  FieldValue,
  storageStatusDatabase,
  USER_ROLES,
  DEALER_STATUS,
  logger,
  getFrontendUrl: () => (process.env.DEALER_ACTIVATION_CONTINUE_URL || `${process.env.FRONTEND_URL || "https://mintmotor.co.uk"}/dealer/login`).replace(/\/$/, ""),
  sendActivationEmail: (input) => sendDealerActivationEmail(input, { apiKey: process.env.RESEND_API_KEY, from: process.env.RESEND_FROM_EMAIL }),
};
const approveDealer = (input) => approveDealerLifecycle(input, dealerLifecycleDependencies);
const resendDealerActivation = (uid) => resendDealerActivationLifecycle(uid, dealerLifecycleDependencies);
const requireDealer = createRequireDealer({ admin, database, storageStatusDatabase, USER_ROLES, DEALER_STATUS, logger });

async function getUserProfile(uid) {
  const snapshot = await database.collection("users").doc(uid).get();
  return snapshot.exists ? snapshot.data() : {};
}

async function syncVerificationProfile(user) {
  const userRecord = await admin.auth().getUser(user.uid);
  const patch = {
    emailVerified: Boolean(userRecord.emailVerified),
    phoneVerified: Boolean(userRecord.phoneNumber),
    verifiedPhone: userRecord.phoneNumber || "",
    updatedAt: FieldValue.serverTimestamp(),
  };

  await database.collection("users").doc(user.uid).set(patch, { merge: true });
  const profile = await getUserProfile(user.uid);
  return { ...profile, ...patch };
}

async function getOrCreateStripeCustomer(user, profile = {}, stripe) {
  if (!stripe) throw new Error("Stripe is not configured.");
  if (profile.stripeCustomerId) return profile.stripeCustomerId;

  const customer = await stripe.customers.create({
    email: user.email || profile.email || undefined,
    name: profile.displayName || user.name || undefined,
    metadata: { firebaseUid: user.uid },
  });

  await database.collection("users").doc(user.uid).set({
    stripeCustomerId: customer.id,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return customer.id;
}

async function updateSubscriptionFromStripe(subscription, userIdFromMetadata = "", stripe) {
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
  let uid = userIdFromMetadata || subscription.metadata?.firebaseUid || "";

  if (!uid && customerId) {
    const snapshot = await database.collection("users").where("stripeCustomerId", "==", customerId).limit(1).get();
    uid = snapshot.docs[0]?.id || "";
  }

  if (!uid) return;
  if (await cancelDeletedAccountSubscription({ database, uid, subscription, stripe, timestamp: FieldValue.serverTimestamp(), role: "seller" })) {
    logger.info("Ignored Stripe subscription event for a deleted seller account", { uid, subscriptionId: subscription.id });
    return;
  }

  if (sellerSplitEnabled()) {
    // Retired subscriptions remain auditable, but cannot mint new public access.
    // The migration alone writes immutable per-advert legacyPublicUntil grants.
    const profile = await getUserProfile(uid);
    const knownSubscription = profile.stripeSubscriptionId;
    const lateSubscription = knownSubscription && knownSubscription !== subscription.id;
    const periodEnd = subscription.items?.data?.[0]?.current_period_end || subscription.current_period_end;
    const alreadyCancelled = ["canceled", "incomplete_expired"].includes(subscription.status);
    if (!alreadyCancelled && !subscription.cancel_at_period_end && stripe?.subscriptions?.update) {
      await stripe.subscriptions.update(subscription.id, { cancel_at_period_end: true }, { idempotencyKey: `seller-retirement-${subscription.id}` });
    }
    if (!lateSubscription) {
      await database.collection("users").doc(uid).set({
        stripeCustomerId: customerId || profile.stripeCustomerId || "",
        stripeSubscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
        subscriptionCancelAtPeriodEnd: !alreadyCancelled,
        subscriptionCurrentPeriodEnd: periodEnd ? Timestamp.fromMillis(periodEnd * 1000) : null,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    return;
  }

  const item = subscription.items?.data?.[0];
  const periodEndSeconds = item?.current_period_end || subscription.current_period_end;
  await database.collection("users").doc(uid).set({
    stripeCustomerId: customerId || "",
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: subscription.status,
    subscriptionCurrentPeriodEnd: periodEndSeconds
      ? Timestamp.fromMillis(periodEndSeconds * 1000)
      : null,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  if (!hasActiveSubscription({
    subscriptionStatus: subscription.status,
    subscriptionCurrentPeriodEnd: periodEndSeconds ? Timestamp.fromMillis(periodEndSeconds * 1000) : null,
  })) {
    await unpublishPublicListingsAfterAccessEnds({ database, userId: uid, timestamp: FieldValue.serverTimestamp() });
  }
}

async function notifyDealerPlanActivated(dealerId, subscription, tier) {
  if (!tier || !["active", "trialing"].includes(subscription.status)) return;
  const dealerRef = database.collection("dealers").doc(dealerId);
  const dealerSnapshot = await dealerRef.get();
  const dealer = dealerSnapshot.exists ? dealerSnapshot.data() : {};
  if (!dealer.email) return;

  const notificationRef = database.collection("dealerSubscriptionNotifications").doc(subscription.id);
  const shouldSend = await database.runTransaction(async (transaction) => {
    const notification = await transaction.get(notificationRef);
    if (notification.exists && notification.data().status !== "failed") return false;
    transaction.set(notificationRef, {
      dealerId,
      tierKey: tier.key,
      status: "sending",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return true;
  });
  if (!shouldSend) return;

  try {
    const periodEnd = subscription.current_period_end || subscription.items?.data?.[0]?.current_period_end;
    await sendDealerPlanActivatedEmail({
      to: dealer.email,
      businessName: dealer.businessName,
      tierName: tier.name,
      monthlyPricePence: tier.monthlyPricePence,
      activeLimit: tier.activeLimit,
      featuredLimit: tier.featuredLimit,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    }, { apiKey: process.env.RESEND_API_KEY, from: process.env.RESEND_FROM_EMAIL });
    await notificationRef.set({ status: "sent", sentAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  } catch (error) {
    await notificationRef.set({ status: "failed", lastError: String(error.message || "Email delivery failed.").slice(0, 300), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    logger.warn("Dealer plan activation email failed", { dealerId, subscriptionId: subscription.id, error });
  }
}

async function updateDealerSubscriptionFromStripe(subscription, dealerIdFromMetadata = "", stripe, tierKeyFromMetadata = "") {
  const dealerId = dealerIdFromMetadata || subscription.metadata?.firebaseUid || "";
  const tierKey = subscription.metadata?.dealerTierKey || tierKeyFromMetadata;
  const tier = DEALER_TIERS[tierKey];
  if (!dealerId || !tier) return;
  if (await cancelDeletedAccountSubscription({ database, uid: dealerId, subscription, stripe, timestamp: FieldValue.serverTimestamp(), role: "dealer" })) {
    logger.info("Ignored Stripe subscription event for a deleted dealer account", { uid: dealerId, subscriptionId: subscription.id });
    return;
  }
  await applyDealerSubscriptionLifecycle({
    database,
    dealerId,
    subscription,
    tier: { key: tierKey, ...tier },
    timestamp: FieldValue.serverTimestamp(),
  });
  await notifyDealerPlanActivated(dealerId, subscription, { key: tierKey, ...tier });
}

async function handleStripeEvent(event, stripe) {
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    if (session.mode === "subscription" && session.subscription) {
      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      if (session.metadata?.dealerTierKey) await updateDealerSubscriptionFromStripe(subscription, session.metadata?.firebaseUid || session.client_reference_id || "", stripe, session.metadata.dealerTierKey);
      else await updateSubscriptionFromStripe(subscription, session.metadata?.firebaseUid || session.client_reference_id || "", stripe);
    }
    return;
  }

  if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
    if (event.data.object.metadata?.dealerTierKey) await updateDealerSubscriptionFromStripe(event.data.object, "", stripe);
    else await updateSubscriptionFromStripe(event.data.object, "", stripe);
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "mintmotor-api" });
});

app.post("/vehicle-lookup", requireAuth, async (req, res) => {
  try {
    const registrationNumber = String(req.body.registrationNumber || "");
    const mileage = Number(req.body.mileage);

    if (!registrationNumber.trim()) {
      res.status(400).json({ error: "Registration number is required." });
      return;
    }
    if (!Number.isFinite(mileage) || mileage < 0) {
      res.status(400).json({ error: "Enter a valid mileage." });
      return;
    }

    const vehicle = await lookupVehicle({ registrationNumber, mileage });
    res.json({ vehicle: safeVehicleLookup(vehicle) });
  } catch (error) {
    logger.error("Vehicle lookup failed", error);
    if (error instanceof VehicleLookupError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: "Unable to look up vehicle details." });
  }
});


app.post("/vehicle-checks", requireAuth, requireAccountActive, async (req, res) => {
  try {
    const registrationNumber = String(req.body.registrationNumber || "");
    if (!registrationNumber.trim()) {
      res.status(400).json({ error: "Registration number is required." });
      return;
    }

    const report = await vehicleCheckStore.create(req.user.uid, registrationNumber);
    res.status(201).json({ report });
  } catch (error) {
    logger.error("Vehicle check failed", error);
    if (error instanceof VehicleLookupError) {
      res.status(error.statusCode === 404 ? 404 : 502).json({ error: error.message });
      return;
    }
    res.status(502).json({ error: "Unable to create a live vehicle check report." });
  }
});

app.get("/vehicle-checks", requireAuth, async (req, res) => {
  try {
    const reports = await vehicleCheckStore.list(req.user.uid);
    res.json({ reports });
  } catch (error) {
    logger.error("Unable to list vehicle checks", error);
    res.status(500).json({ error: "Unable to load vehicle check reports." });
  }
});

app.get("/vehicle-checks/:reportId", requireAuth, async (req, res) => {
  try {
    const report = await vehicleCheckStore.get(req.user.uid, req.params.reportId);
    if (!report) {
      res.status(404).json({ error: "Vehicle check report not found." });
      return;
    }
    res.json({ report });
  } catch (error) {
    logger.error("Unable to load vehicle check", error);
    res.status(500).json({ error: "Unable to load vehicle check report." });
  }
});
app.get("/me/subscription", requireAuth, async (req, res) => {
  try {
    const profile = await getUserProfile(req.user.uid);
    res.json({ subscription: serializeSubscription(profile) });
  } catch (error) {
    logger.error("Failed to load subscription", error);
    res.status(500).json({ error: "Unable to load subscription status." });
  }
});

app.post("/billing/customer-portal", requireAuth, requireAccountActive, async (req, res) => {
  if (sellerSplitEnabled()) return res.status(410).json({ code: "SELLER_BILLING_RETIRED", error: "Individual seller listings are now free. View previous billing information in your dealership seller workspace." });
  try {
    const stripe = getStripeClient();
    if (!stripe) return res.status(503).json({ error: "Stripe billing is not configured." });
    const profile = await getUserProfile(req.user.uid);
    const frontendUrl = (process.env.FRONTEND_URL || req.get("origin") || "http://localhost:5173").replace(/\/$/, "");
    const session = await createCustomerPortalSession({ stripe, customerId: profile.stripeCustomerId, returnUrl: `${frontendUrl}/my-listings` });
    return res.json({ url: session.url });
  } catch (error) {
    const status = /no Stripe customer/i.test(error.message) ? 409 : 500;
    logger.error("Failed to create seller Customer Portal session", error);
    return res.status(status).json({ error: status === 409 ? "No subscription is available to manage yet." : "Unable to open subscription management." });
  }
});

app.post("/me/verification-sync", requireAuth, requireAccountActive, async (req, res) => {
  try {
    await ensureUserProfile(req.user, {});
    const profile = await syncVerificationProfile(req.user);
    res.json({ profile: serializeUser({ id: req.user.uid, ...profile }) });
  } catch (error) {
    logger.error("Failed to sync verification profile", error);
    res.status(500).json({ error: "Unable to sync verification status." });
  }
});

app.post("/billing/checkout-session", requireAuth, requireAccountActive, async (req, res) => {
  if (sellerSplitEnabled()) return res.status(410).json({ code: "SELLER_BILLING_RETIRED", error: "Individual seller listings are now free and available only to approved dealers." });
  try {
    const draftId = String(req.body?.draftId || "").trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(draftId)) return res.status(400).json({ error: "A valid draft listing is required." });
    const draftSnapshot = await database.collection("cars").doc(draftId).get();
    if (!draftSnapshot.exists || draftSnapshot.data().ownerId !== req.user.uid) return res.status(404).json({ error: "Draft listing not found." });
    if (draftSnapshot.data().listingPlan !== "public-subscription") return res.status(409).json({ error: "Choose the public marketplace option before starting a subscription." });

    const acknowledgement = validateSubscriptionAcknowledgement(req.body);
    if (acknowledgement.errors) return res.status(400).json({ errors: acknowledgement.errors });
    const stripe = getStripeClient();
    const missingStripeConfig = getMissingStripeBillingConfig(stripe);
    if (missingStripeConfig.length) {
      res.status(503).json({
        error: `Stripe billing is not configured. Missing: ${missingStripeConfig.join(", ")}.`, 
        missing: missingStripeConfig,
      });
      return;
    }

    await validateRecurringPrice({ stripe, priceId: process.env.STRIPE_SELLER_PRICE_ID, expectedAmount: 1000 });
    await ensureUserProfile(req.user, {});
    const profile = await getUserProfile(req.user.uid);
    if (hasActiveSubscription(profile)) return res.status(409).json({ error: "Your seller subscription is already active. Publish this draft from your account instead." });
    const customerId = await getOrCreateStripeCustomer(req.user, profile, stripe);
    const frontendUrl = (process.env.FRONTEND_URL || req.get("origin") || "http://localhost:5173").replace(/\/$/, "");
    const checkoutUrls = buildSellerCheckoutUrls({ frontendUrl, draftId });
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      managed_payments: { enabled: false },
      customer: customerId,
      client_reference_id: req.user.uid,
      line_items: [{ price: process.env.STRIPE_SELLER_PRICE_ID, quantity: 1 }],
      success_url: checkoutUrls.successUrl,
      cancel_url: checkoutUrls.cancelUrl,
      subscription_data: { metadata: { firebaseUid: req.user.uid, legalPolicyVersion: LEGAL_POLICY_VERSION, immediateServiceAcknowledged: "true" } },
      metadata: { firebaseUid: req.user.uid, draftId, legalPolicyVersion: LEGAL_POLICY_VERSION, immediateServiceAcknowledged: "true" },
      allow_promotion_codes: true,
    });

    try {
      await database.collection("subscriptionAcceptances").doc(session.id).set({
        ...buildSubscriptionAcceptance({ accountType: "seller", userId: req.user.uid, checkoutSessionId: session.id }),
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (auditError) {
      logger.error("Failed to record seller subscription acceptance", auditError);
    }

    res.json({ url: session.url });
  } catch (error) {
    logger.error("Failed to create Stripe checkout session", error);
    res.status(error.code === "STRIPE_PRICE_CONFIGURATION" ? 503 : 500).json({ error: error.code === "STRIPE_PRICE_CONFIGURATION" ? "Stripe billing is not configured for this subscription yet." : "Unable to start Stripe Checkout." });
  }
});

app.post("/dealer-applications", async (req, res) => {
  try {
    const { application, errors } = validateDealerApplication(req.body);
    if (errors.length) return res.status(400).json({ errors });
    const lockRef = database.collection("dealerApplicationLocks").doc(normalizedEmailHash(application.email));
    const applicationRef = database.collection("dealerApplications").doc();
    await database.runTransaction(async (transaction) => {
      const lock = await transaction.get(lockRef);
      if (lock.exists) throw Object.assign(new Error("An application already exists for this email."), { statusCode: 409 });
      transaction.create(lockRef, { email: application.email, applicationId: applicationRef.id, createdAt: FieldValue.serverTimestamp() });
      transaction.create(applicationRef, { ...application, status: DEALER_APPLICATION_STATUS.SUBMITTED, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    });
    return res.status(201).json({ application: serializeDealerApplication(await applicationRef.get()) });
  } catch (error) {
    logger.warn("Dealer application submission failed", error);
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Unable to submit dealer application." });
  }
});

function serializeAdminDealerApplication(snapshot) {
  const data = snapshot.data();
  return { ...serializeDealerApplication(snapshot), reviewedAt: serializeDate(data.reviewedAt), reviewedBy: data.reviewedBy || "", decisionNote: data.decisionNote || "" };
}

app.get("/admin/dealer-applications", requireAdmin, async (_req, res) => {
  try {
    const snapshot = await database.collection("dealerApplications").orderBy("createdAt", "desc").get();
    res.json({ applications: snapshot.docs.map(serializeAdminDealerApplication) });
  } catch (error) {
    logger.error("Failed to list dealer applications", error);
    res.status(500).json({ error: "Unable to load dealer applications." });
  }
});

app.get("/admin/dealers", requireAdmin, async (_req, res) => {
  try {
    const [snapshot, cars] = await Promise.all([database.collection("dealers").orderBy("updatedAt", "desc").get(), database.collection("cars").get()]);
    const counts = new Map();
    for (const doc of cars.docs) {
      const car = doc.data();
      if (car.dealerId && (car.status === "active" || car.status === "published")) counts.set(car.dealerId, (counts.get(car.dealerId) || 0) + 1);
    }
    res.json({ dealers: snapshot.docs.map((doc) => ({ ...serializeAdminDealer(doc), activeStockCount: counts.get(doc.id) || 0 })) });
  } catch (error) {
    logger.error("Failed to list dealers", error);
    res.status(500).json({ error: "Unable to load dealers." });
  }
});

app.get("/admin/dealers/:uid/cars", requireAdmin, async (req, res) => {
  try {
    const dealer = await database.collection("dealers").doc(req.params.uid).get();
    if (!dealer.exists) return res.status(404).json({ error: "Dealer not found." });
    const snapshot = await database.collection("cars").where("dealerId", "==", req.params.uid).get();
    const cars = await Promise.all(snapshot.docs.map(async (doc) => {
      const privateData = await dealerPrivateRef(doc.id).get();
      return serializeDealerCar(doc, privateData.exists ? privateData.data() : {});
    }));
    return res.json({ cars });
  } catch (error) {
    logger.error("Failed to load dealer inventory", error);
    return res.status(500).json({ error: "Unable to load dealer inventory." });
  }
});

app.get("/admin/dealers/:uid", requireAdmin, async (req, res) => {
  try {
    const snapshot = await database.collection("dealers").doc(req.params.uid).get();
    if (!snapshot.exists) return res.status(404).json({ error: "Dealer not found." });
    const data = snapshot.data();
    const [application, user] = await Promise.all([
      data.applicationId ? database.collection("dealerApplications").doc(data.applicationId).get() : null,
      admin.auth().getUser(req.params.uid).catch((error) => { logger.warn("Dealer auth metadata unavailable", error); return null; }),
    ]);
    return res.json({ dealer: { ...serializeAdminDealer(snapshot), emailVerified: user ? user.emailVerified === true : null, lastSignInAt: user?.metadata?.lastSignInTime || null }, application: application?.exists ? serializeAdminDealerApplication(application) : null });
  } catch (error) {
    logger.error("Failed to load dealer details", error);
    return res.status(500).json({ error: "Unable to load dealer details." });
  }
});

app.get("/admin/dealer-applications/:id", requireAdmin, async (req, res) => {
  const snapshot = await database.collection("dealerApplications").doc(req.params.id).get();
  if (!snapshot.exists) return res.status(404).json({ error: "Dealer application not found." });
  return res.json({ application: { ...serializeDealerApplication(snapshot), decisionNote: snapshot.data().decisionNote || "" } });
});

app.patch("/admin/dealer-applications/:id", requireAdmin, async (req, res) => {
  try {
    const ref = database.collection("dealerApplications").doc(req.params.id);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: "Dealer application not found." });
    const current = snapshot.data();
    const status = String(req.body?.status || "");
    if (!canTransitionApplication(current.status, status)) return res.status(409).json({ error: "That application status change is not allowed." });
    const patch = { status, reviewedBy: req.user.uid, reviewedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
    if (status === DEALER_APPLICATION_STATUS.REJECTED) {
      patch.decisionNote = String(req.body?.decisionNote || "").trim().slice(0, 1000);
      await database.runTransaction(async (transaction) => {
        transaction.update(ref, patch);
        transaction.delete(database.collection("dealerApplicationLocks").doc(normalizedEmailHash(current.email)));
      });
    } else {
      await ref.update(patch);
    }
    res.json({ application: serializeDealerApplication(await ref.get()) });
  } catch (error) {
    logger.error("Failed to update dealer application", error);
    res.status(500).json({ error: "Unable to update dealer application." });
  }
});

app.post("/admin/dealer-applications/:id/approve", requireAdmin, async (req, res) => {
  try {
      const dealer = await approveDealer({ applicationId: req.params.id, adminUid: req.user.uid });
    res.json({ dealer: serializeAdminDealer(dealer) });
  } catch (error) {
    logger.error("Failed to approve dealer", error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Unable to approve dealer." });
  }
});

app.post("/admin/dealers/:uid/resend-activation", requireAdmin, async (req, res) => {
  try {
    res.json({ dealer: serializeAdminDealer(await resendDealerActivation(req.params.uid)) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || "Unable to resend activation email." });
  }
});

async function updateDealerStatus(req, res, dealerStatus) {
  const ref = database.collection("dealers").doc(req.params.uid);
  const snapshot = await ref.get();
  if (!snapshot.exists) return res.status(404).json({ error: "Dealer not found." });
  const patch = dealerStatus === DEALER_STATUS.SUSPENDED
    ? { dealerStatus, suspendedBy: req.user.uid, suspendedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }
    : { dealerStatus, reactivatedBy: req.user.uid, reactivatedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
  const mirrorRef = storageStatusDatabase.collection("storageDealerStatus").doc(req.params.uid);
  if (dealerStatus === DEALER_STATUS.SUSPENDED) {
    await mirrorRef.set({ dealerStatus, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await ref.set(patch, { merge: true });
  } else {
    await ref.set(patch, { merge: true });
    await mirrorRef.set({ dealerStatus, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  return res.json({ dealer: serializeAdminDealer(await ref.get()) });
}
app.post("/admin/dealers/:uid/suspend", requireAdmin, (req, res) => updateDealerStatus(req, res, DEALER_STATUS.SUSPENDED));
app.post("/admin/dealers/:uid/reactivate", requireAdmin, (req, res) => updateDealerStatus(req, res, DEALER_STATUS.APPROVED));

app.get("/dealer/me", requireDealer, async (req, res) => {
  const user = await admin.auth().getUser(req.dealer.id);
  res.json({ dealer: serializeDealer({ ...req.dealer, emailVerified: user.emailVerified === true }) });
});

app.get("/dealer/tiers", requireDealer, (_req, res) => {
  res.json({ tiers: publicDealerTiers() });
});

app.get("/dealer/subscription", requireDealer, async (req, res) => {
  const dealer = req.dealer || {};
  const tier = DEALER_TIERS[dealer.dealerTierKey] || null;
  res.json({ subscription: {
    status: dealer.dealerSubscriptionStatus || "inactive",
    tierKey: dealer.dealerTierKey || "",
    tierName: tier?.name || "No active plan",
    activeLimit: dealer.dealerActiveListingLimit ?? tier?.activeLimit ?? 0,
    featuredLimit: dealer.dealerFeaturedListingLimit ?? tier?.featuredLimit ?? 0,
    currentPeriodEnd: serializeDate(dealer.dealerSubscriptionCurrentPeriodEnd),
  } });
});

app.post("/dealer/billing/customer-portal", requireDealer, requireAccountActive, async (req, res) => {
  try {
    const stripe = getStripeClient();
    if (!stripe) return res.status(503).json({ error: "Stripe billing is not configured." });
    const frontendUrl = (process.env.FRONTEND_URL || req.get("origin") || "https://mintmotor.web.app").replace(/\/$/, "");
    const session = await createCustomerPortalSession({ stripe, customerId: req.dealer.stripeDealerCustomerId, returnUrl: `${frontendUrl}/dealer/plan` });
    return res.json({ url: session.url });
  } catch (error) {
    const status = /no Stripe customer/i.test(error.message) ? 409 : 500;
    logger.error("Failed to create dealer Customer Portal session", error);
    return res.status(status).json({ error: status === 409 ? "No subscription is available to manage yet." : "Unable to open subscription management." });
  }
});

app.post("/dealer/billing/confirm-checkout", requireDealer, requireAccountActive, async (req, res) => {
  const sessionId = String(req.body?.sessionId || "").trim();
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return res.status(400).json({ error: "A valid Checkout session is required." });
  const stripe = getStripeClient();
  if (!stripe?.checkout?.sessions?.retrieve) return res.status(503).json({ error: "Stripe billing is not configured." });

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const sessionDealerId = session.metadata?.firebaseUid || session.client_reference_id || "";
    if (sessionDealerId !== req.dealer.id) return res.status(403).json({ error: "This Checkout session does not belong to this dealer." });
    if (session.mode !== "subscription" || !session.metadata?.dealerTierKey) return res.status(409).json({ error: "This Checkout session is not a Dealer Network plan." });
    if (session.status !== "complete" || !["paid", "no_payment_required"].includes(session.payment_status)) {
      return res.json({ confirmed: false, tierKey: session.metadata.dealerTierKey });
    }

    const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
    if (!subscriptionId) return res.status(409).json({ error: "The completed checkout has no subscription." });
    const subscription = typeof session.subscription === "object" && session.subscription
      ? session.subscription
      : await stripe.subscriptions.retrieve(subscriptionId);
    await updateDealerSubscriptionFromStripe(subscription, req.dealer.id, stripe, session.metadata.dealerTierKey);

    return res.json({ confirmed: true, status: subscription.status, tierKey: session.metadata.dealerTierKey });
  } catch (error) {
    logger.error("Failed to confirm dealer checkout", { dealerId: req.dealer.id, sessionId, error });
    return res.status(500).json({ error: "Unable to confirm your Dealer Network subscription." });
  }
});

app.post("/dealer/billing/checkout-session", requireDealer, requireAccountActive, async (req, res) => {
  const acknowledgement = validateSubscriptionAcknowledgement(req.body);
  if (acknowledgement.errors) return res.status(400).json({ errors: acknowledgement.errors });
  const stripe = getStripeClient();
  const tierKey = String(req.body?.tierKey || "");
  const tier = DEALER_TIERS[tierKey];
  const priceId = tier?.priceEnvKey ? process.env[tier.priceEnvKey] : "";
  if (!stripe) return res.status(503).json({ error: "Dealer billing is not configured." });
  if (!tier || !tier.selfService) return res.status(400).json({ error: "This dealer tier is available through the Mint Motor sales team." });
  if (!priceId) return res.status(503).json({ error: "This dealer tier is not configured for checkout yet." });
  try {
    await validateRecurringPrice({ stripe, priceId, expectedAmount: tier.monthlyPricePence });
    const frontendUrl = dealershipUrl();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      managed_payments: { enabled: false },
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${frontendUrl}/dealer/plan?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/dealer/plan?checkout=cancelled`,
      client_reference_id: req.dealer.id,
      metadata: { firebaseUid: req.dealer.id, dealerTierKey: tierKey, legalPolicyVersion: LEGAL_POLICY_VERSION, immediateServiceAcknowledged: "true" },
      subscription_data: { metadata: { firebaseUid: req.dealer.id, dealerTierKey: tierKey, legalPolicyVersion: LEGAL_POLICY_VERSION, immediateServiceAcknowledged: "true" } },
      integration_identifier: `mintmotor_dealer_${crypto.randomBytes(4).toString("hex")}`,
    });
    try {
      await database.collection("subscriptionAcceptances").doc(session.id).set({
        ...buildSubscriptionAcceptance({ accountType: "dealer", userId: req.dealer.id, checkoutSessionId: session.id, dealerTierKey: tierKey }),
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (auditError) {
      logger.error("Failed to record dealer subscription acceptance", auditError);
    }
    res.json({ url: session.url });
  } catch (error) {
    logger.error("Failed to create dealer checkout session", error);
    res.status(error.code === "STRIPE_PRICE_CONFIGURATION" ? 503 : 500).json({ error: error.code === "STRIPE_PRICE_CONFIGURATION" ? "Stripe billing is not configured for this subscription yet." : "Unable to start dealer checkout." });
  }
});

app.get("/cars", optionalAuth, async (req, res) => {
  try {
    const snapshot = await database.collection("cars")
      .where("status", "in", [LISTING_STATUS.PUBLISHED, DEALER_LISTING_STATUS.ACTIVE])
      .get();
    const cars = snapshot.docs.map(serializeCar).filter((car) => isPublicMarketplaceCar(car)).map(publicCar).map(publicDealerCar);
    res.json({ cars: applyCarFilters(cars, req.query) });
  } catch (error) {
    logger.error("Failed to list cars", error);
    res.status(500).json({ error: "Unable to load vehicles." });
  }
});

app.get("/cars/:id", optionalAuth, async (req, res) => {
  try {
    const snapshot = await database.collection("cars").doc(req.params.id).get();

    if (!snapshot.exists) {
      res.status(404).json({ error: "Vehicle not found." });
      return;
    }

    const car = serializeCar(snapshot);
    const isOwner = req.user?.uid && req.user.uid === car.ownerId;
    if (!isOwner && !isPublicMarketplaceCar(car)) {
      res.status(404).json({ error: "Vehicle not found." });
      return;
    }
    if (car.status !== LISTING_STATUS.PUBLISHED && car.status !== LISTING_STATUS.SOLD && car.status !== DEALER_LISTING_STATUS.ACTIVE && !isOwner) {
      res.status(404).json({ error: "Vehicle not found." });
      return;
    }

    res.json({ car: isOwner ? publicDealerCar(car) : publicDealerCar(publicCar(car)) });
  } catch (error) {
    logger.error("Failed to load car", error);
    res.status(500).json({ error: "Unable to load vehicle." });
  }
});

app.post("/cars", requireAuth, requireAccountActive, async (req, res) => {
  try {
    await ensureUserProfile(req.user, req.body.seller || {});
    const { listing, errors } = validateListingPayload(req.body, { partial: true });

    if (errors.length) {
      res.status(400).json({ errors });
      return;
    }

    let locationPatch = {};
    try {
      locationPatch = await buildSellerLocationPatch(listing.sellerPostcode);
    } catch (locationError) {
      res.status(400).json({ errors: [locationError.message] });
      return;
    }

    const now = FieldValue.serverTimestamp();
    const listingPlan = sellerSplitEnabled() || listing.listingPlan === "dealer-network-free"
      ? "dealer-network-free"
      : "public-subscription";
    const docRef = database.collection("cars").doc();
    if (sellerSplitEnabled()) {
      const imageErrors = validatePrivateImageReferences(listing.images, req.user.uid, docRef.id);
      if (imageErrors.length) return res.status(400).json({ errors: imageErrors });
    }
    await docRef.set({
      ...listing,
      listingPlan,
      visibility: listingPlan === "dealer-network-free" ? "dealer-network" : "public",
      vehicleHistoryVerified: false,
      ...locationPatch,
      ownerId: req.user.uid,
      ownerEmail: req.user.email || "",
      sellerType: "private",
      status: LISTING_STATUS.DRAFT,
      createdAt: now,
      updatedAt: now,
      ...(sellerSplitEnabled() ? privateSellerPatch() : {}),
    });

    const snapshot = await docRef.get();
    await syncSellerStorageStatus(docRef.id, snapshot.data());
    res.status(201).json({ car: serializeCar(snapshot) });
  } catch (error) {
    logger.error("Failed to create car", error);
    res.status(500).json({ error: "Unable to create listing." });
  }
});

app.patch("/cars/:id", requireAuth, requireAccountActive, async (req, res) => {
  try {
    const docRef = database.collection("cars").doc(req.params.id);
    const snapshot = await docRef.get();

    if (!snapshot.exists) {
      res.status(404).json({ error: "Listing not found." });
      return;
    }

    const current = snapshot.data();
    if (current.ownerId !== req.user.uid) {
      res.status(403).json({ error: "You can only edit your own listings." });
      return;
    }

    const { listing, errors } = validateListingPayload(req.body, { partial: true });
    if (errors.length) {
      res.status(400).json({ errors });
      return;
    }

    if (isDealerOwnedCar(current)) return res.status(403).json({ error: "Manage Dealer Network vehicles from your dealer inventory." });
    if (req.body.status !== undefined) return res.status(400).json({ error: "Use the publish or status action to change listing status." });
    if (sellerSplitEnabled() && req.body.listingPlan === "public-subscription" && current.listingPlan !== "public-subscription") return res.status(400).json({ error: "Individual seller listings can only be shared with approved dealers." });
    let planPatch = req.body.listingPlan === undefined ? {} : prepareSellerListingPlanUpdate({
      listingPlan: listing.listingPlan,
      hasSubscription: listing.listingPlan === "public-subscription" && hasActiveSubscription(await getUserProfile(req.user.uid)),
    });
    if (sellerSplitEnabled()) {
      if (req.body.listingPlan === "public-subscription" && !isLegacyPublicAdvert(current)) return res.status(400).json({ error: "Paid public adverts have been retired. Submit to dealers for free." });
      // A plan change requires the owner's explicit confirmation in the free submit flow.
      planPatch = req.body.listingPlan === "dealer-network-free" ? privateSellerPatch(current) : {};
      if (current.listingPlan === "dealer-network-free" || planPatch.listingPlan === "dealer-network-free") {
        if (req.body.images !== undefined) {
          const imageErrors = validatePrivateImageReferences(listing.images, req.user.uid, req.params.id);
          if (imageErrors.length) return res.status(400).json({ errors: imageErrors });
          await scrubPrivateImageTokens({ bucket: storage.bucket(), images: listing.images, ownerId: req.user.uid, carId: req.params.id });
        }
      }
      if (planPatch.listingPlan === "dealer-network-free" && current.listingPlan !== "dealer-network-free") {
        // Close legacy public access before revoking its old media references.
        await syncSellerStorageStatus(req.params.id, { ...current, ...planPatch });
        const images = await protectPrivateSellerImages(req.params.id, current);
        listing.images = req.body.images === undefined ? images : listing.images;
      }
      delete listing.isFeatured;
    }
    const historyUpdate = prepareVehicleHistoryUpdate({
      current,
      payload: req.body,
      listing,
    });
    let locationPatch = {};
    try {
      locationPatch = await buildSellerLocationPatch(listing.sellerPostcode);
    } catch (locationError) {
      res.status(400).json({ errors: [locationError.message] });
      return;
    }

    await docRef.set({
      ...historyUpdate.listing,
      ...planPatch,
      ...(historyUpdate.clearVehicleHistory ? {vehicleHistory: FieldValue.delete()} : {}),
      ...locationPatch,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    const updated = await docRef.get();
    await syncSellerStorageStatus(req.params.id, updated.data());
    res.json({ car: serializeCar(updated) });
  } catch (error) {
    logger.error("Failed to update car", error);
    res.status(500).json({ error: "Unable to update listing." });
  }
});

app.patch("/cars/:id/status", requireAuth, requireAccountActive, async (req, res) => {
  try {
    const docRef = database.collection("cars").doc(req.params.id);
    const snapshot = await docRef.get();
    if (!snapshot.exists) {
      res.status(404).json({ error: "Listing not found." });
      return;
    }
    const current = snapshot.data();
    if (current.ownerId !== req.user.uid) {
      res.status(403).json({ error: "You can only edit your own listings." });
      return;
    }
    if (isDealerOwnedCar(current)) return res.status(403).json({ error: "Manage Dealer Network vehicles from your dealer inventory." });
    const status = String(req.body?.status || "").toLowerCase();
    if (![LISTING_STATUS.DRAFT, LISTING_STATUS.SOLD].includes(status)) {
      res.status(400).json({ error: "Only draft (withdraw) and sold statuses are supported. Use publish to submit a vehicle." });
      return;
    }
    if (current.status === LISTING_STATUS.DRAFT && status === LISTING_STATUS.SOLD) {
      res.status(400).json({ error: "A draft must be published before it can be marked sold." });
      return;
    }
    await syncSellerStorageStatus(req.params.id, { ...current, status });
    await docRef.set({ status, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    if (sellerSplitEnabled() && current.listingPlan === "public-subscription") await protectPrivateSellerImages(req.params.id, { ...current, status });
    res.json({ car: serializeCar(await docRef.get()) });
  } catch (error) {
    logger.error("Failed to update listing status", error);
    res.status(500).json({ error: "Unable to update listing status." });
  }
});

app.post("/cars/:id/publish", requireAuth, requireAccountActive, async (req, res) => {
  try {
    const docRef = database.collection("cars").doc(req.params.id);
    const snapshot = await docRef.get();

    if (!snapshot.exists) {
      res.status(404).json({ error: "Listing not found." });
      return;
    }

    const car = snapshot.data();
    if (car.ownerId !== req.user.uid) {
      res.status(403).json({ error: "You can only publish your own listings." });
      return;
    }
    if (isDealerOwnedCar(car)) return res.status(403).json({ error: "Publish Dealer Network vehicles from your dealer inventory." });

    if (sellerSplitEnabled() && car.listingPlan !== "dealer-network-free") return res.status(409).json({ error: "Confirm the free dealer-only submission before publishing this vehicle." });
    const errors = validatePublishListing(car);
    if (sellerSplitEnabled()) {
      errors.push(...validateSellerIdentity(req.user));
      errors.push(...validatePrivateImageReferences(car.images, car.ownerId, req.params.id));
    } else if (car.listingPlan !== "dealer-network-free") {
      const profileSnapshot = await database.collection("users").doc(req.user.uid).get();
      errors.push(...validateSellerPublishRequirements({
        authUser: req.user,
        profile: profileSnapshot.exists ? profileSnapshot.data() : {},
      }));
    }
    if (errors.length) {
      res.status(400).json({ errors });
      return;
    }

    let locationPatch = {};
    if (!car.sellerGeo && car.sellerPostcode) {
      try {
        locationPatch = await buildSellerLocationPatch(car.sellerPostcode);
      } catch (locationError) {
        res.status(400).json({ errors: [locationError.message] });
        return;
      }
    }

    const historySelection = await refreshVehicleDataForPublish({
      car,
      lookupVehicle,
      selectVehicleHistoryForPublish,
      logger,
    });

    await docRef.set({
      ...locationPatch,
      vehicleHistory: historySelection.vehicleHistory,
      vehicleHistoryVerified: historySelection.vehicleHistoryVerified,
      status: LISTING_STATUS.PUBLISHED,
      publishedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    const updated = await docRef.get();
    await syncSellerStorageStatus(req.params.id, updated.data());
    res.json({ car: serializeCar(updated) });
  } catch (error) {
    logger.error("Failed to publish car", error);
    res.status(500).json({ error: "Unable to publish listing." });
  }
});

app.delete("/cars/:id", requireAuth, requireAccountActive, async (req, res) => {
  try {
    const docRef = database.collection("cars").doc(req.params.id);
    const snapshot = await docRef.get();

    if (!snapshot.exists) {
      res.status(404).json({ error: "Listing not found." });
      return;
    }

    if (snapshot.data().ownerId !== req.user.uid) {
      res.status(403).json({ error: "You can only delete your own listings." });
      return;
    }
    if (isDealerOwnedCar(snapshot.data())) return res.status(403).json({ error: "Manage Dealer Network vehicles from your dealer inventory." });

    await syncSellerStorageStatus(req.params.id, { ...snapshot.data(), status: "deleted" }, false);
    await docRef.delete();
    res.status(204).send("");
  } catch (error) {
    logger.error("Failed to delete car", error);
    res.status(500).json({ error: "Unable to delete listing." });
  }
});

async function getDealerPrivateCar(carId) {
  const [carSnapshot, privateSnapshot] = await Promise.all([
    database.collection("cars").doc(carId).get(),
    dealerPrivateRef(carId).get(),
  ]);
  if (!carSnapshot.exists) return null;
  return { car: carSnapshot.data(), privateData: privateSnapshot.exists ? privateSnapshot.data() : {} };
}

function validateDealerPrivatePayload(payload = {}) {
  const tradePrice = Number(payload.tradePrice);
  const dealerNotes = String(payload.dealerNotes || "").trim().slice(0, 3000);
  const errors = [];
  if (!Number.isFinite(tradePrice) || tradePrice < 0) errors.push("Enter a valid trade price.");
  return { privateData: { tradePrice, dealerNotes }, errors };
}

function hasActiveDealerSubscription(dealer = {}) {
  if (!["active", "trialing"].includes(dealer.dealerSubscriptionStatus)) return false;
  if (!dealer.dealerSubscriptionCurrentPeriodEnd) return true;
  const periodEnd = typeof dealer.dealerSubscriptionCurrentPeriodEnd.toDate === "function"
    ? dealer.dealerSubscriptionCurrentPeriodEnd.toDate()
    : new Date(dealer.dealerSubscriptionCurrentPeriodEnd);
  return !Number.isNaN(periodEnd.getTime()) && periodEnd.getTime() > Date.now();
}

app.get("/dealer/cars", requireDealer, async (req, res) => {
  const snapshot = await database.collection("cars").where("dealerId", "==", req.dealer.id).get();
  const cars = await Promise.all(snapshot.docs.map(async (doc) => {
    const privateSnapshot = await dealerPrivateRef(doc.id).get();
    return serializeDealerCar(doc, privateSnapshot.exists ? privateSnapshot.data() : {});
  }));
  res.json({ cars: applyCarFilters(cars, req.query) });
});

app.post("/dealer/cars", requireDealer, requireAccountActive, async (req, res) => {
  try {
    const { listing, errors } = validateListingPayload(req.body, { partial: true });
    const { privateData, errors: privateErrors } = validateDealerPrivatePayload(req.body);
    if (errors.length || privateErrors.length) return res.status(400).json({ errors: [...errors, ...privateErrors] });
    const ref = database.collection("cars").doc();
    await database.runTransaction(async (transaction) => {
      transaction.set(ref, {
        ...listing,
        ownerId: req.dealer.id,
        ownerEmail: req.dealer.email,
        ownerType: "dealer",
        dealerId: req.dealer.id,
        sellerType: "dealer",
        visibility: "public",
        status: LISTING_STATUS.DRAFT,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.set(dealerPrivateRef(ref.id), { carId: ref.id, dealerId: req.dealer.id, ...privateData, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    });
    res.status(201).json({ car: serializeDealerCar(await ref.get(), privateData) });
  } catch (error) {
    logger.error("Failed to create dealer listing", error);
    res.status(500).json({ error: "Unable to create dealer listing." });
  }
});

app.get("/dealer/cars/:id", requireDealer, async (req, res) => {
  const record = await getDealerPrivateCar(req.params.id);
  if (!record || record.car.dealerId !== req.dealer.id) return res.status(404).json({ error: "Listing not found." });
  res.json({ car: serializeDealerCar({ id: req.params.id, ...record.car }, record.privateData) });
});

app.patch("/dealer/cars/:id", requireDealer, requireAccountActive, async (req, res) => {
  const record = await getDealerPrivateCar(req.params.id);
  if (!record) return res.status(404).json({ error: "Listing not found." });
  if (record.car.dealerId !== req.dealer.id) return res.status(403).json({ error: "You can only edit your own listings." });
  const { listing, errors } = validateListingPayload(req.body, { partial: true });
  const hasPrivateChanges = Object.prototype.hasOwnProperty.call(req.body, "tradePrice") || Object.prototype.hasOwnProperty.call(req.body, "dealerNotes");
  const privateResult = hasPrivateChanges ? validateDealerPrivatePayload({ ...record.privateData, ...req.body }) : { privateData: record.privateData, errors: [] };
  if (errors.length || privateResult.errors.length) return res.status(400).json({ errors: [...errors, ...privateResult.errors] });
  const isPromotingToFeatured = record.car.status === DEALER_LISTING_STATUS.ACTIVE && record.car.isFeatured !== true && listing.isFeatured === true;
  if (isPromotingToFeatured && !hasActiveDealerSubscription(req.dealer)) {
    return res.status(403).json({ error: "Choose an active Dealer Network plan before using a featured listing." });
  }
  try {
    await database.runTransaction(async (transaction) => {
      if (isPromotingToFeatured) {
        const featuredLimit = Number(req.dealer.dealerFeaturedListingLimit || 0);
        const featuredListings = await transaction.get(database.collection("cars")
          .where("dealerId", "==", req.dealer.id)
          .where("status", "==", DEALER_LISTING_STATUS.ACTIVE)
          .where("isFeatured", "==", true));
        if (!Number.isFinite(featuredLimit) || featuredLimit < 1 || featuredListings.size >= featuredLimit) {
          throw Object.assign(new Error(`Your plan allows ${featuredLimit} featured Dealer Network listings. Choose a higher plan or remove featured status from another listing.`), { statusCode: 403 });
        }
      }
      transaction.set(database.collection("cars").doc(req.params.id), { ...listing, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      if (hasPrivateChanges) transaction.set(dealerPrivateRef(req.params.id), { ...privateResult.privateData, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    throw error;
  }
  res.json({ car: serializeDealerCar(await database.collection("cars").doc(req.params.id).get(), privateResult.privateData) });
});

app.delete("/dealer/cars/:id", requireDealer, requireAccountActive, async (req, res) => {
  const record = await getDealerPrivateCar(req.params.id);
  if (!record) return res.status(404).json({ error: "Listing not found." });
  if (record.car.dealerId !== req.dealer.id) return res.status(403).json({ error: "You can only delete your own listings." });
  await database.runTransaction(async (transaction) => {
    transaction.delete(database.collection("cars").doc(req.params.id));
    transaction.delete(dealerPrivateRef(req.params.id));
  });
  res.status(204).send("");
});

app.post("/dealer/cars/:id/publish", requireDealer, requireAccountActive, async (req, res) => {
  const record = await getDealerPrivateCar(req.params.id);
  if (!record) return res.status(404).json({ error: "Listing not found." });
  if (record.car.dealerId !== req.dealer.id) return res.status(403).json({ error: "You can only publish your own listings." });
  if (!hasActiveDealerSubscription(req.dealer)) {
    return res.status(403).json({ error: "Choose an active Dealer Network plan before publishing listings." });
  }
  const activeLimit = Number(req.dealer.dealerActiveListingLimit || 0);
  const featuredLimit = Number(req.dealer.dealerFeaturedListingLimit || 0);
  const isAlreadyActive = record.car.status === DEALER_LISTING_STATUS.ACTIVE;
  if (!isAlreadyActive && (!Number.isFinite(activeLimit) || activeLimit < 1)) {
    return res.status(403).json({ error: "Your current Dealer Network plan does not include active listings." });
  }
  const errors = validatePublishListing(record.car);
  if (errors.length) return res.status(400).json({ errors });
  const historySelection = await refreshVehicleDataForPublish({
    car: record.car,
    lookupVehicle,
    selectVehicleHistoryForPublish,
    logger,
  });
  try {
    await database.runTransaction(async (transaction) => {
      if (!isAlreadyActive) {
        const activeListings = await transaction.get(database.collection("cars")
          .where("dealerId", "==", req.dealer.id)
          .where("status", "==", DEALER_LISTING_STATUS.ACTIVE));
        if (activeListings.size >= activeLimit) {
          throw Object.assign(new Error(`Your plan allows ${activeLimit} active Dealer Network listings. Upgrade your plan or unpublish a listing to continue.`), { statusCode: 403 });
        }
        if (record.car.isFeatured === true) {
          const featuredListings = await transaction.get(database.collection("cars")
            .where("dealerId", "==", req.dealer.id)
            .where("status", "==", DEALER_LISTING_STATUS.ACTIVE)
            .where("isFeatured", "==", true));
          if (!Number.isFinite(featuredLimit) || featuredLimit < 1 || featuredListings.size >= featuredLimit) {
            throw Object.assign(new Error(`Your plan allows ${featuredLimit} featured Dealer Network listings. Choose a higher plan or remove featured status from another listing.`), { statusCode: 403 });
          }
        }
      }
      transaction.set(database.collection("cars").doc(req.params.id), {
        vehicleHistory: historySelection.vehicleHistory,
        vehicleHistoryVerified: historySelection.vehicleHistoryVerified,
        status: DEALER_LISTING_STATUS.ACTIVE,
        publishedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    throw error;
  }
  res.json({ car: serializeDealerCar(await database.collection("cars").doc(req.params.id).get(), record.privateData) });
});

async function approvedDealerIds() {
  const snapshot = await database.collection("dealers").where("dealerStatus", "==", DEALER_STATUS.APPROVED).get();
  return new Set(snapshot.docs.map((doc) => doc.id));
}

app.get("/dealer/network/cars", requireDealer, async (req, res) => {
  const carsSnapshot = await database.collection("cars").where("visibility", "==", "dealer-network").get();
  const cars = carsSnapshot.docs.filter((doc) => {
    const car = doc.data();
    return car.sellerType === "private" && car.listingPlan === "dealer-network-free" && car.status === LISTING_STATUS.PUBLISHED;
  }).map((doc) => {
    return dealerSubmission(serializeCar(doc));
  });
  res.json({ cars: applyCarFilters(cars, req.query) });
});

app.get("/dealer/network/cars/:id", requireDealer, async (req, res) => {
  const record = await getDealerPrivateCar(req.params.id);
  if (!record || record.car.visibility !== "dealer-network" || record.car.status !== LISTING_STATUS.PUBLISHED || record.car.sellerType !== "private" || record.car.listingPlan !== "dealer-network-free") {
    return res.status(404).json({ error: "Vehicle not found." });
  }
  res.json({ car: dealerSubmission({ id: req.params.id, ...record.car }), seller: null });
});

app.post("/dealer/network/cars/:id/enquiries", requireDealer, requireAccountActive, async (req, res) => {
  const record = await getDealerPrivateCar(req.params.id);
  if (!record || record.car.visibility !== "dealer-network" || record.car.status !== LISTING_STATUS.PUBLISHED || record.car.sellerType !== "private" || record.car.listingPlan !== "dealer-network-free") {
    return res.status(404).json({ error: "Vehicle not found." });
  }
  const message = String(req.body?.message || "").trim();
  const offerAmount = req.body?.offerAmount === undefined ? null : Number(req.body.offerAmount);
  if (message.length < 10 || message.length > 2000) return res.status(400).json({ error: "Message must be between 10 and 2,000 characters." });
  if (offerAmount !== null && (!Number.isFinite(offerAmount) || offerAmount < 0)) return res.status(400).json({ error: "Offer amount must be a valid GBP value." });
  const ref = await database.collection("dealerEnquiries").add({ carId: req.params.id, buyerDealerId: req.dealer.id, sellerOwnerId: record.car.ownerId, sellerDealerId: record.car.dealerId || null, message, offerAmount, status: "submitted", createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  res.status(201).json({ enquiry: serializeEnquiry(await ref.get()) });
});

app.get("/dealer/enquiries", requireDealer, async (req, res) => {
  const [buyer, seller] = await Promise.all([
    database.collection("dealerEnquiries").where("buyerDealerId", "==", req.dealer.id).get(),
    database.collection("dealerEnquiries").where("sellerDealerId", "==", req.dealer.id).get(),
  ]);
  const records = new Map([...buyer.docs, ...seller.docs].map((doc) => [doc.id, serializeEnquiry(doc)]));
  res.json({ enquiries: [...records.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) });
});

app.get("/cars/:id/distance", async (req, res) => {
  try {
    const existing = await database.collection("cars").doc(req.params.id).get();
    if (!existing.exists || !isPublicMarketplaceCar(existing.data()) || existing.data().status === LISTING_STATUS.SOLD) return res.status(404).json({ error: "Vehicle not found." });
    const buyerPostcode = String(req.query.postcode || "");
    const buyerLocation = await lookupPostcode(buyerPostcode);

    if (!buyerLocation) {
      res.status(400).json({ error: "Enter a valid UK postcode." });
      return;
    }

    const snapshot = await database.collection("cars").doc(req.params.id).get();
    if (!snapshot.exists || (snapshot.data().status !== LISTING_STATUS.PUBLISHED && snapshot.data().status !== DEALER_LISTING_STATUS.ACTIVE)) {
      res.status(404).json({ error: "Vehicle not found." });
      return;
    }

    const car = snapshot.data();
    if (!car.sellerGeo || typeof car.sellerGeo.lat !== "number" || typeof car.sellerGeo.lng !== "number") {
      res.status(409).json({ error: "Distance is not available for this listing yet." });
      return;
    }

    res.json({
      distanceMiles: calculateDistanceMiles(buyerLocation.geo, car.sellerGeo),
      buyerPostcodeNormalized: buyerLocation.postcode,
    });
  } catch (error) {
    logger.error("Failed to calculate distance", error);
    res.status(500).json({ error: "We could not check distance right now." });
  }
});


app.post("/cars/:id/enquiries", async (req, res) => {
  try {
    const carRef = database.collection("cars").doc(req.params.id);
    const carSnapshot = await carRef.get();

    if (!carSnapshot.exists || !isPublicMarketplaceCar(carSnapshot.data())) {
      res.status(404).json({ error: "Vehicle not found." });
      return;
    }

    if (carSnapshot.data().status === LISTING_STATUS.SOLD) {
      res.status(409).json({ error: "This listing is sold and cannot receive enquiries." });
      return;
    }

    const { enquiry, errors } = validateEnquiryPayload(req.body);
    if (errors.length) {
      res.status(400).json({ errors });
      return;
    }

    const car = carSnapshot.data();
    if (car.allowEnquiries === false) {
      res.status(409).json({ error: "This listing is not accepting enquiries." });
      return;
    }

    const sellerEmail = String(car.contactEmail || car.ownerEmail || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sellerEmail)) {
      res.status(422).json({ error: "This listing cannot receive enquiry emails." });
      return;
    }

    const carTitle = `${car.year || ""} ${car.make || ""} ${car.model || ""}`.trim();
    try {
      await sendEnquiryEmail({
        to: sellerEmail,
        replyTo: enquiry.email,
        carTitle,
        carId: req.params.id,
        enquiry,
      }, {
        apiKey: process.env.RESEND_API_KEY,
        from: process.env.RESEND_FROM_EMAIL,
      });
    } catch (error) {
      if (error instanceof EnquiryEmailDeliveryError) {
        logger.error("Unable to deliver enquiry email", error);
        res.status(502).json({ error: "Unable to deliver enquiry email." });
        return;
      }
      throw error;
    }

    const enquiryRef = await database.collection("enquiries").add({
      ...enquiry,
      carId: req.params.id,
      carTitle,
      sellerId: car.ownerId,
      sellerEmail,
      status: "new",
      createdAt: FieldValue.serverTimestamp(),
    });

    res.status(201).json({ id: enquiryRef.id, ok: true });
  } catch (error) {
    logger.error("Failed to create enquiry", error);
    res.status(500).json({ error: "Unable to send enquiry." });
  }
});

app.get("/me/listings", requireAuth, async (req, res) => {
  try {
    const snapshot = await database.collection("cars")
      .where("ownerId", "==", req.user.uid)
      .get();
    const cars = snapshot.docs.map(serializeCar)
      .filter((car) => !isDealerOwnedCar(car))
      .sort((a, b) => toMillis(b.updatedAt || b.createdAt) - toMillis(a.updatedAt || a.createdAt));

    res.json({ cars });
  } catch (error) {
    logger.error("Failed to load seller listings", error);
    res.status(500).json({ error: "Unable to load your listings." });
  }
});

app.get("/me/dealer-enquiries", requireAuth, async (req, res) => {
  try {
    const snapshot = await database.collection("dealerEnquiries").where("sellerOwnerId", "==", req.user.uid).get();
    const enquiries = await Promise.all(snapshot.docs.map(async (doc) => {
      const data = doc.data();
      const [vehicle, dealer] = await Promise.all([database.collection("cars").doc(data.carId).get(), database.collection("dealers").doc(data.buyerDealerId).get()]);
      const car = vehicle.exists && vehicle.data().ownerId === req.user.uid ? vehicle.data() : {};
      const business = dealer.exists ? dealer.data() : {};
      return { id: doc.id, carId: data.carId, message: data.message || "", offerAmount: data.offerAmount ?? null, status: data.status || "submitted", createdAt: serializeDate(data.createdAt), vehicle: { id: data.carId, make: car.make || "", model: car.model || "", year: car.year || null }, dealer: { businessName: business.businessName || "Dealership", email: business.email || "", phone: business.phone || "", website: business.website || "" } };
    }));
    res.json({ enquiries: enquiries.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt)) });
  } catch (error) { logger.error("Failed to load seller dealer enquiries", error); res.status(500).json({ error: "Unable to load dealer enquiries." }); }
});

app.get("/me/enquiries", requireAuth, async (req, res) => {
  try {
    const snapshot = await database.collection("enquiries")
      .where("sellerId", "==", req.user.uid)
      .get();
    const enquiries = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        createdAt: data.createdAt?.toDate?.().toISOString?.() || data.createdAt || null,
      };
    }).sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));

    res.json({ enquiries });
  } catch (error) {
    logger.error("Failed to load enquiries", error);
    res.status(500).json({ error: "Unable to load enquiries." });
  }
});

app.post("/admin/import/scs", requireAdmin, async (req, res) => {
  try {
    const result = await syncScsStock({
      ownerId: SCS_OWNER_ID,
      downloadStockImages: req.body?.downloadImages !== false,
    });
    res.json({ ownerId: SCS_OWNER_ID, ...result });
  } catch (error) {
    logger.error("Failed to import SCS stock", error);
    res.status(502).json({ error: error.message || "Unable to import SCS stock." });
  }
});

app.get("/admin/summary", requireAdmin, async (_req, res) => {
  try {
    const [carsSnapshot, enquiriesSnapshot, usersSnapshot] = await Promise.all([
      database.collection("cars").get(),
      database.collection("enquiries").get(),
      database.collection("users").get(),
    ]);

    const cars = carsSnapshot.docs.map(serializeCar);
    const enquiries = enquiriesSnapshot.docs.map(serializeEnquiry);
    const users = usersSnapshot.docs.map(serializeUser);

    const publishedCars = cars.filter((car) => car.status === LISTING_STATUS.PUBLISHED);
    const draftCars = cars.filter((car) => car.status === LISTING_STATUS.DRAFT);
    const openEnquiries = enquiries.filter((enquiry) => enquiry.status !== ENQUIRY_STATUS.CLOSED);

    res.json({
      summary: {
        totalCars: cars.length,
        publishedCars: publishedCars.length,
        draftCars: draftCars.length,
        totalEnquiries: enquiries.length,
        openEnquiries: openEnquiries.length,
        totalUsers: users.length,
      },
      latestCars: cars
        .sort((a, b) => toMillis(b.updatedAt || b.createdAt) - toMillis(a.updatedAt || a.createdAt))
        .slice(0, 5),
      latestEnquiries: enquiries
        .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt))
        .slice(0, 5),
    });
  } catch (error) {
    logger.error("Failed to load admin summary", error);
    res.status(500).json({ error: "Unable to load admin summary." });
  }
});

app.get("/admin/cars", requireAdmin, async (req, res) => {
  try {
    const snapshot = await database.collection("cars").get();
    const cars = applyAdminCarFilters(snapshot.docs.map(serializeCar), req.query);
    res.json({ cars });
  } catch (error) {
    logger.error("Failed to load admin cars", error);
    res.status(500).json({ error: "Unable to load admin listings." });
  }
});

app.patch("/admin/cars/scs-status", requireAdmin, async (req, res) => {
  const status = String(req.body?.status || "").trim().toLowerCase();
  if (![LISTING_STATUS.PUBLISHED, LISTING_STATUS.DRAFT].includes(status)) {
    res.status(400).json({ error: "SCS stock status must be published or draft." });
    return;
  }

  try {
    const result = await updateScsStockStatus({
      database,
      status,
      timestamp: FieldValue.serverTimestamp(),
    });
    res.json(result);
  } catch (error) {
    logger.error("Failed to update SCS stock status", error);
    res.status(500).json({ error: "Unable to update SCS stock status." });
  }
});

app.patch("/admin/cars/:id", requireAdmin, async (req, res) => {
  try {
    const { patch, errors } = validateAdminCarPayload(req.body);
    if (errors.length) {
      res.status(400).json({ errors });
      return;
    }

    const docRef = database.collection("cars").doc(req.params.id);
    const snapshot = await docRef.get();

    if (!snapshot.exists) {
      res.status(404).json({ error: "Listing not found." });
      return;
    }

    const update = {
      ...patch,
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (patch.status === LISTING_STATUS.PUBLISHED && !snapshot.data().publishedAt) {
      update.publishedAt = FieldValue.serverTimestamp();
    }

    await docRef.set(update, { merge: true });

    const updated = await docRef.get();
    res.json({ car: serializeCar(updated) });
  } catch (error) {
    logger.error("Failed to update admin car", error);
    res.status(500).json({ error: "Unable to update listing." });
  }
});

app.delete("/admin/cars/:id", requireAdmin, async (req, res) => {
  try {
    const docRef = database.collection("cars").doc(req.params.id);
    const snapshot = await docRef.get();

    if (!snapshot.exists) {
      res.status(404).json({ error: "Listing not found." });
      return;
    }

    await docRef.delete();
    res.status(204).send("");
  } catch (error) {
    logger.error("Failed to delete admin car", error);
    res.status(500).json({ error: "Unable to delete listing." });
  }
});

app.get("/admin/enquiries", requireAdmin, async (req, res) => {
  try {
    const snapshot = await database.collection("enquiries").get();
    let enquiries = snapshot.docs.map(serializeEnquiry);

    if (req.query.status) {
      enquiries = enquiries.filter((enquiry) => enquiry.status === req.query.status);
    }

    enquiries.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
    res.json({ enquiries: enquiries.slice(0, Math.min(Number(req.query.limit) || 100, 200)) });
  } catch (error) {
    logger.error("Failed to load admin enquiries", error);
    res.status(500).json({ error: "Unable to load enquiries." });
  }
});

app.patch("/admin/enquiries/:id", requireAdmin, async (req, res) => {
  try {
    const { patch, errors } = validateAdminEnquiryPayload(req.body);
    if (errors.length) {
      res.status(400).json({ errors });
      return;
    }

    const docRef = database.collection("enquiries").doc(req.params.id);
    const snapshot = await docRef.get();

    if (!snapshot.exists) {
      res.status(404).json({ error: "Enquiry not found." });
      return;
    }

    await docRef.set({
      ...patch,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    const updated = await docRef.get();
    res.json({ enquiry: serializeEnquiry(updated) });
  } catch (error) {
    logger.error("Failed to update admin enquiry", error);
    res.status(500).json({ error: "Unable to update enquiry." });
  }
});

app.get("/admin/users", requireAdmin, async (req, res) => {
  try {
    const snapshot = await database.collection("users").get();
    let users = snapshot.docs.map(serializeUser);
    const text = String(req.query.q || req.query.search || "").trim().toLowerCase();

    if (text) {
      users = users.filter((user) => {
        const haystack = [user.email, user.displayName, user.phone, user.role].join(" ").toLowerCase();
        return haystack.includes(text);
      });
    }

    users.sort((a, b) => toMillis(b.updatedAt || b.createdAt) - toMillis(a.updatedAt || a.createdAt));
    res.json({ users: users.slice(0, Math.min(Number(req.query.limit) || 100, 200)) });
  } catch (error) {
    logger.error("Failed to load admin users", error);
    res.status(500).json({ error: "Unable to load users." });
  }
});

app.patch("/admin/users/:uid", requireAdmin, async (req, res) => {
  try {
    const { patch, errors } = validateAdminUserPayload(req.body);
    if (errors.length) {
      res.status(400).json({ errors });
      return;
    }

    const userRef = database.collection("users").doc(req.params.uid);
    const update = {
      ...patch,
      uid: req.params.uid,
      updatedAt: FieldValue.serverTimestamp(),
    };

    await userRef.set(update, { merge: true });

    if (patch.role) {
      try {
        const userRecord = await admin.auth().getUser(req.params.uid);
        await admin.auth().setCustomUserClaims(req.params.uid, {
          ...(userRecord.customClaims || {}),
          admin: patch.role === USER_ROLES.ADMIN,
          role: patch.role,
        });
      } catch (claimError) {
        logger.warn("Unable to update custom claims for user", claimError);
      }
    }

    const updated = await userRef.get();
    res.json({ user: serializeUser(updated) });
  } catch (error) {
    logger.error("Failed to update admin user", error);
    res.status(500).json({ error: "Unable to update user." });
  }
});

app.get("/platform-settings/homepage", async (req, res) => {
  try {
    const doc = await database.collection("platform_settings").doc("homepage").get();
    res.json(doc.exists ? doc.data() : {});
  } catch (error) {
    logger.error("Failed to fetch homepage settings", error);
    res.status(500).json({ error: "Unable to fetch homepage settings." });
  }
});

app.put("/admin/platform-settings/homepage", requireAdmin, async (req, res) => {
  try {
    const patch = { ...req.body, updatedAt: FieldValue.serverTimestamp() };
    await database.collection("platform_settings").doc("homepage").set(patch, { merge: true });
    
    const updated = await database.collection("platform_settings").doc("homepage").get();
    res.json(updated.exists ? updated.data() : {});
  } catch (error) {
    logger.error("Failed to update homepage settings", error);
    res.status(500).json({ error: "Unable to update homepage settings." });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

exports.mintapi = onRequest({ region: "us-central1", timeoutSeconds: 540, memory: "1GiB", secrets: [stripeSecretKey, stripeWebhookSecret] }, app);
exports.app = app;
exports.sellerRetirementReconciliation = onSchedule({ schedule: "every 60 minutes", timeZone: "Etc/UTC", region: "us-central1", timeoutSeconds: 540, memory: "1GiB" }, async () => {
  if (!sellerSplitEnabled()) return;
  const now = Date.now();
  await expireLegacySellerAdverts({ database, now, timestamp: FieldValue.serverTimestamp() });
  const result = await protectExistingSellerMedia({ database, storageStatusDatabase, bucket: storage.bucket(), dryRun: false, now });
  if (result.errors.length) throw new Error(`${result.errors.length} private seller photo migrations need a retry.`);
});
exports.accountDeletionReconciliation = onSchedule({
  schedule: "every 60 minutes",
  timeZone: "Etc/UTC",
  region: "us-central1",
  timeoutSeconds: 540,
  memory: "1GiB",
  secrets: [stripeSecretKey],
}, async () => {
  const result = await processDueAccountDeletions({
    database,
    storageStatusDatabase,
    storage,
    admin,
    stripe: getStripeClient(),
    now: new Date(),
    timestamp: FieldValue.serverTimestamp(),
    logger,
  });
  if (result.failed) {
    logger.error("Some account deletion requests still need reconciliation", result);
    throw new Error(`${result.failed} account deletion request(s) need a retry.`);
  }
});












