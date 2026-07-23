const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const express = require("express");
const Stripe = require("stripe");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { admin, database } = require("./firebase");
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
} = require("./validators");
const { VehicleLookupError, lookupVehicle } = require("./vehicleLookup");
const { publicCar, safeVehicleLookup } = require("./publicCar");

const app = express();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

function getMissingStripeBillingConfig() {
  return [
    ["STRIPE_SECRET_KEY", process.env.STRIPE_SECRET_KEY],
    ["STRIPE_SELLER_PRICE_ID", process.env.STRIPE_SELLER_PRICE_ID],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
}

app.post("/billing/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    res.status(503).json({ error: "Stripe webhook is not configured." });
    return;
  }

  const signature = req.get("stripe-signature");
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    logger.warn("Stripe webhook signature verification failed", error);
    res.status(400).send("Invalid Stripe signature.");
    return;
  }

  try {
    await handleStripeEvent(event);
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
  res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  next();
});

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

  if (query.make) results = results.filter((car) => car.make === query.make);
  if (query.body) results = results.filter((car) => car.bodyType === query.body);
  if (query.fuel) {
    results = results.filter((car) => String(car.fuelType).toLowerCase() === String(query.fuel).toLowerCase());
  }
  if (query.transmission) results = results.filter((car) => car.transmission === query.transmission);
  if (query.featured === "true") results = results.filter((car) => car.isFeatured);
  if (query.condition === "new" || query.isNew === "true") results = results.filter((car) => car.isNew === true);
  if (query.condition === "used" || query.isNew === "false") results = results.filter((car) => car.isNew === false);
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
  };
}

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

async function getOrCreateStripeCustomer(user, profile = {}) {
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

async function updateSubscriptionFromStripe(subscription, userIdFromMetadata = "") {
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
  let uid = userIdFromMetadata || subscription.metadata?.firebaseUid || "";

  if (!uid && customerId) {
    const snapshot = await database.collection("users").where("stripeCustomerId", "==", customerId).limit(1).get();
    uid = snapshot.docs[0]?.id || "";
  }

  if (!uid) return;

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
}

async function handleStripeEvent(event) {
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    if (session.mode === "subscription" && session.subscription) {
      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      await updateSubscriptionFromStripe(subscription, session.metadata?.firebaseUid || session.client_reference_id || "");
    }
    return;
  }

  if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
    await updateSubscriptionFromStripe(event.data.object);
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

app.get("/me/subscription", requireAuth, async (req, res) => {
  try {
    const profile = await getUserProfile(req.user.uid);
    res.json({ subscription: serializeSubscription(profile) });
  } catch (error) {
    logger.error("Failed to load subscription", error);
    res.status(500).json({ error: "Unable to load subscription status." });
  }
});

app.post("/me/verification-sync", requireAuth, async (req, res) => {
  try {
    await ensureUserProfile(req.user, {});
    const profile = await syncVerificationProfile(req.user);
    res.json({ profile: serializeUser({ id: req.user.uid, ...profile }) });
  } catch (error) {
    logger.error("Failed to sync verification profile", error);
    res.status(500).json({ error: "Unable to sync verification status." });
  }
});

app.post("/billing/checkout-session", requireAuth, async (req, res) => {
  try {
    const missingStripeConfig = getMissingStripeBillingConfig();
    if (missingStripeConfig.length) {
      res.status(503).json({
        error: `Stripe billing is not configured. Missing: ${missingStripeConfig.join(", ")}.`, 
        missing: missingStripeConfig,
      });
      return;
    }

    await ensureUserProfile(req.user, {});
    const profile = await getUserProfile(req.user.uid);
    const customerId = await getOrCreateStripeCustomer(req.user, profile);
    const frontendUrl = (process.env.FRONTEND_URL || req.get("origin") || "http://localhost:5173").replace(/\/$/, "");
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: req.user.uid,
      line_items: [{ price: process.env.STRIPE_SELLER_PRICE_ID, quantity: 1 }],
      success_url: `${frontendUrl}/my-listings?subscription=success`,
      cancel_url: `${frontendUrl}/my-listings?subscription=cancelled`,
      subscription_data: { metadata: { firebaseUid: req.user.uid } },
      metadata: { firebaseUid: req.user.uid },
      allow_promotion_codes: true,
    });

    res.json({ url: session.url });
  } catch (error) {
    logger.error("Failed to create Stripe checkout session", error);
    res.status(500).json({ error: "Unable to start Stripe Checkout." });
  }
});

app.get("/cars", optionalAuth, async (req, res) => {
  try {
    const snapshot = await database.collection("cars")
      .where("status", "==", LISTING_STATUS.PUBLISHED)
      .get();
    const cars = snapshot.docs.map(serializeCar).map(publicCar);
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
    if (car.status !== LISTING_STATUS.PUBLISHED && car.status !== LISTING_STATUS.SOLD && !isOwner) {
      res.status(404).json({ error: "Vehicle not found." });
      return;
    }

    res.json({ car: isOwner ? car : publicCar(car) });
  } catch (error) {
    logger.error("Failed to load car", error);
    res.status(500).json({ error: "Unable to load vehicle." });
  }
});

app.post("/cars", requireAuth, async (req, res) => {
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
    const docRef = await database.collection("cars").add({
      ...listing,
      ...locationPatch,
      ownerId: req.user.uid,
      ownerEmail: req.user.email || "",
      sellerType: "private",
      status: LISTING_STATUS.DRAFT,
      createdAt: now,
      updatedAt: now,
    });

    const snapshot = await docRef.get();
    res.status(201).json({ car: serializeCar(snapshot) });
  } catch (error) {
    logger.error("Failed to create car", error);
    res.status(500).json({ error: "Unable to create listing." });
  }
});

app.patch("/cars/:id", requireAuth, async (req, res) => {
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

    let locationPatch = {};
    try {
      locationPatch = await buildSellerLocationPatch(listing.sellerPostcode);
    } catch (locationError) {
      res.status(400).json({ errors: [locationError.message] });
      return;
    }

    await docRef.set({
      ...listing,
      ...locationPatch,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    const updated = await docRef.get();
    res.json({ car: serializeCar(updated) });
  } catch (error) {
    logger.error("Failed to update car", error);
    res.status(500).json({ error: "Unable to update listing." });
  }
});

app.patch("/cars/:id/status", requireAuth, async (req, res) => {
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
    const status = String(req.body?.status || "").toLowerCase();
    if (![LISTING_STATUS.PUBLISHED, LISTING_STATUS.SOLD].includes(status)) {
      res.status(400).json({ error: "Only published and sold statuses are supported." });
      return;
    }
    if (current.status === LISTING_STATUS.DRAFT && status === LISTING_STATUS.SOLD) {
      res.status(400).json({ error: "A draft must be published before it can be marked sold." });
      return;
    }
    await docRef.set({ status, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    res.json({ car: serializeCar(await docRef.get()) });
  } catch (error) {
    logger.error("Failed to update listing status", error);
    res.status(500).json({ error: "Unable to update listing status." });
  }
});

app.post("/cars/:id/publish", requireAuth, async (req, res) => {
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

    const errors = validatePublishListing({ ...car, ...req.body });
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

    let verifiedLookup = {lookupProvider: "unavailable"};
    try {
      verifiedLookup = await lookupVehicle({
        registrationNumber: car.registrationNumber,
        mileage: car.mileage,
      });
    } catch (lookupError) {
      logger.warn("Unable to refresh vehicle history before publishing", lookupError);
    }
    const verifiedHistory = selectVehicleHistoryForPublish({
      lookup: verifiedLookup,
      currentHistory: car.vehicleHistory,
      registrationNumber: car.registrationNumber,
    });

    await docRef.set({
      ...locationPatch,
      vehicleHistory: verifiedHistory,
      status: LISTING_STATUS.PUBLISHED,
      publishedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    const updated = await docRef.get();
    res.json({ car: serializeCar(updated) });
  } catch (error) {
    logger.error("Failed to publish car", error);
    res.status(500).json({ error: "Unable to publish listing." });
  }
});

app.delete("/cars/:id", requireAuth, async (req, res) => {
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

    await docRef.delete();
    res.status(204).send("");
  } catch (error) {
    logger.error("Failed to delete car", error);
    res.status(500).json({ error: "Unable to delete listing." });
  }
});

app.get("/cars/:id/distance", async (req, res) => {
  try {
    const buyerPostcode = String(req.query.postcode || "");
    const buyerLocation = await lookupPostcode(buyerPostcode);

    if (!buyerLocation) {
      res.status(400).json({ error: "Enter a valid UK postcode." });
      return;
    }

    const snapshot = await database.collection("cars").doc(req.params.id).get();
    if (!snapshot.exists || snapshot.data().status !== LISTING_STATUS.PUBLISHED) {
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

    if (!carSnapshot.exists || (carSnapshot.data().status !== LISTING_STATUS.PUBLISHED && carSnapshot.data().status !== LISTING_STATUS.SOLD)) {
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
    const enquiryRef = await database.collection("enquiries").add({
      ...enquiry,
      carId: req.params.id,
      carTitle: `${car.year || ""} ${car.make || ""} ${car.model || ""}`.trim(),
      sellerId: car.ownerId,
      sellerEmail: car.contactEmail || car.ownerEmail || "",
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
      .sort((a, b) => toMillis(b.updatedAt || b.createdAt) - toMillis(a.updatedAt || a.createdAt));

    res.json({ cars });
  } catch (error) {
    logger.error("Failed to load seller listings", error);
    res.status(500).json({ error: "Unable to load your listings." });
  }
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

app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

exports.mintapi = onRequest({ region: "us-central1" }, app);












