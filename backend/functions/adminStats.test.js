const test = require("node:test");
const assert = require("node:assert/strict");
const { listingKind, subscriptionState, buildSubscriptions, filterSubscriptions, buildStats, ms } = require("./adminStats");

const NOW = Date.parse("2026-10-31T12:00:00Z");
const DAY = 86_400_000;
const iso = (offsetDays) => new Date(NOW + offsetDays * DAY).toISOString();
const tiers = { starter: { name: "Starter", monthlyPricePence: 9900, activeLimit: 10 }, growth: { name: "Growth", monthlyPricePence: 17000, activeLimit: 17 } };

test("classifies listings as regular, paid dealer or free dealer-only", () => {
  assert.equal(listingKind({ sellerType: "private", listingPlan: "public-subscription", visibility: "public" }), "regular");
  assert.equal(listingKind({ sellerType: "private", listingPlan: "dealer-network-free", visibility: "dealer-network" }), "free-dealer-only");
  assert.equal(listingKind({ sellerType: "dealer", dealerId: "d1" }), "dealer-paid");
  assert.equal(listingKind({ ownerType: "dealer" }), "dealer-paid");
  assert.equal(listingKind({}), "regular");
});

test("understands Firestore timestamps, dates, ISO strings and numbers", () => {
  assert.equal(ms({ toMillis: () => 5 }), 5);
  assert.equal(ms(new Date(7)), 7);
  assert.equal(ms("1970-01-01T00:00:00.010Z"), 10);
  assert.equal(ms({ _seconds: 2 }), 2000);
  assert.equal(ms(null), null);
  assert.equal(ms("nonsense"), null);
});

test("derives subscription states, treating an elapsed period as expired", () => {
  const state = (status, offset, extra = {}) => subscriptionState({ status, periodEndMs: NOW + offset * DAY, ...extra }, NOW);
  assert.equal(state("active", 10), "active");
  assert.equal(state("trialing", 10), "active");
  assert.equal(state("active", -1), "expired");
  assert.equal(state("past_due", 3), "past_due");
  assert.equal(state("unpaid", 3), "past_due");
  assert.equal(state("canceled", -5), "cancelled");
  assert.equal(state("incomplete", 1), "pending");
  assert.equal(subscriptionState({ status: "none" }, NOW), null);
  assert.equal(subscriptionState({}, NOW), null);
});

const dealers = [
  { id: "d1", businessName: "Mint Cars", email: "d1@x.test", dealerStatus: "approved", dealerSubscriptionStatus: "active", dealerTierKey: "starter", dealerSubscriptionCurrentPeriodEnd: iso(2), dealerActiveListingLimit: 10, dealerSubscriptionCancelAtPeriodEnd: true },
  { id: "d2", businessName: "Old Motors", dealerStatus: "approved", dealerSubscriptionStatus: "past_due", dealerTierKey: "growth", dealerSubscriptionCurrentPeriodEnd: iso(5), activationEmailLastError: "bounce" },
  { id: "d3", businessName: "No Plan", dealerStatus: "suspended" },
];
const users = [
  { id: "u1", email: "u1@x.test", role: "user", createdAt: iso(-2), subscriptionStatus: "active", subscriptionCurrentPeriodEnd: iso(4), subscriptionCancelAtPeriodEnd: true },
  { id: "u2", email: "u2@x.test", role: "user", createdAt: iso(-40) },
  { id: "a1", email: "admin@x.test", role: "admin", createdAt: iso(-1) },
  { id: "dl", email: "dealer@x.test", role: "dealer", createdAt: iso(-1) },
];
const cars = [
  { id: "c1", status: "published", sellerType: "private", listingPlan: "public-subscription", createdAt: iso(-1) },
  { id: "c2", status: "published", sellerType: "private", listingPlan: "dealer-network-free", createdAt: iso(-3) },
  { id: "c3", status: "active", sellerType: "dealer", dealerId: "d1", createdAt: iso(-50) },
  { id: "c4", status: "draft", sellerType: "dealer", dealerId: "d1", createdAt: iso(-1) },
  { id: "c5", status: "sold", sellerType: "private", createdAt: iso(-2), moderationStatus: "hidden" },
];
const payments = [
  { id: "p1", status: "paid", amountPaidPence: 9900, amountRefundedPence: 0, createdAt: iso(-1) },
  { id: "p2", status: "refunded", amountPaidPence: 9900, amountRefundedPence: 9900, createdAt: iso(-2) },
  { id: "p3", status: "failed", amountPaidPence: 0, amountRefundedPence: 0, createdAt: iso(-3) },
  { id: "p4", status: "paid", amountPaidPence: 17000, amountRefundedPence: 0, createdAt: iso(-60) },
];

test("builds subscription rows for dealers and sellers with live usage and sorted by expiry", () => {
  const rows = buildSubscriptions({ users, dealers, cars, tiers, now: NOW });
  assert.deepEqual(rows.map((r) => [r.id, r.status]), [["dealer:d1", "active"], ["seller:u1", "active"], ["dealer:d2", "past_due"]]);
  const d1 = rows[0];
  assert.deepEqual([d1.planName, d1.liveCount, d1.liveLimit, d1.monthlyPricePence], ["Starter", 1, 10, 9900]);
  assert.equal(rows[1].cancelAtPeriodEnd, true);
  assert.deepEqual(filterSubscriptions(rows, { status: "past_due" }).map((r) => r.id), ["dealer:d2"]);
  assert.deepEqual(filterSubscriptions(rows, { accountType: "seller" }).map((r) => r.id), ["seller:u1"]);
  assert.deepEqual(filterSubscriptions(rows, { q: "mint" }).map((r) => r.id), ["dealer:d1"]);
});

test("dashboard figures count real records and exclude staff and dealers from user totals", () => {
  const subscriptions = buildSubscriptions({ users, dealers, cars, tiers, now: NOW });
  const stats = buildStats({ cars, users, dealers, applications: [{ id: "a", status: "submitted", createdAt: iso(-5) }, { id: "b", status: "approved" }], enquiries: [{ status: "new" }, { status: "closed" }], payments, reports: [{ status: "open" }, { status: "resolved" }], subscriptions, now: NOW, days: 30 });
  const { kpis } = stats;
  assert.deepEqual(kpis.users, { total: 2, newInRange: 1 });
  assert.deepEqual(kpis.dealers, { total: 3, approved: 2, suspended: 1, applicationsPending: 1 });
  assert.deepEqual([kpis.listings.total, kpis.listings.live, kpis.listings.drafts, kpis.listings.sold, kpis.listings.hidden, kpis.listings.newInRange], [5, 3, 1, 1, 1, 4]);
  assert.deepEqual(kpis.listings.byKind, { regular: 2, freeDealerOnly: 1, dealerPaid: 2 });
  assert.deepEqual([kpis.subscriptions.active, kpis.subscriptions.activeDealer, kpis.subscriptions.activeSeller, kpis.subscriptions.pastDue], [2, 1, 1, 1]);
  assert.equal(kpis.revenue.totalPence, 9900 + 17000);
  assert.equal(kpis.revenue.rangePence, 9900);
  assert.equal(kpis.revenue.failedInRange, 1);
  assert.equal(kpis.revenue.monthlyRecurringPence, 9900 + 1000);
  assert.deepEqual(kpis.enquiries, { total: 2, open: 1 });
  assert.equal(kpis.complaints.open, 1);
});

test("time series covers every day in the range with real counts", () => {
  const stats = buildStats({ cars, users, dealers, payments, now: NOW, days: 7 });
  assert.equal(stats.series.length, 7);
  assert.equal(stats.series.at(-1).date, "2026-10-31");
  assert.equal(stats.series.reduce((sum, p) => sum + p.signups, 0), 1);
  assert.equal(stats.series.reduce((sum, p) => sum + p.listings, 0), 4);
  assert.equal(stats.series.reduce((sum, p) => sum + p.revenuePence, 0), 9900);
  assert.equal(buildStats({ now: NOW, days: 11 }).range, 30);
  assert.equal(buildStats({ now: NOW }).alerts.length, 0);
});

test("alerts point to the screen that fixes each problem, most urgent first by severity field", () => {
  const subscriptions = buildSubscriptions({ users, dealers, cars, tiers, now: NOW });
  const { alerts } = buildStats({ cars, users, dealers, applications: [{ status: "submitted", createdAt: iso(-5) }], payments, reports: [{ status: "open" }], subscriptions, now: NOW });
  const byId = Object.fromEntries(alerts.map((a) => [a.id, a]));
  assert.equal(byId.applications.severity, "warning");
  assert.deepEqual(byId.applications.link, { section: "dealers", tab: "applications" });
  assert.equal(byId["failed-payments"].severity, "critical");
  assert.deepEqual(byId["past-due"].link, { section: "subscriptions", status: "past_due" });
  assert.equal(byId.complaints.count, 1);
  assert.equal(byId["activation-email"].count, 1);
  assert.equal(byId["ending-soon"].count, 2);
});
