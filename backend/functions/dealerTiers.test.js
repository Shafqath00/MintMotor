const test = require("node:test");
const assert = require("node:assert/strict");
const { createTestDb } = require("./testDb");
const { DEALER_TIERS, mergeTiers, getEffectiveTiers, invalidateTierCache, publicDealerTiers, validatePlanUpdate } = require("./dealerTiers");

test("defaults apply when nothing is saved, and every default tier is offered", async () => {
  invalidateTierCache();
  const tiers = await getEffectiveTiers(createTestDb());
  assert.equal(tiers.starter.activeLimit, 10);
  assert.ok(Object.values(tiers).every((tier) => tier.offered));
  assert.equal(publicDealerTiers(tiers).length, Object.keys(DEALER_TIERS).length);
});

test("saved changes override limits, names and visibility but never selfService", async () => {
  invalidateTierCache();
  const database = createTestDb({ platformConfig: { dealerPlans: { overrides: { starter: { name: "Launch", activeLimit: 12, featuredLimit: 4, offered: true, selfService: false }, pro: { offered: false } } } } });
  const tiers = await getEffectiveTiers(database);
  assert.deepEqual([tiers.starter.name, tiers.starter.activeLimit, tiers.starter.featuredLimit, tiers.starter.selfService], ["Launch", 12, 4, true]);
  assert.equal(tiers.pro.offered, false);
  assert.ok(!publicDealerTiers(tiers).some((tier) => tier.key === "pro"));
  invalidateTierCache();
});

test("a new price only takes effect with both the amount and the Stripe price ID", () => {
  const both = mergeTiers(DEALER_TIERS, { starter: { monthlyPricePence: 12000, priceId: "price_abc123456" } });
  assert.deepEqual([both.starter.monthlyPricePence, both.starter.priceId], [12000, "price_abc123456"]);
  const half = mergeTiers(DEALER_TIERS, { starter: { monthlyPricePence: 12000 } });
  assert.equal(half.starter.monthlyPricePence, 9900);
});

test("results are cached briefly, and invalidation picks up new changes", async () => {
  invalidateTierCache();
  const database = createTestDb();
  assert.equal((await getEffectiveTiers(database, { now: 1000 })).starter.activeLimit, 10);
  await database.collection("platformConfig").doc("dealerPlans").set({ overrides: { starter: { activeLimit: 11 } } });
  assert.equal((await getEffectiveTiers(database, { now: 2000 })).starter.activeLimit, 10);
  invalidateTierCache();
  assert.equal((await getEffectiveTiers(database, { now: 3000 })).starter.activeLimit, 11);
  invalidateTierCache();
});

test("plan updates are validated", () => {
  assert.deepEqual(validatePlanUpdate("starter", { activeLimit: 20, featuredLimit: 5, name: " Launch " }).patch, { activeLimit: 20, featuredLimit: 5, name: "Launch" });
  assert.ok(validatePlanUpdate("nope", { activeLimit: 5 }).errors.length);
  assert.ok(validatePlanUpdate("starter", { activeLimit: 0 }).errors.length);
  assert.ok(validatePlanUpdate("starter", { activeLimit: 2.5 }).errors.length);
  assert.match(validatePlanUpdate("starter", { activeLimit: 5, featuredLimit: 9 }).errors.join(" "), /can't exceed/);
  assert.match(validatePlanUpdate("starter", { featuredLimit: 11 }).errors.join(" "), /can't exceed/);
  assert.ok(validatePlanUpdate("starter", { monthlyPricePence: 12000 }).errors.length);
  assert.ok(validatePlanUpdate("starter", { monthlyPricePence: 12000, priceId: "prod_123" }).errors.length);
  assert.deepEqual(validatePlanUpdate("starter", { monthlyPricePence: 12000, priceId: "price_abc123456" }).patch, { monthlyPricePence: 12000, priceId: "price_abc123456" });
  assert.deepEqual(validatePlanUpdate("starter", {}).errors, ["Nothing to change."]);
  assert.ok(validatePlanUpdate("starter", { offered: "yes" }).errors.length);
});
