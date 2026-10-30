// Dashboard figures, subscription views and alerts, computed from the platform's real records.
const { netPence } = require("./adminPayments");
const { isModeratedOut } = require("./adminModeration");

const SELLER_MONTHLY_PENCE = 1000;
const DAY = 86_400_000;
const RANGES = [7, 30, 90, 365];

function ms(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return value;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") { const parsed = Date.parse(value); return Number.isNaN(parsed) ? null : parsed; }
  if (typeof value.seconds === "number") return value.seconds * 1000;
  if (typeof value._seconds === "number") return value._seconds * 1000;
  return null;
}
const iso = (value) => { const m = ms(value); return m ? new Date(m).toISOString() : null; };

function listingKind(car = {}) {
  if (car.sellerType === "dealer" || car.ownerType === "dealer" || car.dealerId) return "dealer-paid";
  if (car.listingPlan === "dealer-network-free" || car.visibility === "dealer-network") return "free-dealer-only";
  return "regular";
}
const LISTING_KIND_LABELS = { regular: "Regular user listing", "dealer-paid": "Paid dealer listing", "free-dealer-only": "Free dealer-only listing" };
const isLive = (car) => car.status === "published" || car.status === "active";

function subscriptionState({ status, periodEndMs, cancelAtPeriodEnd }, now) {
  if (!status || status === "none" || status === "inactive") return null;
  if (status === "active" || status === "trialing") return periodEndMs && periodEndMs < now ? "expired" : "active";
  if (status === "past_due" || status === "unpaid") return "past_due";
  if (status === "incomplete") return "pending";
  if (status === "canceled" || status === "incomplete_expired") return "cancelled";
  if (status === "paused") return "paused";
  return "pending";
}

function buildSubscriptions({ users = [], dealers = [], cars = [], tiers, now }) {
  const liveByDealer = new Map();
  for (const car of cars) if (car.dealerId && car.status === "active") liveByDealer.set(car.dealerId, (liveByDealer.get(car.dealerId) || 0) + 1);
  const rows = [];
  for (const dealer of dealers) {
    const state = subscriptionState({ status: dealer.dealerSubscriptionStatus, periodEndMs: ms(dealer.dealerSubscriptionCurrentPeriodEnd) }, now);
    if (!state) continue;
    const tier = tiers[dealer.dealerTierKey] || {};
    rows.push({ id: `dealer:${dealer.id}`, accountType: "dealer", accountId: dealer.id, label: dealer.businessName || dealer.email || dealer.id, email: dealer.email || "", tierKey: dealer.dealerTierKey || "", planName: tier.name || dealer.dealerTierKey || "Dealer plan", rawStatus: dealer.dealerSubscriptionStatus, status: state, periodEnd: iso(dealer.dealerSubscriptionCurrentPeriodEnd), cancelAtPeriodEnd: dealer.dealerSubscriptionCancelAtPeriodEnd === true, monthlyPricePence: tier.monthlyPricePence || 0, liveLimit: dealer.dealerActiveListingLimit ?? tier.activeLimit ?? null, liveCount: liveByDealer.get(dealer.id) || 0 });
  }
  for (const user of users) {
    const state = subscriptionState({ status: user.subscriptionStatus, periodEndMs: ms(user.subscriptionCurrentPeriodEnd) }, now);
    if (!state) continue;
    rows.push({ id: `seller:${user.id}`, accountType: "seller", accountId: user.id, label: user.displayName || user.email || user.id, email: user.email || "", tierKey: "", planName: "Seller public advert", rawStatus: user.subscriptionStatus, status: state, periodEnd: iso(user.subscriptionCurrentPeriodEnd), cancelAtPeriodEnd: user.subscriptionCancelAtPeriodEnd === true, monthlyPricePence: SELLER_MONTHLY_PENCE, liveLimit: null, liveCount: 0 });
  }
  return rows.sort((a, b) => Date.parse(a.periodEnd || 0) - Date.parse(b.periodEnd || 0));
}

function filterSubscriptions(rows, { status, accountType, q } = {}) {
  const text = String(q || "").trim().toLowerCase();
  return rows.filter((row) => (!status || row.status === status) && (!accountType || row.accountType === accountType)
    && (!text || [row.label, row.email, row.planName, row.accountId].join(" ").toLowerCase().includes(text)));
}

function dailySeries(days, now, fill) {
  const end = new Date(now); end.setUTCHours(0, 0, 0, 0);
  const points = [];
  for (let i = days - 1; i >= 0; i--) points.push({ date: new Date(end.getTime() - i * DAY).toISOString().slice(0, 10), signups: 0, listings: 0, revenuePence: 0 });
  const byDate = new Map(points.map((p) => [p.date, p]));
  fill((timeMs, key, amount = 1) => { const point = byDate.get(new Date(timeMs).toISOString().slice(0, 10)); if (point) point[key] += amount; });
  return points;
}

function buildStats({ cars = [], users = [], dealers = [], applications = [], enquiries = [], payments = [], reports = [], subscriptions = [], now = Date.now(), days = 30 }) {
  const range = RANGES.includes(days) ? days : 30;
  const since = now - range * DAY;
  const people = users.filter((u) => u.role !== "admin" && u.role !== "dealer" && !u.isAdmin);
  const live = cars.filter(isLive);

  const series = dailySeries(range, now, (add) => {
    for (const u of people) { const t = ms(u.createdAt); if (t) add(t, "signups"); }
    for (const c of cars) { const t = ms(c.createdAt); if (t) add(t, "listings"); }
    for (const p of payments) if (p.createdAt) add(Date.parse(p.createdAt), "revenuePence", netPence(p));
  });

  const activeSubs = subscriptions.filter((s) => s.status === "active");
  const mrr = activeSubs.reduce((sum, s) => sum + s.monthlyPricePence, 0);
  const paid = payments.filter((p) => p.status === "paid" || p.status === "refunded");
  const failedRecent = payments.filter((p) => p.status === "failed" && Date.parse(p.createdAt) >= now - 30 * DAY);
  const pendingApps = applications.filter((a) => ["submitted", "under_review"].includes(a.status));
  const oldestPending = pendingApps.reduce((oldest, a) => Math.min(oldest, ms(a.createdAt) || now), now);
  const openReports = reports.filter((r) => r.status === "open" || r.status === "reviewing");
  const endingSoon = activeSubs.filter((s) => s.periodEnd && Date.parse(s.periodEnd) - now <= 7 * DAY && s.cancelAtPeriodEnd);
  const pastDue = subscriptions.filter((s) => s.status === "past_due");
  const emailFailures = dealers.filter((d) => d.activationEmailLastError);

  const alerts = [
    pendingApps.length && { id: "applications", severity: now - oldestPending > 3 * DAY ? "warning" : "info", title: "Dealer applications waiting for review", count: pendingApps.length, link: { section: "dealers", tab: "applications" } },
    openReports.length && { id: "complaints", severity: "warning", title: "Open complaints about listings", count: openReports.length, link: { section: "complaints" } },
    failedRecent.length && { id: "failed-payments", severity: "critical", title: "Failed payments in the last 30 days", count: failedRecent.length, link: { section: "payments", status: "failed" } },
    pastDue.length && { id: "past-due", severity: "critical", title: "Subscriptions with a failed renewal", count: pastDue.length, link: { section: "subscriptions", status: "past_due" } },
    endingSoon.length && { id: "ending-soon", severity: "info", title: "Subscriptions ending within a week", count: endingSoon.length, link: { section: "subscriptions", status: "active" } },
    emailFailures.length && { id: "activation-email", severity: "warning", title: "Dealer activation emails that failed to send", count: emailFailures.length, link: { section: "dealers" } },
  ].filter(Boolean);

  return {
    range,
    kpis: {
      users: { total: people.length, newInRange: people.filter((u) => ms(u.createdAt) >= since).length },
      dealers: { total: dealers.length, approved: dealers.filter((d) => d.dealerStatus === "approved").length, suspended: dealers.filter((d) => d.dealerStatus === "suspended").length, applicationsPending: pendingApps.length },
      listings: {
        total: cars.length, live: live.length, drafts: cars.filter((c) => c.status === "draft").length, sold: cars.filter((c) => c.status === "sold").length,
        hidden: cars.filter(isModeratedOut).length, newInRange: cars.filter((c) => ms(c.createdAt) >= since).length,
        byKind: { regular: cars.filter((c) => listingKind(c) === "regular").length, freeDealerOnly: cars.filter((c) => listingKind(c) === "free-dealer-only").length, dealerPaid: cars.filter((c) => listingKind(c) === "dealer-paid").length },
      },
      subscriptions: { active: activeSubs.length, activeDealer: activeSubs.filter((s) => s.accountType === "dealer").length, activeSeller: activeSubs.filter((s) => s.accountType === "seller").length, pastDue: pastDue.length, cancelled: subscriptions.filter((s) => s.status === "cancelled").length, expired: subscriptions.filter((s) => s.status === "expired").length, endingSoon: endingSoon.length },
      revenue: {
        totalPence: paid.reduce((sum, p) => sum + netPence(p), 0),
        rangePence: paid.filter((p) => Date.parse(p.createdAt) >= since).reduce((sum, p) => sum + netPence(p), 0),
        failedInRange: payments.filter((p) => p.status === "failed" && Date.parse(p.createdAt) >= since).length,
        monthlyRecurringPence: mrr,
      },
      enquiries: { total: enquiries.length, open: enquiries.filter((e) => e.status !== "closed").length },
      complaints: { open: openReports.length },
    },
    series,
    alerts,
  };
}

module.exports = { SELLER_MONTHLY_PENCE, RANGES, LISTING_KIND_LABELS, ms, iso, listingKind, isLive, subscriptionState, buildSubscriptions, filterSubscriptions, buildStats };
