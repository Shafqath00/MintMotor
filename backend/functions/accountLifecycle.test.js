const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  finalizeAccountDeletion,
  applyDealerSubscriptionLifecycle,
  isAccountDeletionCompleted,
  cancelDeletedAccountSubscription,
  processDueAccountDeletions,
  requestAccountDeletion,
} = require("./accountLifecycle");

const { unpublishDealerListingsAfterAccessEnds } = require("./billing");

function fakeDatabase(seed = {}) {
  const records = new Map();
  for (const [collection, docs] of Object.entries(seed)) {
    for (const [id, data] of Object.entries(docs)) records.set(`${collection}/${id}`, { ...data });
  }

  const snapshot = (path, data) => ({
    id: path.split("/").at(-1),
    exists: data !== undefined,
    ref: doc(path),
    data: () => data && { ...data },
  });
  function doc(path) {
    return {
      id: path.split("/").at(-1),
      path,
      async get() { return snapshot(path, records.get(path)); },
      async set(data, options = {}) {
        records.set(path, options.merge ? { ...(records.get(path) || {}), ...data } : { ...data });
      },
      async update(data) {
        if (!records.has(path)) throw new Error(`Missing document: ${path}`);
        records.set(path, { ...records.get(path), ...data });
      },
      async delete() { records.delete(path); },
      collection(name) { return collection(`${path}/${name}`); },
    };
  }
  function query(path, filters = []) {
    return {
      where(field, operator, value) {
        assert.equal(operator, "==");
        return query(path, [...filters, [field, value]]);
      },
      async get() {
        const prefix = `${path}/`;
        const docs = [...records.entries()]
          .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
          .filter(([, value]) => filters.every(([field, expected]) => value[field] === expected))
          .map(([key, value]) => snapshot(key, value));
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
      doc(id) { return doc(`${path}/${id}`); },
    };
  }
  function collection(name) { return query(name); }

  return {
    records,
    collection,
    async runTransaction(handler) {
      return handler({
        get(ref) { return ref.get(); },
        set(ref, data, options) { return ref.set(data, options); },
      });
    },
    batch() {
      const operations = [];
      return {
        update(ref, value) { operations.push(() => ref.update(value)); },
        delete(ref) { operations.push(() => ref.delete()); },
        async commit() { for (const operation of operations) await operation(); },
      };
    },
  };
}

const asSnapshot = (id, data) => ({ id, exists: true, data: () => data });
const instant = (seconds) => new Date(seconds * 1000);

test("recognizes completed deletion requests so late Stripe webhooks cannot recreate account profiles", async () => {
  const database = fakeDatabase({ accountDeletionRequests: {
    deleted: { status: "completed" },
    pending: { status: "pending" },
  } });

  assert.equal(await isAccountDeletionCompleted(database, "deleted"), true);
  assert.equal(await isAccountDeletionCompleted(database, "pending"), false);
  assert.equal(await isAccountDeletionCompleted(database, "unknown"), false);
});

test("cancels a residual live subscription on a late webhook after account deletion", async () => {
  const database = fakeDatabase({ accountDeletionRequests: {
    deleted: { status: "completed" },
    pending: { status: "pending", effectiveAt: instant(1_800_000_000), subscriptionIds: [], subscriptions: [] },
  } });
  const calls = [];
  const stripe = { subscriptions: {
    async cancel(id) { calls.push({ id, action: "cancel" }); return { id, status: "canceled" }; },
    async update(id, patch) { calls.push({ id, action: "update", patch }); return { id, status: "active", ...patch }; },
  } };

  assert.equal(await cancelDeletedAccountSubscription({ database, uid: "deleted", subscription: { id: "sub-orphan", status: "active" }, stripe }), true);
  assert.deepEqual(calls, [{ id: "sub-orphan", action: "cancel" }]);
  assert.equal(await cancelDeletedAccountSubscription({ database, uid: "deleted", subscription: { id: "sub-ended", status: "canceled" }, stripe }), true);
  assert.deepEqual(calls, [{ id: "sub-orphan", action: "cancel" }]);
  assert.equal(await cancelDeletedAccountSubscription({
    database,
    uid: "pending",
    subscription: { id: "sub-pending", status: "active", current_period_end: 1_900_000_000 },
    stripe,
    now: instant(1_800_000_000),
    timestamp: "webhook-time",
    role: "seller",
  }), true);
  assert.deepEqual(calls[1], { id: "sub-pending", action: "update", patch: { cancel_at_period_end: true } });
  assert.deepEqual(database.records.get("accountDeletionRequests/pending").subscriptionIds, ["sub-pending"]);
  assert.equal(database.records.get("accountDeletionRequests/pending").effectiveAt.getTime(), 1_900_000_000_000);
});

test("cancels a late subscription when finalization wins the webhook race", async () => {
  const database = fakeDatabase({ accountDeletionRequests: {
    u1: { status: "pending", effectiveAt: instant(1_800_000_000), subscriptionIds: [], subscriptions: [] },
  } });
  const calls = [];
  const stripe = { subscriptions: {
    async update(id, patch) {
      calls.push({ id, action: "update", patch });
      database.records.set("accountDeletionRequests/u1", {
        ...database.records.get("accountDeletionRequests/u1"),
        status: "finalizing",
      });
      return { id, status: "active", ...patch };
    },
    async cancel(id) { calls.push({ id, action: "cancel" }); return { id, status: "canceled" }; },
  } };

  assert.equal(await cancelDeletedAccountSubscription({
    database,
    uid: "u1",
    subscription: { id: "sub-race", status: "active", current_period_end: 1_900_000_000 },
    stripe,
    now: instant(1_800_000_000),
    timestamp: "webhook-time",
    role: "seller",
  }), true);

  assert.deepEqual(calls, [
    { id: "sub-race", action: "update", patch: { cancel_at_period_end: true } },
    { id: "sub-race", action: "cancel" },
  ]);
  assert.deepEqual(database.records.get("accountDeletionRequests/u1").subscriptionIds, []);
  assert.equal(database.records.get("accountDeletionRequests/u1").status, "finalizing");
});

test("seller and dealer Stripe webhook handlers gate profile writes through deletion lifecycle handling", () => {
  const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(source, /cancelDeletedAccountSubscription\(\{ database, uid, subscription, stripe, timestamp: FieldValue\.serverTimestamp\(\), role: "seller" \}\)/);
  assert.match(source, /cancelDeletedAccountSubscription\(\{ database, uid: dealerId, subscription, stripe, timestamp: FieldValue\.serverTimestamp\(\), role: "dealer" \}\)/);
});

function stripeFor(subscriptions) {
  const calls = [];
  return {
    calls,
    subscriptions: {
      async retrieve(id) {
        const item = subscriptions[id];
        if (!item) throw new Error(`Missing subscription ${id}`);
        return { id, ...item };
      },
      async update(id, patch) {
        calls.push({ id, patch });
        subscriptions[id] = { ...subscriptions[id], ...patch };
        return { id, ...subscriptions[id] };
      },
    },
  };
}

test("schedulesSellerAndDealerSubscriptionsAndUsesLatestPeriodEnd", async () => {
  const database = fakeDatabase({
    users: { u1: { stripeSubscriptionId: "sub_seller" } },
    dealers: { u1: { stripeDealerSubscriptionId: "sub_dealer" } },
    cars: {
      private: { ownerId: "u1", listingPlan: "dealer-network-free", status: "published" },
      stock: { ownerId: "u1", dealerId: "u1", status: "active" },
      other: { ownerId: "u2", status: "published" },
    },
  });
  const stripe = stripeFor({
    sub_seller: { status: "active", current_period_end: 1_800_000_000 },
    sub_dealer: { status: "trialing", items: { data: [{ current_period_end: 1_900_000_000 }] } },
  });

  const result = await requestAccountDeletion({ uid: "u1", database, stripe, storage: { bucket: () => ({ deleteFiles: async () => [] }) }, admin: { auth: () => ({ deleteUser: async () => {} }) }, now: instant(1_700_000_000), timestamp: "server-time" });

  assert.deepEqual(result, { status: "pending", effectiveAt: instant(1_900_000_000) });
  assert.deepEqual(stripe.calls, [
    { id: "sub_seller", patch: { cancel_at_period_end: true } },
    { id: "sub_dealer", patch: { cancel_at_period_end: true } },
  ]);
  assert.equal(database.records.get("cars/private").status, "draft");
  assert.equal(database.records.get("cars/stock").status, "draft");
  assert.equal(database.records.get("cars/other").status, "published");
  assert.deepEqual(database.records.get("accountDeletionRequests/u1").subscriptionIds, ["sub_seller", "sub_dealer"]);
});

test("cancels unpaid subscriptions immediately and retains deletion until Stripe confirms", async () => {
  const database = fakeDatabase({ users: { u1: { stripeSubscriptionId: "sub-past-due" } } });
  const calls = [];
  let status = "past_due";
  const stripe = { subscriptions: {
    async retrieve(id) { return { id, status, current_period_end: 1_900_000_000 }; },
    async cancel(id) { calls.push(id); return { id, status }; },
  } };
  const deletedUsers = [];
  const dependencies = {
    uid: "u1",
    database,
    stripe,
    storage: { bucket: () => ({ deleteFiles: async () => [] }) },
    admin: { auth: () => ({ deleteUser: async (uid) => deletedUsers.push(uid) }) },
    now: instant(1_800_000_000),
    timestamp: "server-time",
  };

  const request = await requestAccountDeletion(dependencies);
  assert.deepEqual(request, { status: "pending", effectiveAt: instant(1_800_000_000) });
  assert.deepEqual(calls, ["sub-past-due"]);
  assert.equal(database.records.get("accountDeletionRequests/u1").subscriptionIds[0], "sub-past-due");
  assert.equal(database.records.has("users/u1"), true);
  assert.deepEqual(deletedUsers, []);

  status = "canceled";
  const result = await processDueAccountDeletions({ database, stripe, storage: dependencies.storage, admin: dependencies.admin, now: instant(1_800_000_000), timestamp: "server-time" });
  assert.deepEqual(result, { processed: 1, failed: 0 });
  assert.deepEqual(deletedUsers, ["u1"]);
});

test("repeated deletion requests preserve subscriptions recorded by late webhooks", async () => {
  const effectiveAt = instant(1_900_000_000);
  const database = fakeDatabase({
    accountDeletionRequests: { u1: {
      status: "pending",
      effectiveAt,
      subscriptionIds: ["sub-original", "sub-late"],
      subscriptions: [
        { id: "sub-original", role: "seller", status: "active", effectiveAt: instant(1_850_000_000) },
        { id: "sub-late", role: "seller", status: "active", effectiveAt },
      ],
    } },
    users: { u1: { stripeSubscriptionId: "sub-original" } },
    cars: { public: { ownerId: "u1", status: "published" } },
  });
  const calls = [];
  const stripe = { subscriptions: { async retrieve(id) { calls.push(id); throw new Error("should not reload Stripe"); } } };

  const result = await requestAccountDeletion({
    uid: "u1",
    database,
    stripe,
    now: instant(1_800_000_000),
    timestamp: "retry-time",
  });

  assert.deepEqual(result, { status: "pending", effectiveAt });
  assert.deepEqual(database.records.get("accountDeletionRequests/u1").subscriptionIds, ["sub-original", "sub-late"]);
  assert.equal(database.records.get("cars/public").status, "draft");
  assert.deepEqual(calls, []);
});

test("hidesSellerAndDealerListingsWhenDeletionIsRequested", async () => {
  const database = fakeDatabase({
    users: { u1: { stripeSubscriptionId: "sub_seller" } },
    cars: {
      public: { ownerId: "u1", listingPlan: "public-subscription", status: "published" },
      free: { ownerId: "u1", listingPlan: "dealer-network-free", status: "published" },
    },
  });

  await requestAccountDeletion({
    uid: "u1",
    database,
    stripe: stripeFor({ sub_seller: { status: "active", current_period_end: 1_900_000_000 } }),
    storage: { bucket: () => ({ deleteFiles: async () => [] }) },
    admin: { auth: () => ({ deleteUser: async () => {} }) },
    now: instant(1_800_000_000),
    timestamp: "server-time",
  });

  assert.equal(database.records.get("cars/public").status, "draft");
  assert.equal(database.records.get("cars/free").status, "draft");
});

test("deletesImmediatelyWhenNoSubscriptionIsActive", async () => {
  const database = fakeDatabase({ users: { u1: { email: "user@example.test" } } });
  const deletedUsers = [];
  const admin = { auth: () => ({ deleteUser: async (uid) => deletedUsers.push(uid) }) };

  const result = await requestAccountDeletion({ uid: "u1", database, storage: { bucket: () => ({ deleteFiles: async () => [] }) }, admin, now: instant(1_800_000_000), timestamp: "server-time" });

  assert.deepEqual(result, { status: "deleted", effectiveAt: null });
  assert.deepEqual(deletedUsers, ["u1"]);
  assert.equal(database.records.has("users/u1"), false);
  assert.equal(database.records.get("accountDeletionRequests/u1").status, "completed");
});

test("finalizesOnlyDueRequests", async () => {
  const database = fakeDatabase({
    accountDeletionRequests: {
      due: { status: "pending", effectiveAt: instant(1_700_000_000), subscriptionIds: [] },
      future: { status: "pending", effectiveAt: instant(1_900_000_000), subscriptionIds: [] },
    },
    users: { due: {}, future: {} },
  });
  const deletedUsers = [];
  const admin = { auth: () => ({ deleteUser: async (uid) => deletedUsers.push(uid) }) };

  const result = await processDueAccountDeletions({ database, storage: { bucket: () => ({ deleteFiles: async () => [] }) }, admin, now: instant(1_800_000_000), timestamp: "server-time" });

  assert.deepEqual(result, { processed: 1, failed: 0 });
  assert.deepEqual(deletedUsers, ["due"]);
  assert.equal(database.records.get("accountDeletionRequests/future").status, "pending");
});

test("rechecks the latest paid-through date before claiming finalization", async () => {
  const database = fakeDatabase({
    accountDeletionRequests: { u1: { status: "pending", effectiveAt: instant(1_900_000_000), subscriptionIds: ["sub-late"] } },
    users: { u1: {} },
  });
  const deletedUsers = [];

  const result = await finalizeAccountDeletion({
    uid: "u1",
    database,
    storage: { bucket: () => ({ deleteFiles: async () => [] }) },
    admin: { auth: () => ({ deleteUser: async (uid) => deletedUsers.push(uid) }) },
    now: instant(1_800_000_000),
    timestamp: "server-time",
  });

  assert.deepEqual(result, { status: "pending" });
  assert.equal(database.records.get("accountDeletionRequests/u1").status, "pending");
  assert.deepEqual(deletedUsers, []);
});

test("reconciliation retries stale finalization leases but leaves active work alone", async () => {
  const now = instant(1_800_000_000);
  const database = fakeDatabase({
    accountDeletionRequests: {
      stale: { status: "finalizing", effectiveAt: instant(1_700_000_000), finalizingStartedAt: new Date(now.getTime() - 16 * 60 * 1000), subscriptionIds: [] },
      active: { status: "finalizing", effectiveAt: instant(1_700_000_000), finalizingStartedAt: new Date(now.getTime() - 5 * 60 * 1000), subscriptionIds: [] },
    },
    users: { stale: {}, active: {} },
  });
  const deletedUsers = [];

  const result = await processDueAccountDeletions({
    database,
    storage: { bucket: () => ({ deleteFiles: async () => [] }) },
    admin: { auth: () => ({ deleteUser: async (uid) => deletedUsers.push(uid) }) },
    now,
    timestamp: "server-time",
  });

  assert.deepEqual(result, { processed: 1, failed: 0 });
  assert.deepEqual(deletedUsers, ["stale"]);
  assert.equal(database.records.get("accountDeletionRequests/stale").status, "completed");
  assert.equal(database.records.get("accountDeletionRequests/active").status, "finalizing");
});

test("retriesPartialStorageFailureWithoutMarkingComplete", async () => {
  const database = fakeDatabase({
    accountDeletionRequests: { u1: { status: "pending", effectiveAt: instant(1_700_000_000), subscriptionIds: [] } },
    users: { u1: {} },
  });
  const deletedUsers = [];

  const result = await processDueAccountDeletions({
    database,
    storage: { bucket: () => ({ deleteFiles: async () => { throw new Error("storage unavailable"); } }) },
    admin: { auth: () => ({ deleteUser: async (uid) => deletedUsers.push(uid) }) },
    now: instant(1_800_000_000),
    timestamp: "server-time",
    logger: { warn() {} },
  });

  assert.deepEqual(result, { processed: 0, failed: 1 });
  assert.equal(database.records.get("accountDeletionRequests/u1").status, "pending");
  assert.deepEqual(deletedUsers, []);
});

test("preservesBillingAuditRecordsAndAnonymizesEnquiries", async () => {
  const database = fakeDatabase({
    accountDeletionRequests: { u1: { status: "pending", effectiveAt: instant(1_700_000_000), subscriptionIds: [] } },
    users: { u1: { stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" } },
    dealers: { u1: { email: "dealer@example.test", applicationId: "app-1", stripeDealerCustomerId: "cus_d", stripeDealerSubscriptionId: "sub_d" } },
    cars: { c1: { ownerId: "u1", dealerId: "u1" } },
    dealerCarPrivate: { c1: { dealerId: "u1", tradePrice: 4000 } },
    enquiries: { e1: { sellerId: "u1", sellerEmail: "user@example.test", carId: "c1", message: "Please call me" } },
    dealerEnquiries: { de1: { sellerOwnerId: "u1", sellerDealerId: "u1", buyerDealerId: "u2", carId: "c1", message: "Trade offer" } },
    subscriptionAcceptances: { sub_1: { firebaseUid: "u1", policyVersion: "v1" } },
    dealerApplications: { "app-1": { dealerId: "u1", email: "dealer@example.test" } },
    dealerApplicationLocks: { appLock: { applicationId: "app-1" } },
    "users/u1/vehicleChecks": { report1: { registrationNumber: "AB12 CDE" } },
  });
  const admin = { auth: () => ({ deleteUser: async () => {} }) };
  const storageStatusDatabase = fakeDatabase({ storageDealerStatus: { u1: { dealerStatus: "approved" } } });
  const deletedPrefixes = [];

  await finalizeAccountDeletion({
    uid: "u1",
    database,
    storageStatusDatabase,
    storage: { bucket: () => ({ deleteFiles: async ({ prefix }) => deletedPrefixes.push(prefix) }) },
    admin,
    timestamp: "server-time",
  });

  assert.equal(database.records.has("users/u1"), false);
  assert.equal(database.records.has("dealers/u1"), false);
  assert.equal(database.records.has("cars/c1"), false);
  assert.equal(database.records.has("dealerCarPrivate/c1"), false);
  assert.equal(database.records.has("users/u1/vehicleChecks/report1"), false);
  assert.deepEqual(deletedPrefixes, ["users/u1/cars/", "dealers/u1/cars/"]);
  assert.equal(storageStatusDatabase.records.has("storageDealerStatus/u1"), false);
  assert.equal(database.records.get("enquiries/e1").sellerEmail, "");
  assert.equal(database.records.get("enquiries/e1").sellerId, "deleted");
  assert.equal(database.records.get("dealerEnquiries/de1").sellerDealerId, null);
  assert.equal(database.records.get("dealerEnquiries/de1").sellerOwnerId, "deleted");
  assert.deepEqual(database.records.get("subscriptionAcceptances/sub_1"), { firebaseUid: "deleted", policyVersion: "v1" });
  assert.equal(database.records.has("dealerApplications/app-1"), false);
  assert.equal(database.records.has("dealerApplicationLocks/appLock"), false);
  assert.equal(database.records.get("accountDeletionRequests/u1").status, "completed");
});

test("onlyDeletesContentOwnedByAuthenticatedUid", async () => {
  const database = fakeDatabase({
    accountDeletionRequests: { u1: { status: "pending", effectiveAt: instant(1_700_000_000), subscriptionIds: [] } },
    users: { u1: {}, u2: {} },
    cars: { own: { ownerId: "u1" }, other: { ownerId: "u2" } },
  });

  await finalizeAccountDeletion({ uid: "u1", database, storage: { bucket: () => ({ deleteFiles: async () => [] }) }, admin: { auth: () => ({ deleteUser: async () => {} }) }, timestamp: "server-time" });

  assert.equal(database.records.has("cars/own"), false);
  assert.equal(database.records.has("cars/other"), true);
  assert.equal(database.records.has("users/u2"), true);
});

test("draftsDealerStockOnlyAfterStripeConfirmsAccessEnded", async () => {
  const database = fakeDatabase({
    dealers: { d1: {} },
    cars: {
      dealer: { ownerId: "d1", dealerId: "d1", status: "active", sellerType: "dealer" },
      sellerFree: { ownerId: "s1", listingPlan: "dealer-network-free", status: "published" },
    },
  });

  await applyDealerSubscriptionLifecycle({
    database,
    dealerId: "d1",
    tier: { key: "starter", activeLimit: 10, featuredLimit: 1 },
    subscription: { id: "sub_d1", status: "canceled", current_period_end: 1_700_000_000 },
    timestamp: "server-time",
  });

  assert.equal(database.records.get("cars/dealer").status, "draft");
  assert.equal(database.records.get("cars/sellerFree").status, "published");
  assert.equal(database.records.get("dealers/d1").dealerSubscriptionStatus, "canceled");
});

test("keepsDealerStockVisibleWhileScheduledCancellationIsStillPaid", async () => {
  const database = fakeDatabase({
    dealers: { d1: {} },
    cars: { dealer: { ownerId: "d1", dealerId: "d1", status: "active", sellerType: "dealer" } },
  });

  await applyDealerSubscriptionLifecycle({
    database,
    dealerId: "d1",
    tier: { key: "starter", activeLimit: 10, featuredLimit: 1 },
    subscription: { id: "sub_d1", status: "active", cancel_at_period_end: true, current_period_end: 1_900_000_000 },
    timestamp: "server-time",
    now: instant(1_800_000_000),
  });

  assert.equal(database.records.get("cars/dealer").status, "active");
});
