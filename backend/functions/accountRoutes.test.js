const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const express = require("express");

const { createAccountRoutes, createRequireAccountActive } = require("./accountRoutes");

function fakeDatabase(seed = {}) {
  const records = new Map(Object.entries(seed).map(([collection, docs]) =>
    [collection, new Map(Object.entries(docs).map(([id, data]) => [id, { ...data }]))],
  ));
  function collection(name) {
    if (!records.has(name)) records.set(name, new Map());
    const collectionRecords = records.get(name);
    return {
      doc(id) {
        return {
          id,
          async get() {
            const data = collectionRecords.get(id);
            return { id, exists: data !== undefined, data: () => data && { ...data } };
          },
          async set(data, options = {}) {
            collectionRecords.set(id, options.merge ? { ...(collectionRecords.get(id) || {}), ...data } : { ...data });
          },
          async delete() { collectionRecords.delete(id); },
        };
      },
      where() { return { get: async () => ({ docs: [] }) }; },
    };
  }
  return { collection, records };
}

const now = new Date("2026-09-28T10:00:00.000Z");

function setup({ seed = {}, tokens = {}, subscriptionError = null } = {}) {
  const database = fakeDatabase(seed);
  const verifiedTokens = [];
  const auth = {
    async verifyIdToken(token, checkRevoked) {
      verifiedTokens.push({ token, checkRevoked });
      if (!tokens[token]) throw Object.assign(new Error("invalid token"), { code: "auth/invalid-id-token" });
      return tokens[token];
    },
    async deleteUser() {},
  };
  const stripe = {
    subscriptions: {
      async retrieve(id) {
        if (subscriptionError) throw subscriptionError;
        return { id, status: "active", current_period_end: Math.floor(now.getTime() / 1000) + 3600 };
      },
      async update(id, patch) { return { id, ...patch }; },
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/me/account-deletion", createAccountRoutes({
    admin: { auth: () => auth },
    database,
    storageStatusDatabase: database,
    storage: { bucket: () => ({ deleteFiles: async () => [] }) },
    getStripeClient: () => stripe,
    timestamp: () => "server-time",
    now: () => now,
    logger: { warn() {} },
  }));
  const server = app.listen(0, "127.0.0.1");
  const baseUrl = new Promise((resolve, reject) => {
    server.once("listening", () => resolve(`http://127.0.0.1:${server.address().port}`));
    server.once("error", reject);
  });
  return { app, auth, database, server, baseUrl, verifiedTokens };
}

async function withServer(options, callback) {
  const state = setup(options);
  try {
    await callback(state, await state.baseUrl);
  } finally {
    await new Promise((resolve) => state.server.close(resolve));
  }
}

function recentUser(uid = "seller-1") {
  return { uid, auth_time: Math.floor(now.getTime() / 1000) - 60 };
}

test("requiresVerifiedAuthentication", async () => {
  await withServer({}, async (_state, baseUrl) => {
    const response = await fetch(`${baseUrl}/me/account-deletion`, { method: "POST" });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "Authentication is required.");
  });
});

test("rejectsStaleAuthWithoutMutation", async () => {
  await withServer({ tokens: { stale: { uid: "seller-1", auth_time: 1 } } }, async ({ database }, baseUrl) => {
    const response = await fetch(`${baseUrl}/me/account-deletion`, { method: "POST", headers: { Authorization: "Bearer stale" } });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "RECENT_AUTH_REQUIRED");
    assert.equal(database.records.get("accountDeletionRequests")?.size || 0, 0);
  });
});

test("doesNotAcceptClientSuppliedUid", async () => {
  await withServer({
    seed: { users: { "seller-1": { stripeSubscriptionId: "sub-1" }, victim: { email: "victim@example.test" } } },
    tokens: { valid: recentUser("seller-1") },
  }, async ({ database, verifiedTokens }, baseUrl) => {
    const response = await fetch(`${baseUrl}/me/account-deletion`, {
      method: "POST",
      headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
      body: JSON.stringify({ uid: "victim" }),
    });
    assert.equal(response.status, 202);
    assert.equal(database.records.get("accountDeletionRequests").has("seller-1"), true);
    assert.equal(database.records.get("accountDeletionRequests").has("victim"), false);
    assert.deepEqual(verifiedTokens, [{ token: "valid", checkRevoked: true }]);
  });
});

test("returnsPendingDeletionStatus", async () => {
  const effectiveAt = new Date("2026-10-20T10:00:00.000Z");
  await withServer({
    seed: { accountDeletionRequests: { "seller-1": { status: "pending", effectiveAt } } },
    tokens: { valid: recentUser() },
  }, async (_state, baseUrl) => {
    const response = await fetch(`${baseUrl}/me/account-deletion`, { headers: { Authorization: "Bearer valid" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { request: { status: "pending", effectiveAt: effectiveAt.toISOString() } });
  });
});

test("returnsErrorsWithoutClaimingDeletionComplete", async () => {
  await withServer({
    seed: { users: { "seller-1": { stripeSubscriptionId: "sub-1" } } },
    tokens: { valid: recentUser() },
    subscriptionError: new Error("Stripe unavailable"),
  }, async ({ database }, baseUrl) => {
    const response = await fetch(`${baseUrl}/me/account-deletion`, { method: "POST", headers: { Authorization: "Bearer valid" } });
    assert.equal(response.status, 503);
    assert.notEqual((await response.json()).status, "deleted");
    assert.equal(database.records.get("users").has("seller-1"), true);
  });
});

test("rejectsSellerAndDealerMutationsWhileDeletionPendingButAllowsStatusRead", async () => {
  const database = fakeDatabase({ accountDeletionRequests: { "seller-1": { status: "pending" } } });
  const guard = createRequireAccountActive({ database });
  const invoke = async () => {
    let responseStatus = 200;
    let response;
    let nextCalled = false;
    await guard({ user: { uid: "seller-1" } }, {
      status(status) { responseStatus = status; return this; },
      json(body) { response = body; },
    }, () => { nextCalled = true; });
    return { responseStatus, response, nextCalled };
  };

  const blocked = await invoke();
  assert.equal(blocked.responseStatus, 423);
  assert.equal(blocked.response.code, "ACCOUNT_DELETION_PENDING");
  assert.equal(blocked.nextCalled, false);

  const completedDatabase = fakeDatabase({ accountDeletionRequests: { "seller-1": { status: "completed" } } });
  const completedGuard = createRequireAccountActive({ database: completedDatabase });
  let completedStatus = 200;
  let completedResponse;
  let completedNext = false;
  await completedGuard({ user: { uid: "seller-1" } }, {
    status(status) { completedStatus = status; return this; },
    json(body) { completedResponse = body; },
  }, () => { completedNext = true; });
  assert.equal(completedStatus, 410);
  assert.equal(completedResponse.code, "ACCOUNT_DELETED");
  assert.equal(completedNext, false);

  const state = setup({
    seed: { accountDeletionRequests: { "seller-1": { status: "pending" } } },
    tokens: { valid: recentUser() },
  });
  try {
    const statusResponse = await fetch(`${await state.baseUrl}/me/account-deletion`, { headers: { Authorization: "Bearer valid" } });
    assert.equal(statusResponse.status, 200);
  } finally {
    await new Promise((resolve) => state.server.close(resolve));
  }
});

test("blocks seller and dealer billing mutations while account deletion is pending", () => {
  const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  for (const route of [
    'app.post("/billing/customer-portal", requireAuth, requireAccountActive, async',
    'app.post("/billing/checkout-session", requireAuth, requireAccountActive, async',
    'app.post("/dealer/billing/customer-portal", requireDealer, requireAccountActive, async',
    'app.post("/dealer/billing/checkout-session", requireDealer, requireAccountActive, async',
    'app.post("/me/verification-sync", requireAuth, requireAccountActive, async',
    'app.post("/vehicle-checks", requireAuth, requireAccountActive, async',
    'app.post("/dealer/network/cars/:id/enquiries", requireDealer, requireAccountActive, async',
  ]) {
    assert.ok(source.includes(route), `Expected deletion guard on ${route}`);
  }
});
