const { DEALER_STATUS, DEALER_APPLICATION_STATUS } = require("./dealers");

function createRequireDealer({ admin, database, storageStatusDatabase, USER_ROLES, DEALER_STATUS, logger = console }) {
  return async function requireDealer(req, res, next) {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      res.status(401).json({ error: "Authentication is required." });
      return;
    }
    try {
      req.user = await admin.auth().verifyIdToken(token, true);
    } catch (error) {
      logger.warn?.("Dealer token verification failed", error);
      res.status(401).json({ error: "Your session has expired. Please sign in again.", code: "authentication_failed" });
      return;
    }
    try {
      if (req.user.role !== USER_ROLES.DEALER) {
        res.status(403).json({ error: "Approved dealer access is required.", code: "dealer_inactive" });
        return;
      }
      const snapshot = await database.collection("dealers").doc(req.user.uid).get();
      const dealer = snapshot.exists ? snapshot.data() : null;
      const storageSnapshot = storageStatusDatabase
        ? await storageStatusDatabase.collection("storageDealerStatus").doc(req.user.uid).get()
        : null;
      if (!dealer || dealer.dealerStatus !== DEALER_STATUS.APPROVED || (storageSnapshot && (!storageSnapshot.exists || storageSnapshot.data().dealerStatus !== DEALER_STATUS.APPROVED))) {
        res.status(403).json({ error: "Dealer access is not active.", code: "dealer_inactive" });
        return;
      }
      if (req.user.email_verified !== true) {
        res.status(403).json({ error: "Verify your email address before accessing the dealer portal.", code: "email_unverified" });
        return;
      }
      req.dealer = { id: req.user.uid, ...dealer };
      next();
    } catch (error) {
      logger.warn?.("Dealer verification failed", error);
      res.status(503).json({ error: "Unable to check dealer access right now. Please try again.", code: "dealer_service_unavailable" });
    }
  };
}

function createDependencies(overrides) {
  return {
    ...overrides,
    getFrontendUrl: overrides.frontendUrl
      ? () => overrides.frontendUrl
      : overrides.getFrontendUrl,
  };
}

async function createActivationLinks(user, deps) {
  const settings = { url: deps.getFrontendUrl(), handleCodeInApp: false };
  const setupLink = await deps.admin.auth().generatePasswordResetLink(user.email, settings);
  const verificationLink = user.emailVerified
    ? ""
    : await deps.admin.auth().generateEmailVerificationLink(user.email, settings);
  return { setupLink, verificationLink };
}

async function deliverActivation(dealer, user, deps) {
  const links = await createActivationLinks(user, deps);
  await deps.sendActivationEmail({ to: dealer.email, businessName: dealer.businessName, ...links });
}

async function approveDealer({ applicationId, adminUid }, dependencies) {
  const deps = createDependencies(dependencies);
  const applicationRef = deps.database.collection("dealerApplications").doc(applicationId);
  const applicationSnapshot = await applicationRef.get();
  if (!applicationSnapshot.exists) throw Object.assign(new Error("Dealer application not found."), { statusCode: 404 });
  const application = applicationSnapshot.data();
  if (application.status === DEALER_APPLICATION_STATUS.APPROVED && application.dealerId) {
    const existing = await deps.database.collection("dealers").doc(application.dealerId).get();
    if (existing.exists) {
      await deps.storageStatusDatabase?.collection("storageDealerStatus").doc(application.dealerId).set({ dealerStatus: DEALER_STATUS.APPROVED, updatedAt: deps.FieldValue.serverTimestamp() }, { merge: true });
      return existing.data();
    }
  }
  if (application.status !== DEALER_APPLICATION_STATUS.UNDER_REVIEW) {
    throw Object.assign(new Error("Only applications under review can be approved."), { statusCode: 409 });
  }
  let user;
  try {
    user = await deps.admin.auth().getUserByEmail(application.email);
  } catch (error) {
    if (error.code !== "auth/user-not-found") throw error;
    user = await deps.admin.auth().createUser({ email: application.email, emailVerified: false });
  }
  await deps.admin.auth().setCustomUserClaims(user.uid, { ...(user.customClaims || {}), role: "dealer" });
  const dealerRef = deps.database.collection("dealers").doc(user.uid);
  const dealer = {
    authUid: user.uid, applicationId,
    businessName: application.businessName, contactName: application.contactName,
    email: application.email, phone: application.phone, postcode: application.postcode,
    address: application.address, companyNumber: application.companyNumber || "",
    vatNumber: application.vatNumber || "", website: application.website || "",
    dealerType: application.dealerType, dealerStatus: DEALER_STATUS.APPROVED,
    emailVerified: user.emailVerified === true,
    approvedAt: deps.FieldValue.serverTimestamp(), approvedBy: adminUid,
    updatedAt: deps.FieldValue.serverTimestamp(),
  };
  await deps.database.runTransaction(async (transaction) => {
    const current = await transaction.get(applicationRef);
    if (!current.exists || current.data().status !== DEALER_APPLICATION_STATUS.UNDER_REVIEW) {
      throw Object.assign(new Error("Dealer application is no longer reviewable."), { statusCode: 409 });
    }
    transaction.set(dealerRef, { ...dealer, createdAt: deps.FieldValue.serverTimestamp() }, { merge: true });
    transaction.update(applicationRef, {
      status: DEALER_APPLICATION_STATUS.APPROVED, dealerId: user.uid,
      reviewedBy: adminUid, reviewedAt: deps.FieldValue.serverTimestamp(),
      updatedAt: deps.FieldValue.serverTimestamp(),
    });
  });
  await deps.storageStatusDatabase?.collection("storageDealerStatus").doc(user.uid).set({ dealerStatus: DEALER_STATUS.APPROVED, updatedAt: deps.FieldValue.serverTimestamp() }, { merge: true });
  try {
    await deliverActivation({ ...dealer, id: user.uid }, user, deps);
    await dealerRef.set({ activationEmailSentAt: deps.FieldValue.serverTimestamp(), activationEmailLastError: "", updatedAt: deps.FieldValue.serverTimestamp() }, { merge: true });
  } catch (error) {
    deps.logger?.warn?.("Dealer activation email failed", error);
    await dealerRef.set({ activationEmailLastError: String(error.message || "Delivery failed.").slice(0, 300), updatedAt: deps.FieldValue.serverTimestamp() }, { merge: true });
  }
  return (await dealerRef.get()).data();
}

async function resendDealerActivation(uid, dependencies) {
  const deps = createDependencies(dependencies);
  const dealerRef = deps.database.collection("dealers").doc(uid);
  const snapshot = await dealerRef.get();
  if (!snapshot.exists || snapshot.data().dealerStatus !== DEALER_STATUS.APPROVED) {
    throw Object.assign(new Error("Approved dealer not found."), { statusCode: 404 });
  }
  const dealer = snapshot.data();
  const user = await deps.admin.auth().getUser(uid);
  try {
    await deliverActivation(dealer, user, deps);
    await dealerRef.set({ activationEmailSentAt: deps.FieldValue.serverTimestamp(), activationEmailLastError: "", updatedAt: deps.FieldValue.serverTimestamp() }, { merge: true });
  } catch (error) {
    await dealerRef.set({ activationEmailLastError: String(error.message || "Delivery failed.").slice(0, 300), updatedAt: deps.FieldValue.serverTimestamp() }, { merge: true });
    throw Object.assign(new Error("Activation email could not be delivered."), { statusCode: 502 });
  }
  return (await dealerRef.get()).data();
}

module.exports = { approveDealer, createRequireDealer, resendDealerActivation };
