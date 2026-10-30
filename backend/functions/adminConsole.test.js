const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const proxyquire = require("proxyquire");
const { createTestDb } = require("./testDb");
const { invalidateTierCache } = require("./dealerTiers");

const NOW = Date.now();
const DAY = 86_400_000;
const ownerPhone = "+447700900000";

function setup(extra = {}) {
  invalidateTierCache();
  const db = createTestDb({
    adminTeam: { sup: { role: "support", active: true, email: "sup@x.test" }, fin: { role: "finance", active: true, email: "fin@x.test" }, con: { role: "content", active: true, email: "con@x.test" }, boss: { role: "owner", active: true, email: "boss@x.test" } },
    users: {
      seller: { email: "seller@x.test", displayName: "Sam Seller", role: "user", createdAt: new Date(NOW - 2 * DAY), subscriptionStatus: "active", subscriptionCurrentPeriodEnd: new Date(NOW + 20 * DAY) },
      other: { email: "other@x.test", role: "user", createdAt: new Date(NOW - 40 * DAY) },
      boss: { email: "boss@x.test", role: "admin", isAdmin: true },
    },
    dealers: {
      dealer: { businessName: "Mint Cars", email: "dealer@x.test", dealerStatus: "approved", authUid: "dealer", dealerTierKey: "starter", dealerSubscriptionStatus: "active", dealerSubscriptionCurrentPeriodEnd: new Date(NOW + 9 * DAY), dealerActiveListingLimit: 10, dealerFeaturedListingLimit: 2 },
    },
    storageDealerStatus: { dealer: { dealerStatus: "approved" } },
    cars: {
      pub: { ownerId: "seller", sellerType: "private", listingPlan: "public-subscription", visibility: "public", status: "published", make: "Ford", model: "Focus", year: 2020, price: 9000, createdAt: new Date(NOW - DAY), images: [] },
      free: { ownerId: "seller", sellerType: "private", listingPlan: "dealer-network-free", visibility: "dealer-network", status: "published", make: "Audi", model: "A3", year: 2019, price: 12000, createdAt: new Date(NOW - 2 * DAY), images: [], sellerPostcode: "SW1A 1AA" },
      stock: { ownerId: "dealer", dealerId: "dealer", sellerType: "dealer", ownerType: "dealer", visibility: "public", status: "active", make: "BMW", model: "320d", year: 2021, price: 20000, createdAt: new Date(NOW - 3 * DAY), images: [] },
    },
    payments: { in_1: { status: "paid", accountType: "dealer", accountId: "dealer", accountLabel: "Mint Cars", amountPaidPence: 9900, amountRefundedPence: 0, invoiceCreatedMs: NOW - DAY, invoiceNumber: "MM-1", tierKey: "starter" }, in_2: { status: "failed", accountType: "seller", accountId: "seller", accountLabel: "seller@x.test", amountPaidPence: 0, invoiceCreatedMs: NOW - 2 * DAY, failureReason: "Card declined" } },
    ...extra,
  });
  const people = {
    boss: { uid: "boss", email: "boss@x.test", role: "admin" },
    sup: { uid: "sup", email: "sup@x.test", role: "admin" },
    fin: { uid: "fin", email: "fin@x.test", role: "admin" },
    con: { uid: "con", email: "con@x.test", role: "admin" },
    seller: { uid: "seller", email: "seller@x.test", email_verified: true, phone_number: ownerPhone },
    other: { uid: "other", email: "other@x.test" },
    dealer: { uid: "dealer", role: "dealer", email: "dealer@x.test", email_verified: true },
  };
  const claims = {};
  const authCalls = [];
  const admin = { auth: () => ({
    async verifyIdToken(token) { if (!people[token]) throw new Error("bad token"); return people[token]; },
    async getUserByEmail(email) { const hit = Object.values(people).find((p) => p.email === email); if (!hit) throw Object.assign(new Error("none"), { code: "auth/user-not-found" }); return { uid: hit.uid, email, customClaims: hit.role === "dealer" ? { role: "dealer" } : {} }; },
    async getUser(uid) { return { uid, customClaims: claims[uid] || {}, metadata: { lastSignInTime: "2026-10-30T10:00:00Z" } }; },
    async setCustomUserClaims(uid, value) { claims[uid] = value; authCalls.push(["claims", uid, value]); },
    async updateUser(uid, value) { authCalls.push(["update", uid, value]); },
    async revokeRefreshTokens(uid) { authCalls.push(["revoke", uid]); },
  }) };
  const { mintapi: app } = proxyquire("./index", {
    "./firebase": { admin, database: db, storage: {}, storageStatusDatabase: db },
    "./vehiclePublish": { refreshVehicleDataForPublish: async () => ({ vehicleHistory: null, vehicleHistoryVerified: false }) },
    "./vehicleLookup": { lookupVehicle: async () => ({}) },
    stripe: class FakeStripe { constructor() { this.webhooks = { constructEvent: (body) => JSON.parse(body.toString()) }; this.subscriptions = { retrieve: async (id) => ({ id, status: "past_due", customer: "cus_d", metadata: { firebaseUid: "dealer", dealerTierKey: "starter" }, items: { data: [{ current_period_end: Math.floor((NOW + 5 * DAY) / 1000) }] } }) }; } },
    "firebase-functions/v2/https": { onRequest: (_options, handler) => handler },
    "firebase-functions/v2/scheduler": { onSchedule: () => () => {} },
  });
  const as = (token) => ({
    get: (path) => request(app).get(path).set("Authorization", `Bearer ${token}`),
    post: (path, body = {}, headers = {}) => request(app).post(path).set("Authorization", `Bearer ${token}`).set(headers).send(body),
    patch: (path, body = {}, headers = {}) => request(app).patch(path).set("Authorization", `Bearer ${token}`).set(headers).send(body),
    put: (path, body = {}, headers = {}) => request(app).put(path).set("Authorization", `Bearer ${token}`).set(headers).send(body),
    delete: (path, headers = {}) => request(app).delete(path).set("Authorization", `Bearer ${token}`).set(headers),
  });
  const confirm = { "X-Confirm-Action": "true" };
  const entries = () => Object.values(db.rows("auditLog")).sort((a, b) => a.createdAtMs - b.createdAtMs);
  return { app, db, as, confirm, entries, authCalls, claims };
}

test("dashboard figures come from the real records, and finance can't see what only support should", async () => {
  const { as } = setup();
  const res = await as("boss").get("/admin/stats?days=30");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { kpis } = res.body;
  assert.deepEqual([kpis.users.total, kpis.dealers.approved, kpis.listings.total, kpis.listings.live], [2, 1, 3, 3]);
  assert.deepEqual(kpis.listings.byKind, { regular: 1, freeDealerOnly: 1, dealerPaid: 1 });
  assert.equal(kpis.revenue.totalPence, 9900);
  assert.equal(kpis.subscriptions.activeDealer, 1);
  assert.ok(res.body.alerts.some((a) => a.id === "failed-payments"));
  assert.equal(res.body.series.length, 30);
  assert.equal((await as("fin").get("/admin/stats")).status, 200);
  assert.equal((await as("seller").get("/admin/stats")).status, 403);
  assert.equal((await as("dealer").get("/admin/stats")).status, 403);
});

test("roles limit sections: support can't read payments or manage the team; finance can't moderate", async () => {
  const { as, confirm } = setup();
  assert.equal((await as("sup").get("/admin/payments")).status, 403);
  assert.equal((await as("sup").get("/admin/team")).status, 403);
  assert.equal((await as("fin").get("/admin/payments")).status, 200);
  assert.equal((await as("fin").post("/admin/cars/pub/moderate", { action: "hide", reason: "spam listing" }, confirm)).status, 403);
  assert.equal((await as("con").get("/admin/activity")).status, 403);
  assert.equal((await as("sup").patch("/admin/users/other", { role: "admin" })).status, 403);
});

test("hiding a listing removes it from the main site, search, dealer network and images, and is audited", async () => {
  const { app, db, confirm } = setup();
  const sup = (path, body, headers) => request(app).post(path).set("Authorization", "Bearer sup").set(headers || {}).send(body);
  assert.equal((await request(app).get("/cars/pub")).status, 200);
  assert.equal((await request(app).get("/cars")).body.cars.length, 2);
  assert.equal((await sup("/admin/cars/pub/moderate", { action: "hide" }, confirm)).status, 400);
  assert.equal((await sup("/admin/cars/pub/moderate", { action: "hide", reason: "Looks like a scam" })).status, 428);
  const hidden = await sup("/admin/cars/pub/moderate", { action: "hide", reason: "Looks like a scam" }, confirm);
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  assert.equal(hidden.body.car.moderationStatus, "hidden");
  assert.equal((await request(app).get("/cars/pub")).status, 404);
  assert.deepEqual((await request(app).get("/cars")).body.cars.map((c) => c.id), ["stock"]);
  const owner = await request(app).get("/cars/pub").set("Authorization", "Bearer seller");
  assert.equal(owner.status, 200);
  const hideFree = await sup("/admin/cars/free/moderate", { action: "reject", reason: "Fake vehicle details" }, confirm);
  assert.equal(hideFree.status, 200);
  assert.equal((await request(app).get("/dealer/network/cars").set("Authorization", "Bearer dealer")).body.cars.length, 0);
  assert.equal((await request(app).get("/dealer/network/cars/free").set("Authorization", "Bearer dealer")).status, 404);
  const rejectedPublish = await request(app).post("/cars/free/publish").set("Authorization", "Bearer seller").send({});
  assert.equal(rejectedPublish.status, 403);
  assert.match(rejectedPublish.body.error, /rejected/i);
  assert.equal((await sup("/admin/cars/pub/moderate", { action: "restore" })).status, 200);
  assert.equal((await request(app).get("/cars/pub")).status, 200);
  const log = Object.values(db.rows("auditLog")).filter((e) => e.category === "moderation").map((e) => e.action);
  assert.deepEqual(log, ["listing.hide", "listing.reject", "listing.restore"]);
});

test("seller and dealer listing actions are recorded and show up in the listing and user timelines", async () => {
  const { app, as } = setup();
  const created = await request(app).post("/cars").set("Authorization", "Bearer seller").send({ make: "Kia", model: "Ceed", listingPlan: "dealer-network-free" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.car.id;
  await request(app).patch(`/cars/${id}`).set("Authorization", "Bearer seller").send({ price: 5000 });
  await request(app).delete(`/cars/${id}`).set("Authorization", "Bearer seller");
  const history = await as("sup").get(`/admin/cars/${id}/history`);
  assert.equal(history.status, 200, JSON.stringify(history.body));
  assert.deepEqual(history.body.history.map((h) => h.action).reverse(), ["listing.create", "listing.update", "listing.delete"]);
  assert.equal(history.body.history[0].actor.uid, "seller");
  const overview = await as("sup").get("/admin/users/seller");
  assert.equal(overview.status, 200);
  assert.equal(overview.body.summary.removedCars, 1);
  assert.ok(overview.body.timeline.some((e) => e.action === "listing.create"));
  assert.deepEqual(overview.body.cars.map((c) => c.kindLabel).sort(), ["Free dealer-only listing", "Regular user listing"]);
  assert.equal(overview.body.subscription.status, "active");
  const baseline = await as("sup").get("/admin/cars/stock/history");
  assert.equal(baseline.body.history[0].summary, "Listing created");
  assert.equal(baseline.body.car.kindLabel, "Paid dealer listing");
  assert.equal((await as("sup").get("/admin/cars/missing/history")).status, 404);
});

test("admin edits are audited with before and after, and critical deletes need confirmation", async () => {
  const { as, confirm, entries, db } = setup();
  const edit = await as("sup").patch("/admin/cars/pub", { adminNote: "Checked photos" });
  assert.equal(edit.status, 200);
  const featured = await as("sup").patch("/admin/cars/pub", { isFeatured: true });
  assert.equal(featured.status, 403, "support can't feature");
  assert.equal((await as("con").patch("/admin/cars/pub", { isFeatured: true })).status, 403, "content role can't edit listings");
  assert.equal((await as("boss").patch("/admin/cars/pub", { isFeatured: true })).status, 200);
  assert.equal((await as("boss").delete("/admin/cars/pub")).status, 428);
  assert.equal((await as("sup").delete("/admin/cars/pub", confirm)).status, 403);
  assert.equal((await as("boss").delete("/admin/cars/pub", confirm)).status, 204);
  assert.equal(db.rows("cars").pub, undefined);
  assert.deepEqual(entries().map((e) => e.action), ["listing.admin_update", "listing.feature", "listing.delete"]);
  assert.equal(entries()[0].actor.role, "support");
  assert.deepEqual(entries()[0].details.after, { adminNote: "Checked photos" });
});

test("suspending a user blocks changes, hides their cars and disables sign-in; reactivating restores them", async () => {
  const { app, as, confirm, authCalls } = setup();
  assert.equal((await as("sup").post("/admin/users/seller/status", { status: "suspended", reason: "Fraud reports" })).status, 428);
  assert.equal((await as("sup").post("/admin/users/seller/status", { status: "suspended", reason: "no" }, confirm)).status, 400);
  assert.equal((await as("boss").post("/admin/users/boss/status", { status: "suspended", reason: "Testing self" }, confirm)).status, 409);
  const suspended = await as("sup").post("/admin/users/seller/status", { status: "suspended", reason: "Fraud reports" }, confirm);
  assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
  assert.deepEqual(authCalls.filter((c) => c[1] === "seller").map((c) => c[0]), ["update", "revoke"]);
  assert.equal((await request(app).get("/cars/pub")).status, 404);
  const blocked = await request(app).patch("/cars/pub").set("Authorization", "Bearer seller").send({ price: 1 });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, "ACCOUNT_SUSPENDED");
  assert.equal((await as("sup").post("/admin/users/seller/status", { status: "active" })).status, 200);
  assert.equal((await request(app).get("/cars/pub")).status, 200);
  assert.equal((await as("sup").post("/admin/users/boss/status", { status: "suspended", reason: "Not allowed" }, confirm)).status, 409);
  assert.equal((await as("sup").post("/admin/users/seller/verify", { verified: true })).body.adminVerified, true);
});

test("team: owners add and change members; the last owner and your own access are protected; dealers can't be admins", async () => {
  const { as, confirm, claims } = setup();
  assert.equal((await as("boss").post("/admin/team", { email: "other@x.test", role: "support" })).status, 428);
  assert.equal((await as("boss").post("/admin/team", { email: "nobody@x.test", role: "support" }, confirm)).status, 404);
  assert.equal((await as("boss").post("/admin/team", { email: "dealer@x.test", role: "support" }, confirm)).status, 409);
  assert.equal((await as("boss").post("/admin/team", { email: "other@x.test", role: "wizard" }, confirm)).status, 400);
  const added = await as("boss").post("/admin/team", { email: "other@x.test", role: "finance" }, confirm);
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.deepEqual([claims.other.admin, claims.other.adminRole, claims.other.role], [true, "finance", "admin"]);
  const list = await as("boss").get("/admin/team");
  assert.ok(list.body.members.some((m) => m.uid === "other" && m.role === "finance"));
  assert.equal((await as("boss").patch("/admin/team/boss", { role: "support" }, confirm)).status, 409);
  assert.equal((await as("boss").patch("/admin/team/boss", { active: false }, confirm)).status, 409);
  assert.equal((await as("boss").patch("/admin/team/other", { role: "content" }, confirm)).status, 200);
  assert.equal(claims.other.adminRole, "content");
  assert.equal((await as("boss").patch("/admin/team/other", { active: false }, confirm)).status, 200);
  assert.equal(claims.other.admin, undefined);
});

test("plans: admins change limits (applied to subscribed dealers), hide plans, and public plans follow", async () => {
  const { app, as, confirm, db } = setup();
  const before = await as("boss").get("/admin/plans");
  const starter = before.body.plans.find((p) => p.key === "starter");
  assert.deepEqual([starter.activeLimit, starter.subscribers, starter.offered], [10, 1, true]);
  assert.equal((await as("boss").put("/admin/plans/starter", { activeLimit: 12 })).status, 428);
  assert.equal((await as("sup").put("/admin/plans/starter", { activeLimit: 12 }, confirm)).status, 403);
  assert.equal((await as("boss").put("/admin/plans/starter", { activeLimit: 1, featuredLimit: 5 }, confirm)).status, 400);
  const saved = await as("boss").put("/admin/plans/starter", { activeLimit: 12, featuredLimit: 3, name: "Launch" }, confirm);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.dealersUpdated, 1);
  assert.deepEqual([db.rows("dealers").dealer.dealerActiveListingLimit, db.rows("dealers").dealer.dealerFeaturedListingLimit], [12, 3]);
  await as("boss").put("/admin/plans/pro", { offered: false }, confirm);
  const publicPlans = (await request(app).get("/dealer-plans")).body.tiers;
  assert.equal(publicPlans.find((t) => t.key === "starter").name, "Launch");
  assert.ok(!publicPlans.some((t) => t.key === "pro"));
  const priceChange = await as("boss").put("/admin/plans/growth", { monthlyPricePence: 18000, priceId: "price_abc123456" }, confirm);
  assert.ok([400, 503].includes(priceChange.status), "an unverifiable price is never saved");
  const log = Object.values(db.rows("auditLog")).filter((e) => e.action === "plan.update");
  assert.equal(log.length, 2);
  assert.deepEqual(log[0].details.before, { activeLimit: 10, featuredLimit: 2, name: "Starter" });
});

test("complaints: anyone can report a public listing once, dealers can report dealer-only cars, admins review them", async () => {
  const { app, as } = setup();
  assert.equal((await request(app).post("/cars/pub/report").send({ reason: "scam", message: "Photos look stolen" })).status, 201);
  assert.equal((await request(app).post("/cars/pub/report").send({ reason: "scam" })).status, 409);
  assert.equal((await request(app).post("/cars/pub/report").send({ reason: "bogus" })).status, 400);
  assert.equal((await request(app).post("/cars/free/report").send({ reason: "scam" })).status, 404, "dealer-only cars aren't reportable by the public");
  assert.equal((await request(app).post("/cars/pub/report").set("Authorization", "Bearer seller").send({ reason: "scam" })).status, 409, "own listing");
  assert.equal((await request(app).post("/dealer/network/cars/free/report").set("Authorization", "Bearer dealer").send({ reason: "wrong_info", message: "Mileage is wrong" })).status, 201);
  assert.equal((await request(app).post("/dealer/network/cars/free/report").send({ reason: "scam" })).status, 401);
  const list = await as("sup").get("/admin/complaints?status=open");
  assert.equal(list.body.total, 2);
  assert.deepEqual(list.body.counts, { open: 2, reviewing: 0, resolved: 0, dismissed: 0 });
  const id = list.body.complaints.find((c) => c.site === "main").id;
  assert.equal((await as("sup").patch(`/admin/complaints/${id}`, { status: "resolved" })).status, 400);
  const done = await as("sup").patch(`/admin/complaints/${id}`, { status: "resolved", note: "Hidden the listing" });
  assert.equal(done.status, 200);
  assert.equal((await as("sup").get("/admin/complaints?status=open")).body.total, 1);
  assert.equal((await as("fin").get("/admin/complaints")).status, 403);
});

test("announcements are validated, audited and shown only on the chosen site while live", async () => {
  const { app, as } = setup();
  assert.equal((await request(app).get("/announcements?site=main")).body.announcement, null);
  assert.equal((await as("con").put("/admin/announcement", { enabled: true, message: "", tone: "info", audience: "main" })).status, 400);
  assert.equal((await as("con").put("/admin/announcement", { enabled: true, message: "Hi", tone: "info", audience: "main", linkUrl: "javascript:alert(1)" })).status, 400);
  assert.equal((await as("sup").put("/admin/announcement", { enabled: true, message: "Hi", tone: "info", audience: "main" })).status, 403);
  const ok = await as("con").put("/admin/announcement", { enabled: true, title: "Maintenance", message: "Short downtime tonight", tone: "warning", audience: "dealer", linkUrl: "/how-it-works", linkLabel: "Details" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await request(app).get("/announcements?site=main")).body.announcement, null);
  assert.equal((await request(app).get("/announcements?site=dealer")).body.announcement.message, "Short downtime tonight");
  await as("con").put("/admin/announcement", { enabled: true, message: "Later", tone: "info", audience: "both", startsAt: new Date(Date.now() + DAY).toISOString() });
  assert.equal((await request(app).get("/announcements?site=main")).body.announcement, null, "not started yet");
});

test("CSV exports respect permissions and filters, protect against formulas, and are themselves audited", async () => {
  const { as, entries } = setup({ users: { seller: { email: "=cmd|x@x.test", displayName: "Sam", role: "user", createdAt: new Date(NOW) } } });
  const users = await as("sup").get("/admin/export/users");
  assert.equal(users.status, 200);
  assert.match(users.headers["content-type"], /text\/csv/);
  assert.match(users.headers["content-disposition"], /mintmotor-users-\d{4}-\d{2}-\d{2}\.csv/);
  assert.ok(users.text.includes("'=cmd|x@x.test"));
  assert.equal((await as("sup").get("/admin/export/payments")).status, 403);
  const payments = await as("fin").get("/admin/export/payments?status=failed");
  assert.equal(payments.status, 200);
  assert.ok(payments.text.includes("Card declined") && !payments.text.includes("MM-1"));
  const listings = await as("sup").get("/admin/export/listings?kind=free-dealer-only");
  assert.ok(listings.text.includes("Free dealer-only listing") && !listings.text.includes("Paid dealer listing"));
  assert.equal((await as("sup").get("/admin/export/nonsense")).status, 404);
  assert.equal((await as("seller").get("/admin/export/users")).status, 403);
  assert.ok(entries().filter((e) => e.action === "export.download").length >= 3);
});

test("subscriptions and payments lists filter and summarise real records", async () => {
  const { as } = setup();
  const subs = await as("fin").get("/admin/subscriptions");
  assert.equal(subs.status, 200);
  assert.deepEqual(subs.body.subscriptions.map((s) => s.id).sort(), ["dealer:dealer", "seller:seller"]);
  assert.equal(subs.body.counts.active, 2);
  assert.deepEqual((await as("fin").get("/admin/subscriptions?accountType=dealer")).body.subscriptions.map((s) => s.label), ["Mint Cars"]);
  const payments = await as("fin").get("/admin/payments");
  assert.deepEqual(payments.body.summary, { collectedPence: 9900, refundedPence: 0, failedCount: 1, invoiceCount: 2 });
  assert.deepEqual((await as("fin").get("/admin/payments?status=failed")).body.payments.map((p) => p.failureReason), ["Card declined"]);
  assert.equal((await as("sup").get("/admin/subscriptions")).status, 403);
});

test("activity log is searchable and dealer overview shows stock, plan and payments", async () => {
  const { as, app } = setup();
  await request(app).post("/cars").set("Authorization", "Bearer seller").send({ make: "Kia", model: "Ceed" });
  const feed = await as("sup").get("/admin/activity?category=listing&limit=5");
  assert.equal(feed.status, 200);
  assert.equal(feed.body.entries[0].action, "listing.create");
  assert.equal((await as("sup").get("/admin/activity?q=nothing-matches")).body.entries.length, 0);
  assert.equal((await as("fin").get("/admin/activity")).status, 403);
  const overview = await as("sup").get("/admin/dealers/dealer/overview");
  assert.equal(overview.status, 200);
  assert.deepEqual([overview.body.stats.uploaded, overview.body.stats.live], [1, 1]);
  assert.equal(overview.body.subscription.planName, "Starter");
  assert.equal(overview.body.payments.length, 0, "support can't see payments");
  assert.equal((await as("boss").get("/admin/dealers/dealer/overview")).body.payments.length, 1);
  assert.equal((await as("sup").get("/admin/dealers/nope/overview")).status, 404);
});

test("Stripe invoice events become payments once, and subscription changes are audited", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_x"; process.env.STRIPE_WEBHOOK_SECRET = "whsec_x";
  try {
    const { app, as, db, entries } = setup();
    const send = (event) => request(app).post("/billing/webhook").set("Content-Type", "application/json").set("stripe-signature", "t").send(JSON.stringify(event));
    const invoice = (over = {}) => ({ id: "in_new", number: "MM-77", status: "paid", customer: "cus_d", currency: "gbp", amount_paid: 17000, amount_due: 17000, created: Math.floor(NOW / 1000), subscription_details: { metadata: { firebaseUid: "dealer", dealerTierKey: "growth" } }, lines: { data: [{ description: "Growth", period: { start: 1, end: 2 } }] }, ...over });
    assert.equal((await send({ type: "invoice.payment_failed", data: { object: invoice({ status: "open", amount_paid: 0 }) } })).status, 200);
    assert.equal(db.rows("payments").in_new.status, "failed");
    assert.equal((await send({ type: "invoice.paid", data: { object: invoice() } })).status, 200);
    assert.equal((await send({ type: "invoice.paid", data: { object: invoice() } })).status, 200);
    assert.equal(db.rows("payments").in_new.status, "paid");
    assert.equal(Object.keys(db.rows("payments")).filter((id) => id === "in_new").length, 1);
    assert.equal((await as("fin").get("/admin/payments?q=MM-77")).body.payments.length, 1);
    assert.equal((await send({ type: "charge.refunded", data: { object: { invoice: "in_new", amount: 17000, amount_refunded: 17000 } } })).status, 200);
    assert.equal(db.rows("payments").in_new.status, "refunded");
    assert.equal((await send({ type: "customer.subscription.updated", data: { object: { id: "sub_1", status: "past_due", customer: "cus_d", metadata: { firebaseUid: "dealer", dealerTierKey: "starter" }, items: { data: [] } } } })).status, 200);
    const actions = entries().map((e) => e.action);
    assert.ok(actions.includes("payment.failed") && actions.includes("payment.received") && actions.includes("subscription.update"), actions.join());
    const change = entries().find((e) => e.action === "subscription.update");
    assert.deepEqual(change.details.before.status, "active");
    assert.equal(change.details.after.status, "past_due");
  } finally { delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET; }
});

test("the console can ask who the admin is and what they may do", async () => {
  const { as } = setup();
  const boss = (await as("boss").get("/admin/me")).body;
  assert.deepEqual([boss.role, boss.roleLabel], ["owner", "Owner"]);
  assert.ok(boss.permissions.includes("team.manage"));
  const fin = (await as("fin").get("/admin/me")).body;
  assert.ok(fin.permissions.includes("payments.read") && !fin.permissions.includes("listings.moderate"));
  assert.equal((await as("seller").get("/admin/me")).status, 403);
});

test("the listings list says which kind each car is, and filters by kind, owner, moderation, price and date", async () => {
  const { as, confirm } = setup();
  const all = await as("sup").get("/admin/cars");
  assert.equal(all.status, 200);
  const byId = Object.fromEntries(all.body.cars.map((c) => [c.id, c]));
  assert.deepEqual([byId.pub.kindLabel, byId.free.kindLabel, byId.stock.kindLabel], ["Regular user listing", "Free dealer-only listing", "Paid dealer listing"]);
  assert.equal(byId.stock.ownerLabel, "Mint Cars");
  const ids = async (q) => (await as("sup").get("/admin/cars" + q)).body.cars.map((c) => c.id).sort();
  assert.deepEqual(await ids("?kind=free-dealer-only"), ["free"]);
  assert.deepEqual(await ids("?owner=dealer"), ["stock"]);
  assert.deepEqual(await ids("?owner=seller"), ["free", "pub"]);
  assert.deepEqual(await ids("?minPrice=10000&maxPrice=15000"), ["free"]);
  assert.deepEqual(await ids("?q=mint%20cars"), ["stock"]);
  assert.deepEqual(await ids("?from=" + new Date(NOW - 1.5 * DAY).toISOString().slice(0, 10)), ["pub"]);
  await as("sup").post("/admin/cars/pub/moderate", { action: "hide", reason: "Spam content" }, confirm);
  assert.deepEqual(await ids("?moderation=hidden"), ["pub"]);
  assert.deepEqual(await ids("?moderation=ok"), ["free", "stock"]);
  assert.equal((await as("fin").get("/admin/cars")).status, 403);
});
