const { normalizedEmailHash } = require("./dealers");
const { unpublishDealerListingsAfterAccessEnds } = require("./billing");

const REQUESTS = "accountDeletionRequests";
const TERMINAL_SUBSCRIPTION_STATUSES = new Set(["canceled", "incomplete_expired"]);
const FINALIZATION_LEASE_MS = 15 * 60 * 1000;

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function periodEnd(subscription) {
  const seconds = subscription.items?.data?.[0]?.current_period_end || subscription.current_period_end;
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
}

function hasPaidAccess(subscription, now = new Date()) {
  if (!subscription || !["active", "trialing"].includes(subscription.status)) return false;
  const end = periodEnd(subscription);
  return !end || end.getTime() > now.getTime();
}

function isTerminalSubscription(subscription) {
  return TERMINAL_SUBSCRIPTION_STATUSES.has(subscription?.status);
}

function profileSubscriptions(user = {}, dealer = {}) {
  return [
    { id: user.stripeSubscriptionId, role: "seller" },
    { id: dealer.stripeDealerSubscriptionId, role: "dealer" },
  ].filter((entry, index, entries) => entry.id && entries.findIndex((candidate) => candidate.id === entry.id) === index);
}

async function isAccountDeletionCompleted(database, uid) {
  if (!database || !uid) return false;
  const request = await database.collection(REQUESTS).doc(uid).get();
  return request.exists && request.data().status === "completed";
}

async function cancelDeletedAccountSubscription({ database, uid, subscription, stripe, now = new Date(), timestamp, role = "unknown" }) {
  if (!database || !uid) return false;
  const requestRef = database.collection(REQUESTS).doc(uid);
  const request = await requestRef.get();
  if (!request.exists) return false;
  const deletion = request.data();
  if (deletion.status === "completed") {
    if (subscription?.id && !isTerminalSubscription(subscription)) {
      if (!stripe?.subscriptions?.cancel) throw new Error("Stripe cancellation is not available for a deleted account subscription.");
      await stripe.subscriptions.cancel(subscription.id);
    }
    return true;
  }

  if (!["pending", "finalizing"].includes(deletion.status)) return false;
  if (!subscription?.id) return true;

  const end = periodEnd(subscription);
  const paidThrough = deletion.status === "pending" && hasPaidAccess(subscription, now) && end;
  let recordedStatus = subscription.status;
  if (paidThrough) {
    if (!subscription.cancel_at_period_end) {
      if (!stripe?.subscriptions?.update) throw new Error("Stripe cancellation scheduling is not available for this account deletion.");
      const scheduled = await stripe.subscriptions.update(subscription.id, { cancel_at_period_end: true });
      if (scheduled?.status) recordedStatus = scheduled.status;
    }
  } else if (deletion.status === "pending" && !isTerminalSubscription(subscription)) {
    if (!stripe?.subscriptions?.cancel) throw new Error("Stripe cancellation is not available for this account deletion.");
    const canceled = await stripe.subscriptions.cancel(subscription.id);
    if (canceled?.status) recordedStatus = canceled.status;
  }

  const coordinate = async (get, set) => {
    const latestSnapshot = await get(requestRef);
    if (!latestSnapshot.exists) return "ignore";
    const latest = latestSnapshot.data();
    if (["completed", "finalizing"].includes(latest.status)) return "cancel";
    if (latest.status !== "pending") return "ignore";

    const subscriptions = Array.isArray(latest.subscriptions) ? [...latest.subscriptions] : [];
    const existing = subscriptions.findIndex((item) => item.id === subscription.id);
    const item = {
      id: subscription.id,
      role: existing >= 0 ? subscriptions[existing].role : role,
      status: recordedStatus,
      effectiveAt: paidThrough || now,
    };
    if (existing >= 0) subscriptions[existing] = { ...subscriptions[existing], ...item };
    else subscriptions.push(item);
    const subscriptionIds = [...new Set([...(latest.subscriptionIds || []), subscription.id])];
    const currentEffectiveAt = toDate(latest.effectiveAt);
    const effectiveAt = paidThrough && currentEffectiveAt?.getTime() > paidThrough.getTime()
      ? currentEffectiveAt
      : (paidThrough || currentEffectiveAt || now);
    await set(requestRef, { subscriptionIds, subscriptions, effectiveAt, updatedAt: timestamp || new Date() }, { merge: true });
    return "recorded";
  };

  const outcome = typeof database.runTransaction === "function"
    ? await database.runTransaction((transaction) => coordinate(
      (ref) => transaction.get(ref),
      (ref, data, options) => transaction.set(ref, data, options),
    ))
    : await coordinate((ref) => ref.get(), (ref, data, options) => ref.set(data, options));

  if (outcome === "cancel" && !TERMINAL_SUBSCRIPTION_STATUSES.has(recordedStatus)) {
    if (!stripe?.subscriptions?.cancel) throw new Error("Stripe cancellation is not available for this account deletion.");
    await stripe.subscriptions.cancel(subscription.id);
  }
  return true;
}

async function getOwnedCars(database, uid) {
  const [owned, dealer] = await Promise.all([
    database.collection("cars").where("ownerId", "==", uid).get(),
    database.collection("cars").where("dealerId", "==", uid).get(),
  ]);
  return [...new Map([...owned.docs, ...dealer.docs].map((doc) => [doc.id, doc])).values()];
}

async function hideAccountListings(database, uid, timestamp) {
  const cars = await getOwnedCars(database, uid);
  const visible = cars.filter((doc) => ["published", "active"].includes(doc.data().status));
  for (let offset = 0; offset < visible.length; offset += 500) {
    const batch = database.batch();
    for (const car of visible.slice(offset, offset + 500)) {
      batch.update(car.ref, { status: "draft", updatedAt: timestamp });
    }
    await batch.commit();
  }
}

async function requestAccountDeletion({ uid, database, storageStatusDatabase, stripe, storage, admin, now = new Date(), timestamp }) {
  if (!uid || !database) throw new Error("An authenticated account is required.");
  const requestRef = database.collection(REQUESTS).doc(uid);
  const prior = await requestRef.get();
  if (prior.exists && prior.data().status === "completed") return { status: "deleted", effectiveAt: null };
  if (prior.exists && ["pending", "finalizing"].includes(prior.data().status)) {
    await hideAccountListings(database, uid, timestamp);
    return { status: "pending", effectiveAt: toDate(prior.data().effectiveAt) || new Date(now) };
  }

  const [userSnapshot, dealerSnapshot] = await Promise.all([
    database.collection("users").doc(uid).get(),
    database.collection("dealers").doc(uid).get(),
  ]);
  const user = userSnapshot.exists ? userSnapshot.data() : {};
  const dealer = dealerSnapshot.exists ? dealerSnapshot.data() : {};
  const storedSubscriptions = profileSubscriptions(user, dealer);
  const subscriptions = [];
  let effectiveAt = new Date(now);

  for (const stored of storedSubscriptions) {
    if (!stripe?.subscriptions?.retrieve) throw new Error("Stripe billing is not available to safely delete this account.");
    let current;
    try {
      current = await stripe.subscriptions.retrieve(stored.id);
      const currentEnd = periodEnd(current);
      if (hasPaidAccess(current, now)) {
        if (!currentEnd) throw new Error("Stripe has not provided a subscription end date yet.");
        if (!current.cancel_at_period_end) {
          await stripe.subscriptions.update(stored.id, { cancel_at_period_end: true });
        }
        if (currentEnd.getTime() > effectiveAt.getTime()) effectiveAt = currentEnd;
      } else if (!isTerminalSubscription(current)) {
        if (!stripe.subscriptions.cancel) throw new Error("Stripe cancellation is not available to safely delete this account.");
        const canceled = await stripe.subscriptions.cancel(stored.id);
        current = canceled?.status ? canceled : await stripe.subscriptions.retrieve(stored.id);
      }
      subscriptions.push({ id: stored.id, role: stored.role, status: current.status, effectiveAt: hasPaidAccess(current, now) ? currentEnd : now });
    } catch (cause) {
      if (cause.message === "Stripe has not provided a subscription end date yet.") throw cause;
      const error = new Error("Stripe billing is unavailable to safely delete this account.");
      error.code = "STRIPE_UNAVAILABLE";
      error.cause = cause;
      throw error;
    }
  }

  const requestedAt = prior.exists ? prior.data().requestedAt : timestamp;
  await requestRef.set({
    status: "pending",
    requestedAt: requestedAt || timestamp,
    effectiveAt,
    subscriptionIds: subscriptions.map((subscription) => subscription.id),
    subscriptions,
    updatedAt: timestamp,
  }, { merge: true });

  await hideAccountListings(database, uid, timestamp);

  if (subscriptions.some((subscription) => !TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status))) {
    const paidThrough = subscriptions
      .filter((subscription) => ["active", "trialing"].includes(subscription.status))
      .map((subscription) => toDate(subscription.effectiveAt))
      .filter((date) => date && date.getTime() > now.getTime())
      .sort((left, right) => right.getTime() - left.getTime())[0];
    if (!paidThrough) effectiveAt = new Date(now);
    return { status: "pending", effectiveAt };
  }

  const result = await finalizeAccountDeletion({ uid, database, storageStatusDatabase, storage, admin, timestamp, now });
  return { status: result.status === "completed" ? "deleted" : "pending", effectiveAt: null };
}

async function deleteSnapshot(database, snapshot) {
  for (let offset = 0; offset < snapshot.docs.length; offset += 500) {
    const batch = database.batch();
    for (const item of snapshot.docs.slice(offset, offset + 500)) batch.delete(item.ref);
    await batch.commit();
  }
}

async function redactSnapshot(snapshot, patchFor) {
  for (const item of snapshot.docs) await item.ref.set(patchFor(item.data()), { merge: true });
}

async function claimAccountDeletionForFinalization({ database, requestRef, now, timestamp }) {
  const claim = async (get, set) => {
    const latest = await get(requestRef);
    if (!latest.exists) throw new Error("No account deletion request was found.");
    const data = latest.data();
    if (data.status === "completed") return "completed";
    const effectiveAt = toDate(data.effectiveAt);
    if (data.status === "pending" && effectiveAt && effectiveAt.getTime() > now.getTime()) return "pending";
    const finalizingStartedAt = toDate(data.finalizingStartedAt);
    if (data.status === "finalizing" && finalizingStartedAt && now.getTime() - finalizingStartedAt.getTime() < FINALIZATION_LEASE_MS) {
      return "pending";
    }
    await set(requestRef, { status: "finalizing", finalizingStartedAt: now, updatedAt: timestamp }, { merge: true });
    return "finalizing";
  };

  if (typeof database.runTransaction === "function") {
    return database.runTransaction((transaction) => claim(
      (ref) => transaction.get(ref),
      (ref, data, options) => transaction.set(ref, data, options),
    ));
  }
  return claim((ref) => ref.get(), (ref, data, options) => ref.set(data, options));
}

async function finalizeAccountDeletion({ uid, database, storageStatusDatabase, storage, admin, timestamp, now = new Date() }) {
  if (!uid || !database) throw new Error("An authenticated account is required.");
  const requestRef = database.collection(REQUESTS).doc(uid);
  const claimStatus = await claimAccountDeletionForFinalization({ database, requestRef, now, timestamp });
  if (claimStatus !== "finalizing") return { status: claimStatus };
  try {
    const [userSnapshot, dealerSnapshot, cars] = await Promise.all([
      database.collection("users").doc(uid).get(),
      database.collection("dealers").doc(uid).get(),
      getOwnedCars(database, uid),
    ]);
    const user = userSnapshot.exists ? userSnapshot.data() : {};
    const dealer = dealerSnapshot.exists ? dealerSnapshot.data() : {};

    if (!storage?.bucket) throw new Error("Cloud Storage is not available to complete account deletion.");
    const bucket = storage.bucket();
    await Promise.all([
      bucket.deleteFiles({ prefix: `users/${uid}/cars/`, ignoreNotFound: true }),
      bucket.deleteFiles({ prefix: `dealers/${uid}/cars/`, ignoreNotFound: true }),
    ]);

    const checks = await database.collection("users").doc(uid).collection("vehicleChecks").get();
    await deleteSnapshot(database, checks);
    await deleteSnapshot(database, { docs: cars.map((car) => ({ ref: car.ref })) });

    const privateCars = await database.collection("dealerCarPrivate").where("dealerId", "==", uid).get();
    await deleteSnapshot(database, privateCars);

    const [sellerEnquiries, sellerDealerEnquiries, buyerDealerEnquiries] = await Promise.all([
      database.collection("enquiries").where("sellerId", "==", uid).get(),
      database.collection("dealerEnquiries").where("sellerOwnerId", "==", uid).get(),
      database.collection("dealerEnquiries").where("buyerDealerId", "==", uid).get(),
    ]);
    await redactSnapshot(sellerEnquiries, () => ({ sellerId: "deleted", sellerEmail: "", sellerName: "", updatedAt: timestamp }));
    await redactSnapshot(sellerDealerEnquiries, (data) => ({
      sellerOwnerId: "deleted",
      ...(data.sellerDealerId === uid ? { sellerDealerId: null } : {}),
      updatedAt: timestamp,
    }));
    await redactSnapshot(buyerDealerEnquiries, () => ({ buyerDealerId: "deleted", message: "Message removed after account deletion.", offerAmount: null, updatedAt: timestamp }));

    const acceptedPolicies = await database.collection("subscriptionAcceptances").where("userId", "==", uid).get();
    const acceptedPoliciesByLegacyUid = await database.collection("subscriptionAcceptances").where("firebaseUid", "==", uid).get();
    const auditRecords = [...new Map([...acceptedPolicies.docs, ...acceptedPoliciesByLegacyUid.docs].map((item) => [item.id, item])).values()];
    for (const item of auditRecords) {
      await item.ref.set({
        ...(item.data().userId === uid ? { userId: "deleted" } : {}),
        ...(item.data().firebaseUid === uid ? { firebaseUid: "deleted" } : {}),
      }, { merge: true });
    }

    const email = String(user.email || dealer.email || "").trim().toLowerCase();
    const applicationIds = new Set([dealer.applicationId].filter(Boolean));
    const emailLockRef = email
      ? database.collection("dealerApplicationLocks").doc(normalizedEmailHash(email))
      : null;
    if (emailLockRef) {
      const emailLock = await emailLockRef.get();
      if (emailLock.exists && emailLock.data().applicationId) applicationIds.add(emailLock.data().applicationId);
      await emailLockRef.delete();
    }
    const dealerApplications = await database.collection("dealerApplications").where("dealerId", "==", uid).get();
    for (const app of dealerApplications.docs) applicationIds.add(app.id);
    for (const applicationId of applicationIds) {
      await database.collection("dealerApplications").doc(applicationId).delete();
      const locks = await database.collection("dealerApplicationLocks").where("applicationId", "==", applicationId).get();
      await deleteSnapshot(database, locks);
    }

    await Promise.all([
      database.collection("users").doc(uid).delete(),
      database.collection("dealers").doc(uid).delete(),
      storageStatusDatabase?.collection("storageDealerStatus").doc(uid).delete() || Promise.resolve(),
    ]);

    try {
      await admin.auth().deleteUser(uid);
    } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }

    await requestRef.set({
      status: "completed",
      finalizingStartedAt: null,
      subscriptionIds: [],
      subscriptions: [],
      completedAt: timestamp,
      updatedAt: timestamp,
    }, { merge: true });
    return { status: "completed" };
  } catch (error) {
    await requestRef.set({ status: "pending", finalizingStartedAt: null, updatedAt: timestamp }, { merge: true });
    throw error;
  }
}

async function processDueAccountDeletions({ database, storageStatusDatabase, storage, admin, stripe, now = new Date(), timestamp, logger = console }) {
  const [pendingRequests, finalizingRequests] = await Promise.all([
    database.collection(REQUESTS).where("status", "==", "pending").get(),
    database.collection(REQUESTS).where("status", "==", "finalizing").get(),
  ]);
  const dueRequests = [...new Map([...pendingRequests.docs, ...finalizingRequests.docs].map((request) => [request.id, request])).values()];
  let processed = 0;
  let failed = 0;

  for (const request of dueRequests) {
    const data = request.data();
    const finalizingStartedAt = toDate(data.finalizingStartedAt);
    if (data.status === "finalizing" && finalizingStartedAt && now.getTime() - finalizingStartedAt.getTime() < FINALIZATION_LEASE_MS) continue;
    const effectiveAt = toDate(data.effectiveAt);
    if (!effectiveAt || effectiveAt.getTime() > now.getTime()) continue;
    try {
      let subscriptionsEnded = true;
      for (const id of data.subscriptionIds || []) {
        if (!stripe?.subscriptions?.retrieve) throw new Error("Stripe billing is not available for deletion reconciliation.");
        const current = await stripe.subscriptions.retrieve(id);
        if (hasPaidAccess(current, now)) {
          if (!current.cancel_at_period_end) await stripe.subscriptions.update(id, { cancel_at_period_end: true });
          subscriptionsEnded = false;
        } else if (!isTerminalSubscription(current)) {
          if (!stripe.subscriptions.cancel) throw new Error("Stripe cancellation is not available for deletion reconciliation.");
          await stripe.subscriptions.cancel(id);
          const refreshed = await stripe.subscriptions.retrieve(id);
          if (!isTerminalSubscription(refreshed)) subscriptionsEnded = false;
        }
      }
      if (!subscriptionsEnded) continue;
      const result = await finalizeAccountDeletion({ uid: request.id, database, storageStatusDatabase, storage, admin, timestamp, now });
      if (result.status === "completed") processed += 1;
    } catch (error) {
      failed += 1;
      logger.warn?.("Account deletion reconciliation failed", { uid: request.id, error });
    }
  }

  return { processed, failed };
}

async function applyDealerSubscriptionLifecycle({ database, dealerId, subscription, tier, timestamp, now = new Date() }) {
  if (!dealerId || !tier) return;
  const end = periodEnd(subscription);
  await database.collection("dealers").doc(dealerId).set({
    stripeDealerCustomerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id || "",
    stripeDealerSubscriptionId: subscription.id,
    dealerSubscriptionStatus: subscription.status,
    dealerSubscriptionCancelAtPeriodEnd: subscription.cancel_at_period_end === true,
    dealerTierKey: tier.key,
    dealerActiveListingLimit: tier.activeLimit,
    dealerFeaturedListingLimit: tier.featuredLimit,
    dealerSubscriptionCurrentPeriodEnd: end,
    updatedAt: timestamp,
  }, { merge: true });

  if (!hasPaidAccess(subscription, now)) {
    await unpublishDealerListingsAfterAccessEnds({ database, dealerId, timestamp });
  }
}

module.exports = {
  applyDealerSubscriptionLifecycle,
  cancelDeletedAccountSubscription,
  finalizeAccountDeletion,
  isAccountDeletionCompleted,
  processDueAccountDeletions,
  requestAccountDeletion,
};
