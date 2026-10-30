const DEALER_TIERS = Object.freeze({
  starter: { name: "Starter", monthlyPricePence: 9900, activeLimit: 10, featuredLimit: 2, priceEnvKey: "STRIPE_DEALER_STARTER_PRICE_ID", selfService: true },
  growth: { name: "Growth", monthlyPricePence: 17000, activeLimit: 17, featuredLimit: 3, priceEnvKey: "STRIPE_DEALER_GROWTH_PRICE_ID", selfService: true },
  scale: { name: "Scale", monthlyPricePence: 25000, activeLimit: 25, featuredLimit: 4, priceEnvKey: "STRIPE_DEALER_SCALE_PRICE_ID", selfService: true },
  pro: { name: "Pro", monthlyPricePence: 35000, activeLimit: 35, featuredLimit: 5, priceEnvKey: "STRIPE_DEALER_PRO_PRICE_ID", selfService: true },
  business: { name: "Business", monthlyPricePence: 50000, activeLimit: 50, featuredLimit: 9, priceEnvKey: "STRIPE_DEALER_BUSINESS_PRICE_ID", selfService: true },
  advanced: { name: "Advanced", monthlyPricePence: 75000, activeLimit: 75, featuredLimit: 15, priceEnvKey: "STRIPE_DEALER_ADVANCED_PRICE_ID", selfService: true },
  enterprise: { name: "Enterprise", monthlyPricePence: 99000, activeLimit: 99, featuredLimit: 20, priceEnvKey: "STRIPE_DEALER_ENTERPRISE_PRICE_ID", selfService: true },
  tier_150: { name: "150", monthlyPricePence: 150000, activeLimit: 150, featuredLimit: 25, priceEnvKey: "STRIPE_DEALER_150_PRICE_ID", selfService: true },
  tier_200: { name: "200", monthlyPricePence: 200000, activeLimit: 200, featuredLimit: 30, priceEnvKey: "STRIPE_DEALER_200_PRICE_ID", selfService: true },
  tier_300: { name: "300", monthlyPricePence: 300000, activeLimit: 300, featuredLimit: 30, priceEnvKey: "STRIPE_DEALER_300_PRICE_ID", selfService: true },
  tier_400: { name: "400", monthlyPricePence: 400000, activeLimit: 400, featuredLimit: 50, priceEnvKey: "STRIPE_DEALER_400_PRICE_ID", selfService: true },
  custom_500_plus: { name: "500+", monthlyPricePence: 500000, activeLimit: null, featuredLimit: null, priceEnvKey: "", selfService: false },
});

const PLAN_CONFIG = { collection: "platformConfig", id: "dealerPlans" };
const CACHE_MS = 15_000;
let cache = { at: 0, tiers: null };

function mergeTiers(base, overrides = {}) {
  const merged = {};
  for (const [key, tier] of Object.entries(base)) {
    const o = overrides[key] || {};
    merged[key] = {
      ...tier,
      ...(typeof o.name === "string" && o.name ? { name: o.name } : {}),
      ...(Number.isInteger(o.activeLimit) ? { activeLimit: o.activeLimit } : {}),
      ...(Number.isInteger(o.featuredLimit) ? { featuredLimit: o.featuredLimit } : {}),
      ...(Number.isInteger(o.monthlyPricePence) && typeof o.priceId === "string" && o.priceId ? { monthlyPricePence: o.monthlyPricePence, priceId: o.priceId } : {}),
      offered: o.offered !== false,
    };
  }
  return merged;
}

// The code defaults with the admin's saved changes applied. Cached briefly so billing paths stay fast.
async function getEffectiveTiers(database, { now = Date.now(), base = DEALER_TIERS } = {}) {
  if (cache.tiers && now - cache.at < CACHE_MS && base === DEALER_TIERS) return cache.tiers;
  let overrides = {};
  try {
    const snapshot = await database.collection(PLAN_CONFIG.collection).doc(PLAN_CONFIG.id).get();
    overrides = snapshot.exists ? snapshot.data().overrides || {} : {};
  } catch { /* Fall back to the defaults if the config can't be read. */ }
  const tiers = mergeTiers(base, overrides);
  if (base === DEALER_TIERS) cache = { at: now, tiers };
  return tiers;
}
const invalidateTierCache = () => { cache = { at: 0, tiers: null }; };

function publicDealerTiers(tiers = DEALER_TIERS) {
  return Object.entries(tiers).filter(([, tier]) => tier.offered !== false)
    .map(([key, tier]) => ({ key, name: tier.name, monthlyPricePence: tier.monthlyPricePence, activeLimit: tier.activeLimit, featuredLimit: tier.featuredLimit, selfService: tier.selfService }));
}

const PRICE_ID = /^price_[A-Za-z0-9]{6,80}$/;

function validatePlanUpdate(key, body = {}, tiers = DEALER_TIERS) {
  const errors = [];
  const patch = {};
  const current = tiers[key];
  if (!current) return { patch, errors: ["Unknown plan."] };
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name || name.length > 30) errors.push("Plan name must be 1 to 30 characters.");
    else patch.name = name;
  }
  if (body.activeLimit !== undefined) {
    if (!Number.isInteger(body.activeLimit) || body.activeLimit < 1 || body.activeLimit > 10_000) errors.push("Live listing limit must be a whole number from 1 to 10,000.");
    else patch.activeLimit = body.activeLimit;
  }
  if (body.featuredLimit !== undefined) {
    if (!Number.isInteger(body.featuredLimit) || body.featuredLimit < 0 || body.featuredLimit > 10_000) errors.push("Featured limit must be a whole number from 0 to 10,000.");
    else patch.featuredLimit = body.featuredLimit;
  }
  const active = patch.activeLimit ?? current.activeLimit;
  const featured = patch.featuredLimit ?? current.featuredLimit;
  if (Number.isInteger(active) && Number.isInteger(featured) && featured > active) errors.push("Featured listings can't exceed live listings.");
  if (body.offered !== undefined) {
    if (typeof body.offered !== "boolean") errors.push("Offered must be true or false.");
    else patch.offered = body.offered;
  }
  if (body.priceId !== undefined || body.monthlyPricePence !== undefined) {
    if (!PRICE_ID.test(String(body.priceId || ""))) errors.push("Enter the Stripe price ID for the new price (it starts with price_).");
    else if (!Number.isInteger(body.monthlyPricePence) || body.monthlyPricePence < 100 || body.monthlyPricePence > 10_000_000) errors.push("Enter the new monthly price in pence.");
    else { patch.priceId = body.priceId; patch.monthlyPricePence = body.monthlyPricePence; }
  }
  if (!errors.length && !Object.keys(patch).length) errors.push("Nothing to change.");
  return { patch, errors };
}

module.exports = { DEALER_TIERS, PLAN_CONFIG, mergeTiers, getEffectiveTiers, invalidateTierCache, publicDealerTiers, validatePlanUpdate };
