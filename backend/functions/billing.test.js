const assert = require("node:assert/strict");
const test = require("node:test");

const { buildSellerCheckoutUrls, createCustomerPortalSession, prepareSellerListingPlanUpdate, unpublishDealerListingsAfterAccessEnds, validateRecurringPrice, unpublishPublicListingsAfterAccessEnds } = require("./billing");

test("creates a Customer Portal session using only the stored customer ID", async () => {
  const create = async (input) => ({ url: "https://billing.stripe.test/session", input });
  const result = await createCustomerPortalSession({
    stripe: { billingPortal: { sessions: { create } } },
    customerId: "cus_user_a",
    returnUrl: "https://mintmotor.example/my-listings",
  });

  assert.equal(result.url, "https://billing.stripe.test/session");
  assert.deepEqual(result.input, { customer: "cus_user_a", return_url: "https://mintmotor.example/my-listings" });
});

test("does not create a Customer Portal session without a stored customer", async () => {
  await assert.rejects(
    () => createCustomerPortalSession({ stripe: { billingPortal: { sessions: { create: async () => ({}) } } }, customerId: "", returnUrl: "https://mintmotor.example" }),
    /no Stripe customer/i,
  );
});

test("rejects a missing or non-monthly configured recurring Price", async () => {
  await assert.rejects(
    () => validateRecurringPrice({ stripe: { prices: { retrieve: async () => { throw Object.assign(new Error("missing"), { code: "resource_missing" }); } } }, priceId: "price_missing", expectedAmount: 1000 }),
    /not configured/i,
  );
  await assert.rejects(
    () => validateRecurringPrice({ stripe: { prices: { retrieve: async () => ({ active: true, currency: "gbp", unit_amount: 1000, recurring: { interval: "week" } }) } }, priceId: "price_weekly", expectedAmount: 1000 }),
    /not configured/i,
  );
});

test("ends public visibility only for published public-subscription listings", async () => {
  const cars = new Map([
    ["public-live", { ownerId: "seller-1", listingPlan: "public-subscription", status: "published" }],
    ["public-draft", { ownerId: "seller-1", listingPlan: "public-subscription", status: "draft" }],
    ["dealer-live", { ownerId: "seller-1", listingPlan: "dealer-network-free", status: "published" }],
    ["other-seller", { ownerId: "seller-2", listingPlan: "public-subscription", status: "published" }],
  ]);
  const docs = [...cars].map(([id, data]) => ({ id, data: () => data, ref: { id } }));
  const database = {
    collection: () => ({ where: () => ({ get: async () => ({ docs }) }) }),
    batch: () => ({
      updates: [],
      update(ref, patch) { this.updates.push([ref.id, patch]); },
      async commit() {
        for (const [id, patch] of this.updates) cars.set(id, { ...cars.get(id), ...patch });
      },
    }),
  };

  await unpublishPublicListingsAfterAccessEnds({ database, userId: "seller-1", timestamp: "server-time" });

  assert.equal(cars.get("public-live").status, "draft");
  assert.equal(cars.get("public-live").updatedAt, "server-time");
  assert.equal(cars.get("public-draft").status, "draft");
  assert.equal(cars.get("dealer-live").status, "published");
  assert.equal(cars.get("other-seller").status, "published");
});

test("ends dealer visibility only for active dealer-owned stock", async () => {
  const cars = new Map([
    ["dealer-live", { dealerId: "dealer-1", sellerType: "dealer", status: "active" }],
    ["dealer-draft", { dealerId: "dealer-1", sellerType: "dealer", status: "draft" }],
    ["seller-free", { dealerId: null, ownerId: "seller-1", listingPlan: "dealer-network-free", status: "published" }],
    ["other-dealer", { dealerId: "dealer-2", sellerType: "dealer", status: "active" }],
  ]);
  const docs = [...cars].map(([id, data]) => ({ id, data: () => data, ref: { id } }));
  const database = {
    collection: () => ({ where: () => ({ get: async () => ({ docs }) }) }),
    batch: () => ({
      updates: [],
      update(ref, patch) { this.updates.push([ref.id, patch]); },
      async commit() {
        for (const [id, patch] of this.updates) cars.set(id, { ...cars.get(id), ...patch });
      },
    }),
  };

  await unpublishDealerListingsAfterAccessEnds({ database, dealerId: "dealer-1", timestamp: "server-time" });

  assert.equal(cars.get("dealer-live").status, "draft");
  assert.equal(cars.get("dealer-live").updatedAt, "server-time");
  assert.equal(cars.get("dealer-draft").status, "draft");
  assert.equal(cars.get("seller-free").status, "published");
  assert.equal(cars.get("other-dealer").status, "active");
});

test("returns paid checkout to the same draft without claiming it was published", () => {
  assert.deepEqual(buildSellerCheckoutUrls({ frontendUrl: "https://mintmotor.co.uk", draftId: "draft-42" }), {
    successUrl: "https://mintmotor.co.uk/sell/subscription?id=draft-42&checkout=success",
    cancelUrl: "https://mintmotor.co.uk/sell/subscription?id=draft-42&checkout=cancelled",
  });
});

test("keeps a public listing hidden until its account subscription is active", () => {
  assert.deepEqual(prepareSellerListingPlanUpdate({ listingPlan: "public-subscription", hasSubscription: false }), {
    listingPlan: "public-subscription",
    visibility: "public",
    status: "draft",
  });
  assert.deepEqual(prepareSellerListingPlanUpdate({ listingPlan: "public-subscription", hasSubscription: true }), {
    listingPlan: "public-subscription",
    visibility: "public",
  });
  assert.deepEqual(prepareSellerListingPlanUpdate({ listingPlan: "dealer-network-free", hasSubscription: false }), {
    listingPlan: "dealer-network-free",
    visibility: "dealer-network",
  });
});
