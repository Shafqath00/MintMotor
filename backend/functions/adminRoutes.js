// Admin console API: dashboard, activity, team, subscriptions, payments, plans, complaints,
// moderation, user and dealer overviews, CSV exports and announcements.
const express = require("express");
const { actorFromRequest } = require("./adminAudit");
const { ADMIN_ROLES, ROLE_LABELS, ROLE_PERMISSIONS } = require("./adminRoles");
const { serializePayment, filterPayments, netPence } = require("./adminPayments");
const { DEALER_TIERS, getEffectiveTiers, invalidateTierCache, validatePlanUpdate, PLAN_CONFIG } = require("./dealerTiers");
const { setOwnerSuspensionHide, MODERATION_STATUS, REPORT_STATUS, serializeReport, validateReportReview, validateModeration, moderationPatch, createReport, isModeratedOut } = require("./adminModeration");
const { buildStats, buildSubscriptions, filterSubscriptions, listingKind, LISTING_KIND_LABELS, ms, iso } = require("./adminStats");
const { EXPORTS, toCsv } = require("./adminExport");

const ANNOUNCEMENT = { collection: "platformConfig", id: "announcement" };
const TONES = ["info", "success", "warning"];
const AUDIENCES = ["main", "dealer", "both"];

function pageOf(rows, query, defaultSize = 25) {
  const size = Math.min(Math.max(Number(query.pageSize) || defaultSize, 1), 100);
  const page = Math.max(Number(query.page) || 1, 1);
  return { rows: rows.slice((page - 1) * size, page * size), page, pageSize: size, total: rows.length, pages: Math.max(Math.ceil(rows.length / size), 1) };
}

function createAdminRouter(deps) {
  const { database, admin, FieldValue, logger, auth, audit, serializeCar, serializeUser, serializeEnquiry, getStripeClient, validateRecurringPrice } = deps;
  const { requireAdmin, requirePermission, requireConfirmation } = auth;
  const router = express.Router();
  router.use(express.json({ limit: "100kb" }));

  const docs = async (name) => (await database.collection(name).get()).docs;
  const rowsOf = async (name) => (await docs(name)).map((doc) => ({ id: doc.id, ...doc.data() }));
  const record = (req, entry) => audit.record({ actor: actorFromRequest(req), ...entry });
  const fail = (res, error, message, label = "Admin request failed") => { logger.error(label, error); res.status(500).json({ error: message }); };

  async function loadSnapshot() {
    const [cars, users, dealers, applications, enquiries, payments, reports] = await Promise.all([
      docs("cars").then((d) => d.map(serializeCar)), rowsOf("users"), rowsOf("dealers"), rowsOf("dealerApplications"), rowsOf("enquiries"),
      docs("payments").then((d) => d.map(serializePayment)), docs("listingReports").then((d) => d.map(serializeReport)),
    ]);
    const tiers = await getEffectiveTiers(database);
    const subscriptions = buildSubscriptions({ users, dealers, cars, tiers, now: Date.now() });
    return { cars, users, dealers, applications, enquiries, payments, reports, tiers, subscriptions };
  }

  // Who am I, and what may I do? The console uses this to show only the sections this role can use.
  router.get("/me", requireAdmin, (req, res) => {
    res.json({ uid: req.user.uid, email: req.user.email || "", role: req.adminRole, roleLabel: ROLE_LABELS[req.adminRole], permissions: [...req.adminPermissions] });
  });

  // ── Dashboard ──────────────────────────────────────────────────────────────
  router.get("/stats", requirePermission("stats.read"), async (req, res) => {
    try {
      const data = await loadSnapshot();
      const stats = buildStats({ ...data, days: Number(req.query.days) || 30, now: Date.now() });
      const person = (u) => ({ id: u.id, email: u.email || "", name: u.displayName || u.email || "", role: u.role || "user", createdAt: iso(u.createdAt) });
      const recentUsers = data.users.filter((u) => u.role !== "admin").sort((a, b) => (ms(b.createdAt) || 0) - (ms(a.createdAt) || 0)).slice(0, 6).map(person);
      const recentListings = [...data.cars].sort((a, b) => (ms(b.createdAt) || 0) - (ms(a.createdAt) || 0)).slice(0, 6)
        .map((c) => ({ id: c.id, title: [c.year, c.make, c.model].filter(Boolean).join(" "), status: c.status, kind: listingKind(c), kindLabel: LISTING_KIND_LABELS[listingKind(c)], createdAt: iso(c.createdAt) }));
      const recentActivity = req.adminPermissions.has("activity.read") ? (await audit.list({ limit: 8 })).entries : [];
      res.json({ ...stats, recentUsers, recentListings, recentActivity });
    } catch (error) { fail(res, error, "Unable to load dashboard figures.", "Admin stats failed"); }
  });

  // ── Activity ───────────────────────────────────────────────────────────────
  router.get("/activity", requirePermission("activity.read"), async (req, res) => {
    try {
      const { category, action, actorUid, targetId, targetType, q, before, limit } = req.query;
      res.json(await audit.list({ category, action, actorUid, targetId, targetType, q, before, limit }));
    } catch (error) { fail(res, error, "Unable to load activity.", "Admin activity failed"); }
  });

  // ── Team and roles ─────────────────────────────────────────────────────────
  router.get("/team", requirePermission("team.manage"), async (req, res) => {
    try {
      const members = (await rowsOf("adminTeam")).map((m) => ({ uid: m.id, email: m.email || "", role: m.role, active: m.active !== false, addedAt: iso(m.addedAtMs), addedBy: m.addedBy || "" }));
      res.json({ members, roles: ADMIN_ROLES.map((role) => ({ role, label: ROLE_LABELS[role], permissions: ROLE_PERMISSIONS[role] })), you: { uid: req.user.uid, role: req.adminRole } });
    } catch (error) { fail(res, error, "Unable to load the team.", "Admin team failed"); }
  });

  router.post("/team", requirePermission("team.manage"), requireConfirmation, async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const role = String(req.body?.role || "");
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter the person's email address." });
    if (!ADMIN_ROLES.includes(role)) return res.status(400).json({ error: "Choose a role." });
    try {
      let user;
      try { user = await admin.auth().getUserByEmail(email); }
      catch (error) { if (error.code === "auth/user-not-found") return res.status(404).json({ error: "No account exists for that email. They need to sign up on Mint Motor first." }); throw error; }
      if ((user.customClaims || {}).role === "dealer") return res.status(409).json({ error: "Dealer accounts can't be admins. Use a separate staff email." });
      await admin.auth().setCustomUserClaims(user.uid, { ...(user.customClaims || {}), admin: true, role: "admin", adminRole: role });
      await database.collection("users").doc(user.uid).set({ role: "admin", isAdmin: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await database.collection("adminTeam").doc(user.uid).set({ role, email, active: true, addedBy: req.user.uid, addedAtMs: Date.now() }, { merge: true });
      await record(req, { action: "team.add", category: "team", target: { type: "user", id: user.uid, label: email }, summary: `Gave ${email} the ${ROLE_LABELS[role]} role`, details: { role } });
      res.status(201).json({ member: { uid: user.uid, email, role, active: true } });
    } catch (error) { fail(res, error, "Unable to add this person.", "Admin team add failed"); }
  });

  router.patch("/team/:uid", requirePermission("team.manage"), requireConfirmation, async (req, res) => {
    const { uid } = req.params;
    try {
      const ref = database.collection("adminTeam").doc(uid);
      const existing = await ref.get();
      if (!existing.exists) return res.status(404).json({ error: "That person isn't on the admin team." });
      const current = existing.data();
      const patch = {};
      if (req.body?.role !== undefined) { if (!ADMIN_ROLES.includes(req.body.role)) return res.status(400).json({ error: "Choose a role." }); patch.role = req.body.role; }
      if (req.body?.active !== undefined) { if (typeof req.body.active !== "boolean") return res.status(400).json({ error: "Active must be true or false." }); patch.active = req.body.active; }
      if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to change." });
      const losesOwner = current.role === "owner" && current.active !== false && (patch.role && patch.role !== "owner" || patch.active === false);
      if (losesOwner) {
        const owners = (await rowsOf("adminTeam")).filter((m) => m.role === "owner" && m.active !== false);
        if (owners.length <= 1) return res.status(409).json({ error: "There must always be at least one active owner." });
      }
      if (uid === req.user.uid && patch.active === false) return res.status(409).json({ error: "You can't remove your own access." });
      await ref.set(patch, { merge: true });
      const user = await admin.auth().getUser(uid);
      const claims = { ...(user.customClaims || {}) };
      if (patch.role) claims.adminRole = patch.role;
      if (patch.active === false) { delete claims.admin; claims.role = "user"; delete claims.adminRole; }
      if (patch.active === true) { claims.admin = true; claims.role = "admin"; claims.adminRole = patch.role || current.role; }
      await admin.auth().setCustomUserClaims(uid, claims);
      if (patch.active === false) await admin.auth().revokeRefreshTokens(uid);
      await database.collection("users").doc(uid).set({ role: patch.active === false ? "user" : "admin", isAdmin: patch.active !== false, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await record(req, { action: patch.active === false ? "team.remove" : "team.update", category: "team", target: { type: "user", id: uid, label: current.email }, summary: patch.active === false ? `Removed ${current.email} from the admin team` : `Changed ${current.email}'s admin role`, details: { before: { role: current.role, active: current.active !== false }, after: patch } });
      res.json({ member: { uid, email: current.email, role: patch.role || current.role, active: patch.active ?? current.active !== false } });
    } catch (error) { fail(res, error, "Unable to update this person.", "Admin team update failed"); }
  });

  // ── Subscriptions, payments and plans ─────────────────────────────────────
  router.get("/subscriptions", requirePermission("subscriptions.read"), async (req, res) => {
    try {
      const { users, dealers, cars, tiers } = await loadSnapshot();
      const rows = filterSubscriptions(buildSubscriptions({ users, dealers, cars, tiers, now: Date.now() }), req.query);
      const all = buildSubscriptions({ users, dealers, cars, tiers, now: Date.now() });
      const counts = Object.fromEntries(["active", "past_due", "pending", "cancelled", "expired", "paused"].map((s) => [s, all.filter((r) => r.status === s).length]));
      res.json({ ...pageOf(rows, req.query), subscriptions: pageOf(rows, req.query).rows, counts });
    } catch (error) { fail(res, error, "Unable to load subscriptions.", "Admin subscriptions failed"); }
  });

  router.get("/payments", requirePermission("payments.read"), async (req, res) => {
    try {
      const all = (await docs("payments")).map(serializePayment);
      const filtered = filterPayments(all, req.query);
      const paid = filtered.filter((p) => p.status === "paid" || p.status === "refunded");
      const page = pageOf(filtered, req.query);
      res.json({ payments: page.rows, page: page.page, pageSize: page.pageSize, total: page.total, pages: page.pages, summary: {
        collectedPence: paid.reduce((sum, p) => sum + netPence(p), 0),
        refundedPence: filtered.reduce((sum, p) => sum + p.amountRefundedPence, 0),
        failedCount: filtered.filter((p) => p.status === "failed").length,
        invoiceCount: filtered.length,
      } });
    } catch (error) { fail(res, error, "Unable to load payments.", "Admin payments failed"); }
  });

  router.get("/plans", requirePermission("subscriptions.read"), async (_req, res) => {
    try {
      const [tiers, dealers] = await Promise.all([getEffectiveTiers(database), rowsOf("dealers")]);
      const subscribers = {};
      for (const dealer of dealers) if (["active", "trialing", "past_due"].includes(dealer.dealerSubscriptionStatus)) subscribers[dealer.dealerTierKey] = (subscribers[dealer.dealerTierKey] || 0) + 1;
      res.json({ plans: Object.entries(tiers).map(([key, tier]) => ({ key, name: tier.name, defaultName: DEALER_TIERS[key].name, monthlyPricePence: tier.monthlyPricePence, defaultMonthlyPricePence: DEALER_TIERS[key].monthlyPricePence, priceId: tier.priceId || "", activeLimit: tier.activeLimit, featuredLimit: tier.featuredLimit, offered: tier.offered !== false, selfService: tier.selfService, subscribers: subscribers[key] || 0, stripeConfigured: Boolean(tier.priceId || (tier.priceEnvKey && process.env[tier.priceEnvKey])) })) });
    } catch (error) { fail(res, error, "Unable to load plans.", "Admin plans failed"); }
  });

  router.put("/plans/:key", requirePermission("plans.manage"), requireConfirmation, async (req, res) => {
    const { key } = req.params;
    try {
      const tiers = await getEffectiveTiers(database);
      const { patch, errors } = validatePlanUpdate(key, req.body, tiers);
      if (errors.length) return res.status(400).json({ errors });
      if (patch.priceId) {
        const stripe = getStripeClient();
        if (!stripe) return res.status(503).json({ error: "Stripe isn't configured, so the new price can't be checked." });
        try { await validateRecurringPrice({ stripe, priceId: patch.priceId, expectedAmount: patch.monthlyPricePence }); }
        catch { return res.status(400).json({ error: "Stripe doesn't have an active monthly GBP price with that ID and amount." }); }
      }
      const ref = database.collection(PLAN_CONFIG.collection).doc(PLAN_CONFIG.id);
      const snapshot = await ref.get();
      const overrides = snapshot.exists ? snapshot.data().overrides || {} : {};
      overrides[key] = { ...(overrides[key] || {}), ...patch };
      await ref.set({ overrides, updatedBy: req.user.uid, updatedAtMs: Date.now() }, { merge: true });
      invalidateTierCache();
      let updatedDealers = 0;
      if (patch.activeLimit !== undefined || patch.featuredLimit !== undefined) {
        const after = (await getEffectiveTiers(database))[key];
        const subscribed = (await database.collection("dealers").where("dealerTierKey", "==", key).get()).docs;
        for (const doc of subscribed) { await doc.ref.set({ dealerActiveListingLimit: after.activeLimit, dealerFeaturedListingLimit: after.featuredLimit }, { merge: true }); updatedDealers += 1; }
      }
      const before = tiers[key];
      await record(req, { action: "plan.update", category: "subscription", target: { type: "plan", id: key, label: before.name }, summary: `Changed the ${before.name} plan`, details: { before: Object.fromEntries(Object.keys(patch).map((k) => [k, before[k]])), after: patch, dealersUpdated: updatedDealers } });
      res.json({ ok: true, dealersUpdated: updatedDealers });
    } catch (error) { fail(res, error, "Unable to save this plan.", "Admin plan update failed"); }
  });

  // ── Complaints and moderation ─────────────────────────────────────────────
  router.get("/complaints", requirePermission("complaints.manage"), async (req, res) => {
    try {
      let rows = (await docs("listingReports")).map(serializeReport).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const counts = Object.fromEntries(Object.values(REPORT_STATUS).map((s) => [s, rows.filter((r) => r.status === s).length]));
      if (req.query.status) rows = rows.filter((r) => r.status === req.query.status);
      const page = pageOf(rows, req.query);
      res.json({ complaints: page.rows, page: page.page, pages: page.pages, total: page.total, counts });
    } catch (error) { fail(res, error, "Unable to load complaints.", "Admin complaints failed"); }
  });

  router.patch("/complaints/:id", requirePermission("complaints.manage"), async (req, res) => {
    try {
      const { patch, errors } = validateReportReview(req.body);
      if (errors.length) return res.status(400).json({ errors });
      const ref = database.collection("listingReports").doc(req.params.id);
      const existing = await ref.get();
      if (!existing.exists) return res.status(404).json({ error: "Complaint not found." });
      const final = [REPORT_STATUS.RESOLVED, REPORT_STATUS.DISMISSED].includes(patch.status);
      await ref.set({ ...patch, resolvedBy: final ? req.user.uid : "", resolvedAtMs: final ? Date.now() : null }, { merge: true });
      const current = existing.data();
      await record(req, { action: `complaint.${patch.status}`, category: "complaint", target: { type: "listing", id: current.carId, label: current.carLabel }, summary: `Marked a complaint as ${patch.status}`, details: { reason: current.reason, note: patch.resolutionNote } });
      res.json({ complaint: serializeReport({ id: req.params.id, data: () => ({ ...current, ...patch, resolvedAtMs: final ? Date.now() : null }) }) });
    } catch (error) { fail(res, error, "Unable to update this complaint.", "Admin complaint update failed"); }
  });

  router.post("/cars/:id/moderate", requirePermission("listings.moderate"), async (req, res) => {
    const { action, reason, errors } = validateModeration(req.body);
    if (errors.length) return res.status(400).json({ errors });
    if (action !== "restore" && String(req.get("x-confirm-action") || "").toLowerCase() !== "true") return res.status(428).json({ code: "CONFIRMATION_REQUIRED", error: "Confirm this action to continue." });
    try {
      const ref = database.collection("cars").doc(req.params.id);
      const existing = await ref.get();
      if (!existing.exists) return res.status(404).json({ error: "Listing not found." });
      const car = existing.data();
      await ref.set(moderationPatch(action, reason, req.user.uid, FieldValue), { merge: true });
      const after = await ref.get();
      if (deps.onCarChanged) await deps.onCarChanged(req.params.id, after.data());
      await record(req, { action: `listing.${action}`, category: "moderation", target: { type: "listing", id: req.params.id, label: [car.year, car.make, car.model].filter(Boolean).join(" ") }, summary: action === "restore" ? "Restored a listing" : `${action === "hide" ? "Hid" : "Rejected"} a listing`, details: { reason, before: car.moderationStatus || MODERATION_STATUS.OK, after: after.data().moderationStatus } });
      res.json({ car: serializeCar(after) });
    } catch (error) { fail(res, error, "Unable to moderate this listing.", "Admin moderation failed"); }
  });

  router.get("/cars/:id/history", requirePermission("listings.read"), async (req, res) => {
    try {
      const snapshot = await database.collection("cars").doc(req.params.id).get();
      const timeline = await audit.timeline(req.params.id);
      if (!snapshot.exists && !timeline.length) return res.status(404).json({ error: "Listing not found." });
      const car = snapshot.exists ? serializeCar(snapshot) : null;
      // Listings made before the activity log existed still show when they were created and last changed.
      const known = new Set(timeline.map((e) => e.action));
      const baseline = [];
      if (car?.createdAt && !known.has("listing.create")) baseline.push({ id: "baseline-created", action: "listing.create", category: "listing", actor: { type: "user", uid: car.ownerId || "" }, target: { type: "listing", id: car.id }, summary: "Listing created", details: null, createdAt: car.createdAt });
      if (car?.publishedAt && !known.has("listing.publish")) baseline.push({ id: "baseline-published", action: "listing.publish", category: "listing", actor: { type: "user", uid: car.ownerId || "" }, target: { type: "listing", id: car.id }, summary: "Listing published", details: null, createdAt: car.publishedAt });
      res.json({ car: car && { id: car.id, title: [car.year, car.make, car.model].filter(Boolean).join(" "), status: car.status, kind: listingKind(car), kindLabel: LISTING_KIND_LABELS[listingKind(car)], moderationStatus: car.moderationStatus || "ok", moderationReason: car.moderationReason || "" }, history: [...timeline, ...baseline].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)) });
    } catch (error) { fail(res, error, "Unable to load this listing's history.", "Admin car history failed"); }
  });

  // ── User and dealer overviews ─────────────────────────────────────────────
  router.get("/users/:uid", requirePermission("users.read"), async (req, res) => {
    try {
      const snapshot = await database.collection("users").doc(req.params.uid).get();
      if (!snapshot.exists) return res.status(404).json({ error: "User not found." });
      const [carsSnap, enquiriesSnap, timeline] = await Promise.all([
        database.collection("cars").where("ownerId", "==", req.params.uid).get(),
        database.collection("enquiries").where("sellerId", "==", req.params.uid).get(),
        req.adminPermissions.has("activity.read") ? audit.timeline(req.params.uid) : [],
      ]);
      const cars = carsSnap.docs.map(serializeCar).sort((a, b) => (ms(b.updatedAt || b.createdAt) || 0) - (ms(a.updatedAt || a.createdAt) || 0));
      const enquiries = enquiriesSnap.docs.map(serializeEnquiry).sort((a, b) => (ms(b.createdAt) || 0) - (ms(a.createdAt) || 0));
      const removed = timeline.filter((e) => e.action === "listing.delete" && e.actor?.uid === req.params.uid).length;
      const data = snapshot.data();
      let lastSignIn = null;
      try { lastSignIn = (await admin.auth().getUser(req.params.uid)).metadata?.lastSignInTime || null; } catch { /* Auth record may be gone. */ }
      res.json({
        user: { ...serializeUser(snapshot), status: data.status || "active", adminVerified: data.adminVerified === true, lastSignIn, emailVerified: data.emailVerified === true, phoneVerified: data.phoneVerified === true, suspendedReason: data.suspendedReason || "" },
        subscription: { status: data.subscriptionStatus || "none", currentPeriodEnd: iso(data.subscriptionCurrentPeriodEnd), cancelAtPeriodEnd: data.subscriptionCancelAtPeriodEnd === true },
        cars: cars.map((c) => ({ ...c, kind: listingKind(c), kindLabel: LISTING_KIND_LABELS[listingKind(c)] })),
        enquiries,
        summary: { totalCars: cars.length, publishedCars: cars.filter((c) => c.status === "published").length, draftCars: cars.filter((c) => c.status === "draft").length, soldCars: cars.filter((c) => c.status === "sold").length, removedCars: removed, totalEnquiries: enquiries.length, openEnquiries: enquiries.filter((e) => e.status !== "closed").length },
        timeline,
      });
    } catch (error) { fail(res, error, "Unable to load this user.", "Admin user overview failed"); }
  });

  router.post("/users/:uid/status", requirePermission("users.manage"), async (req, res) => {
    const status = String(req.body?.status || "");
    const reason = String(req.body?.reason || "").trim().slice(0, 500);
    if (!["active", "suspended"].includes(status)) return res.status(400).json({ error: "Choose active or suspended." });
    if (status === "suspended" && reason.length < 5) return res.status(400).json({ error: "Give a reason of at least 5 characters." });
    if (status === "suspended" && String(req.get("x-confirm-action") || "").toLowerCase() !== "true") return res.status(428).json({ code: "CONFIRMATION_REQUIRED", error: "Confirm this action to continue." });
    const { uid } = req.params;
    if (uid === req.user.uid) return res.status(409).json({ error: "You can't suspend your own account." });
    try {
      const ref = database.collection("users").doc(uid);
      const snapshot = await ref.get();
      if (!snapshot.exists) return res.status(404).json({ error: "User not found." });
      const user = snapshot.data();
      if (user.role === "admin" || user.isAdmin === true) return res.status(409).json({ error: "Remove their admin access from Team first." });
      const suspended = status === "suspended";
      await ref.set({ status: suspended ? "suspended" : "active", disabled: suspended, suspendedReason: suspended ? reason : "", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      try {
        await admin.auth().updateUser(uid, { disabled: suspended });
        if (suspended) await admin.auth().revokeRefreshTokens(uid);
      } catch (authError) { logger.warn("Could not update the Auth account while changing status", authError); }
      const affected = await setOwnerSuspensionHide({ database, FieldValue, ownerField: "ownerId", ownerId: uid, actorUid: req.user.uid, hide: suspended });
      await record(req, { action: suspended ? "user.suspend" : "user.reactivate", category: "account", target: { type: "user", id: uid, label: user.email || uid }, summary: suspended ? `Suspended ${user.email || uid}` : `Reactivated ${user.email || uid}`, details: { reason, listingsAffected: affected } });
      res.json({ user: { ...serializeUser(await ref.get()), status: suspended ? "suspended" : "active" } });
    } catch (error) { fail(res, error, "Unable to change this account.", "Admin user status failed"); }
  });

  router.post("/users/:uid/verify", requirePermission("users.manage"), async (req, res) => {
    if (typeof req.body?.verified !== "boolean") return res.status(400).json({ error: "Verified must be true or false." });
    try {
      const ref = database.collection("users").doc(req.params.uid);
      const snapshot = await ref.get();
      if (!snapshot.exists) return res.status(404).json({ error: "User not found." });
      await ref.set({ adminVerified: req.body.verified, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await record(req, { action: req.body.verified ? "user.verify" : "user.unverify", category: "account", target: { type: "user", id: req.params.uid, label: snapshot.data().email || req.params.uid }, summary: req.body.verified ? "Marked an account as verified" : "Removed an account's verified mark" });
      res.json({ adminVerified: req.body.verified });
    } catch (error) { fail(res, error, "Unable to update this account.", "Admin user verify failed"); }
  });

  router.get("/dealers/:uid/overview", requirePermission("dealers.read"), async (req, res) => {
    try {
      const snapshot = await database.collection("dealers").doc(req.params.uid).get();
      if (!snapshot.exists) return res.status(404).json({ error: "Dealer not found." });
      const dealer = { id: snapshot.id, ...snapshot.data() };
      const tiers = await getEffectiveTiers(database);
      const [carsSnap, timeline, paymentsSnap] = await Promise.all([
        database.collection("cars").where("dealerId", "==", req.params.uid).get(),
        req.adminPermissions.has("activity.read") ? audit.timeline(req.params.uid) : [],
        req.adminPermissions.has("payments.read") ? database.collection("payments").where("accountId", "==", req.params.uid).get() : { docs: [] },
      ]);
      const cars = carsSnap.docs.map(serializeCar);
      const removed = timeline.filter((e) => e.action === "listing.delete" && e.actor?.uid === req.params.uid).length;
      const subscription = buildSubscriptions({ users: [], dealers: [dealer], cars, tiers, now: Date.now() })[0] || null;
      res.json({
        subscription,
        stats: { uploaded: cars.length + removed, live: cars.filter((c) => c.status === "active").length, drafts: cars.filter((c) => c.status === "draft").length, sold: cars.filter((c) => c.status === "sold").length, removed },
        payments: paymentsSnap.docs.map(serializePayment).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 12),
        timeline,
      });
    } catch (error) { fail(res, error, "Unable to load this dealer.", "Admin dealer overview failed"); }
  });

  // ── Exports ────────────────────────────────────────────────────────────────
  const exportGuards = Object.fromEntries(Object.entries(EXPORTS).map(([type, definition]) => [type, requirePermission(definition.permission)]));
  router.get("/export/:type", (req, res, next) => {
    const guards = exportGuards[req.params.type];
    if (!guards) return res.status(404).json({ error: "Unknown report." });
    return guards[0](req, res, (error) => (error ? next(error) : guards[1](req, res, next)));
  }, async (req, res) => {
    const type = req.params.type;
    try {
      const data = await loadSnapshot();
      const rows = await exportRows(type, data, req.query);
      await record(req, { action: "export.download", category: "export", target: { type: "report", id: type, label: `${type} report` }, summary: `Downloaded the ${type} report`, details: { rows: rows.length, filters: req.query } });
      res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="mintmotor-${type}-${new Date().toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store" });
      res.send(toCsv(EXPORTS[type].columns, rows));
    } catch (error) { fail(res, error, "Unable to build this report.", "Admin export failed"); }
  });

  async function exportRows(type, data, query) {
    const text = String(query.q || "").trim().toLowerCase();
    const has = (row, ...fields) => !text || fields.map((f) => row[f]).join(" ").toLowerCase().includes(text);
    if (type === "users") {
      const counts = new Map();
      for (const c of data.cars) counts.set(c.ownerId, (counts.get(c.ownerId) || 0) + 1);
      return data.users.filter((u) => (!query.role || u.role === query.role) && has(u, "email", "displayName", "phone")).map((u) => ({ ...u, createdAt: iso(u.createdAt), status: u.status || "active", listingCount: counts.get(u.id) || 0, subscriptionStatus: u.subscriptionStatus || "" }));
    }
    if (type === "dealers") {
      const subs = new Map(data.subscriptions.filter((s) => s.accountType === "dealer").map((s) => [s.accountId, s]));
      return data.dealers.filter((d) => (!query.status || d.dealerStatus === query.status) && has(d, "businessName", "email", "contactName")).map((d) => {
        const mine = data.cars.filter((c) => c.dealerId === d.id); const sub = subs.get(d.id);
        return { ...d, approvedAt: iso(d.approvedAt), planName: sub?.planName || "", subscriptionStatus: sub?.status || "none", periodEnd: sub?.periodEnd || "", liveLimit: sub?.liveLimit ?? "", liveCount: mine.filter((c) => c.status === "active").length, uploaded: mine.length, sold: mine.filter((c) => c.status === "sold").length };
      });
    }
    if (type === "listings") {
      const owners = new Map(data.users.map((u) => [u.id, u.email || u.displayName]).concat(data.dealers.map((d) => [d.id, d.businessName])));
      return data.cars.filter((c) => (!query.status || c.status === query.status) && (!query.kind || listingKind(c) === query.kind) && (!query.moderation || (c.moderationStatus || "ok") === query.moderation) && (!text || [c.make, c.model, c.registrationNumber, owners.get(c.ownerId)].join(" ").toLowerCase().includes(text)))
        .map((c) => ({ ...c, kindLabel: LISTING_KIND_LABELS[listingKind(c)], title: [c.year, c.make, c.model].filter(Boolean).join(" "), moderationStatus: c.moderationStatus || "ok", ownerLabel: owners.get(c.ownerId) || "", isFeatured: c.isFeatured === true ? "yes" : "no" }));
    }
    if (type === "subscriptions") return filterSubscriptions(data.subscriptions, query);
    if (type === "payments") return filterPayments(data.payments, query);
    return (await audit.list({ category: query.category, q: query.q, limit: 200, before: query.before })).entries;
  }

  // ── Announcements (admin side) ─────────────────────────────────────────────
  router.get("/announcement", requirePermission("announcements.manage"), async (_req, res) => {
    const snapshot = await database.collection(ANNOUNCEMENT.collection).doc(ANNOUNCEMENT.id).get();
    res.json({ announcement: snapshot.exists ? snapshot.data() : null });
  });

  router.put("/announcement", requirePermission("announcements.manage"), async (req, res) => {
    const body = req.body || {};
    const errors = [];
    const title = String(body.title || "").trim().slice(0, 80);
    const message = String(body.message || "").trim().slice(0, 300);
    if (body.enabled === true && !message) errors.push("Write the announcement message.");
    if (!TONES.includes(body.tone)) errors.push("Choose a style.");
    if (!AUDIENCES.includes(body.audience)) errors.push("Choose where to show it.");
    const linkUrl = String(body.linkUrl || "").trim();
    if (linkUrl && !/^(https:\/\/|\/)[^\s]*$/.test(linkUrl)) errors.push("The link must start with https:// or /.");
    const startsAtMs = body.startsAt ? Date.parse(body.startsAt) : null;
    const endsAtMs = body.endsAt ? Date.parse(body.endsAt) : null;
    if ((body.startsAt && Number.isNaN(startsAtMs)) || (body.endsAt && Number.isNaN(endsAtMs))) errors.push("Enter valid start and end times.");
    if (startsAtMs && endsAtMs && endsAtMs <= startsAtMs) errors.push("The end time must be after the start time.");
    if (errors.length) return res.status(400).json({ errors });
    try {
      const value = { enabled: body.enabled === true, title, message, tone: body.tone, audience: body.audience, linkUrl, linkLabel: String(body.linkLabel || "").trim().slice(0, 40), startsAtMs, endsAtMs, updatedBy: req.user.uid, updatedAtMs: Date.now() };
      await database.collection(ANNOUNCEMENT.collection).doc(ANNOUNCEMENT.id).set(value);
      await record(req, { action: value.enabled ? "announcement.publish" : "announcement.disable", category: "content", target: { type: "announcement", id: ANNOUNCEMENT.id, label: title || "Announcement" }, summary: value.enabled ? `Published an announcement for ${value.audience === "both" ? "both sites" : `the ${value.audience} site`}` : "Turned the announcement off", details: { title, audience: value.audience, tone: value.tone } });
      res.json({ announcement: value });
    } catch (error) { fail(res, error, "Unable to save the announcement.", "Admin announcement failed"); }
  });

  return router;
}

// Public pieces of the same feature set: the announcement banner and "report this listing".
function createPublicHooks({ database, FieldValue, logger, optionalAuth, requireDealer, isPublicMarketplaceCar, audit, crypto }) {
  const router = express.Router();
  router.use(express.json({ limit: "20kb" }));

  router.get("/announcements", async (req, res) => {
    try {
      const site = req.query.site === "dealer" ? "dealer" : "main";
      const snapshot = await database.collection(ANNOUNCEMENT.collection).doc(ANNOUNCEMENT.id).get();
      const value = snapshot.exists ? snapshot.data() : null;
      const now = Date.now();
      const live = value && value.enabled === true && (value.audience === "both" || value.audience === site) && (!value.startsAtMs || value.startsAtMs <= now) && (!value.endsAtMs || value.endsAtMs > now);
      res.set("Cache-Control", "public, max-age=60");
      res.json({ announcement: live ? { title: value.title, message: value.message, tone: value.tone, linkUrl: value.linkUrl || "", linkLabel: value.linkLabel || "" } : null });
    } catch (error) { logger.error("Announcement lookup failed", error); res.json({ announcement: null }); }
  });

  async function submit(req, res, { site, visible }) {
    try {
      const snapshot = await database.collection("cars").doc(req.params.id).get();
      const car = snapshot.exists ? snapshot.data() : null;
      if (!car || !visible(car)) return res.status(404).json({ error: "Listing not found." });
      const anonymousKey = `ip:${crypto.createHash("sha256").update(String(req.ip || req.get("x-forwarded-for") || "unknown")).digest("hex").slice(0, 16)}`;
      const reporter = req.user?.uid ? { key: `uid:${req.user.uid}`, uid: req.user.uid, email: req.user.email || "" } : { key: anonymousKey };
      if (car.ownerId && car.ownerId === reporter.uid) return res.status(409).json({ error: "You can't report your own listing." });
      const result = await createReport({ database, FieldValue, carId: req.params.id, car, reporter, body: req.body, site });
      if (result.errors) return res.status(400).json({ errors: result.errors });
      if (result.duplicate) return res.status(409).json({ error: "You've already reported this listing. We're looking into it." });
      if (result.rateLimited) return res.status(429).json({ error: "You've sent several reports recently. Please try again later." });
      await audit.record({ action: "complaint.create", category: "complaint", actor: reporter.uid ? { type: site === "dealer" ? "dealer" : "user", uid: reporter.uid, email: reporter.email } : { type: "system" }, target: { type: "listing", id: req.params.id, label: [car.year, car.make, car.model].filter(Boolean).join(" ") }, summary: "A listing was reported", details: { reason: req.body?.reason } });
      res.status(201).json({ ok: true });
    } catch (error) { logger.error("Listing report failed", error); res.status(500).json({ error: "Unable to send your report." }); }
  }

  router.post("/cars/:id/report", optionalAuth, (req, res) => submit(req, res, { site: "main", visible: (car) => isPublicMarketplaceCar(car) }));
  router.post("/dealer/network/cars/:id/report", requireDealer, (req, res) => submit(req, res, { site: "dealer", visible: (car) => car.visibility === "dealer-network" && car.status === "published" && !isModeratedOut(car) }));
  return router;
}

module.exports = { createAdminRouter, createPublicHooks, ANNOUNCEMENT };
