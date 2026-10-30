const express = require("express");
const { requestAccountDeletion } = require("./accountLifecycle");

const RECENT_AUTH_SECONDS = 5 * 60;

function getBearerToken(req) {
  const header = req.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function authMiddleware(admin, logger) {
  return async (req, res, next) => {
    const token = getBearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Authentication is required." });
      return;
    }
    try {
      req.user = await admin.auth().verifyIdToken(token, true);
      next();
    } catch (error) {
      logger.warn?.("Account settings token verification failed", error);
      res.status(401).json({ error: "Invalid authentication token." });
    }
  };
}

function serializeRequest(snapshot) {
  if (!snapshot.exists || snapshot.data().status === "completed") return null;
  const request = snapshot.data();
  const effectiveAt = typeof request.effectiveAt?.toDate === "function"
    ? request.effectiveAt.toDate()
    : request.effectiveAt;
  return {
    status: "pending",
    effectiveAt: effectiveAt ? new Date(effectiveAt).toISOString() : null,
  };
}

function createRequireAccountActive({ database, logger = console }) {
  return async (req, res, next) => {
    if (!req.user?.uid) {
      res.status(401).json({ error: "Authentication is required." });
      return;
    }
    try {
      const snapshot = await database.collection("accountDeletionRequests").doc(req.user.uid).get();
      const status = snapshot.exists ? snapshot.data().status : "";
      if (["pending", "finalizing"].includes(status)) {
        res.status(423).json({ code: "ACCOUNT_DELETION_PENDING", error: "This account is pending deletion and cannot be changed." });
        return;
      }
      if (status === "completed") {
        res.status(410).json({ code: "ACCOUNT_DELETED", error: "This account has been deleted." });
        return;
      }
      // Suspended by an admin: stop changes straight away, without waiting for the sign-in token to expire.
      let suspended = false;
      try { suspended = (await database.collection("users").doc(req.user.uid).get()).data()?.status === "suspended"; } catch { /* Not blocking on a failed lookup. */ }
      if (suspended) {
        res.status(403).json({ code: "ACCOUNT_SUSPENDED", error: "This account has been suspended. Contact Mint Motor support." });
        return;
      }
      next();
    } catch (error) {
      logger.error?.("Unable to check account deletion status", error);
      res.status(500).json({ error: "Unable to verify account status." });
    }
  };
}

function createAccountRoutes({ admin, database, storageStatusDatabase, storage, getStripeClient, timestamp, now = () => new Date(), logger = console }) {
  const router = express.Router();
  router.use(authMiddleware(admin, logger));

  router.get("/", async (req, res) => {
    try {
      const snapshot = await database.collection("accountDeletionRequests").doc(req.user.uid).get();
      res.json({ request: serializeRequest(snapshot) });
    } catch (error) {
      logger.error?.("Unable to read account deletion status", error);
      res.status(500).json({ error: "Unable to load account deletion status." });
    }
  });

  router.post("/", async (req, res) => {
    const currentTime = now();
    const authTime = Number(req.user.auth_time);
    const age = Math.floor(currentTime.getTime() / 1000) - authTime;
    if (!Number.isFinite(authTime) || age < 0 || age > RECENT_AUTH_SECONDS) {
      res.status(401).json({ code: "RECENT_AUTH_REQUIRED", error: "Please sign in again before deleting this account." });
      return;
    }

    try {
      const result = await requestAccountDeletion({
        uid: req.user.uid,
        database,
        storageStatusDatabase,
        storage,
        admin,
        stripe: getStripeClient?.(),
        now: currentTime,
        timestamp: typeof timestamp === "function" ? timestamp() : timestamp,
      });
      const effectiveAt = result.effectiveAt ? new Date(result.effectiveAt).toISOString() : null;
      res.status(result.status === "deleted" ? 200 : 202).json({ status: result.status, effectiveAt });
    } catch (error) {
      logger.error?.("Unable to request account deletion", error);
      const status = error.code === "STRIPE_UNAVAILABLE" || /Stripe billing is not available|Stripe has not provided/i.test(error.message) ? 503 : 500;
      res.status(status).json({ error: status === 503 ? "We cannot safely process account deletion while billing status is unavailable." : "Unable to process account deletion. Please try again or contact support." });
    }
  });

  return router;
}

module.exports = { createAccountRoutes, createRequireAccountActive };
