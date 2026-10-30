const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const proxyquire = require("proxyquire").noCallThru();
const { LISTING_STATUS } = require("./validators");
const { DEALER_LISTING_STATUS } = require("./dealers");

function fakeDatabase(initial = {}) {
  const data = new Map(
    Object.entries(initial).map(([collection, documents]) => [
      collection,
      new Map(Object.entries(documents)),
    ])
  );
  function collection(name) {
    if (!data.has(name)) data.set(name, new Map());
    const records = data.get(name);
    return {
      doc(id) {
        return {
          id,
          async get() {
            const value = records.get(id);
            return { id, exists: Boolean(value), data: () => value };
          },
          async set(value, options = {}) {
            records.set(
              id,
              options.merge ? { ...(records.get(id) || {}), ...value } : value
            );
          },
          async update(value) {
            records.set(id, { ...(records.get(id) || {}), ...value });
          },
        };
      },
      where(field, operator, value) {
        let filtered = [...records.values()];
        if (operator === "==") {
          filtered = filtered.filter((r) => r[field] === value);
        } else if (operator === "in") {
          filtered = filtered.filter((r) => value.includes(r[field]));
        }
        const queryObj = {
          async get() {
            return {
              docs: filtered.map((doc) => ({
                id: doc.id,
                data: () => doc,
              })),
            };
          },
          where(f, op, v) {
            if (op === "==") filtered = filtered.filter((r) => r[f] === v);
            else if (op === "in") filtered = filtered.filter((r) => v.includes(r[f]));
            return this;
          }
        };
        return queryObj;
      },
      async get() {
        return {
          docs: [...records.values()].map((doc) => ({
            id: doc.id,
            data: () => doc,
          })),
        };
      },
    };
  }
  return { collection, data };
}

const db = fakeDatabase({
  cars: {
    "public-car-1": {
      id: "public-car-1",
      sellerType: "private",
      listingPlan: "public-subscription",
      legacyPublicUntil: "2099-01-01T00:00:00.000Z",
      status: LISTING_STATUS.PUBLISHED,
      visibility: "public",
      ownerId: "user-1",
    },
    "dealer-network-free-car": {
      id: "dealer-network-free-car",
      sellerType: "private",
      listingPlan: "dealer-network-free",
      status: LISTING_STATUS.PUBLISHED,
      visibility: "dealer-network",
      ownerId: "user-2",
    },
    "dealer-active-car": {
      id: "dealer-active-car",
      sellerType: "dealer",
      status: DEALER_LISTING_STATUS.ACTIVE,
      visibility: "public",
      dealerId: "dealer-1",
      ownerId: "dealer-1",
    },
    "dealer-draft-car": {
      id: "dealer-draft-car",
      sellerType: "dealer",
      status: DEALER_LISTING_STATUS.DRAFT,
      visibility: "public",
      dealerId: "dealer-1",
      ownerId: "dealer-1",
    },
  },
  dealers: {
    "dealer-1": {
      dealerStatus: "approved",
    },
  },
  storageDealerStatus: { "dealer-1": { dealerStatus: "approved" } },
});

const adminStub = {
  initializeApp: () => {},
  firestore: () => db,
  auth: () => ({
    verifyIdToken: async (token) => {
      if (token === "valid-dealer-token") {
        return { uid: "dealer-1", role: "dealer", email_verified: true };
      }
      return null;
    }
  }),
  storage: () => ({ bucket: () => ({}) }),
};

adminStub.firestore.FieldValue = {
  serverTimestamp: () => "server-timestamp",
};

const functionsStub = {
  https: {
    onRequest: (app) => app,
    onCall: () => {},
  },
  pubsub: {
    schedule: () => ({ onRun: () => {} }),
  },
  scheduler: {
    onSchedule: () => {},
  },
  logger: {
    info: () => {},
    error: () => {},
  },
};

const { app } = proxyquire("./index", {
  "./firebase": { admin: adminStub, database: db, storage: adminStub.storage(), storageStatusDatabase: db },
  "firebase-admin": adminStub,
  "firebase-functions/v2": functionsStub,
  "firebase-functions/v2/https": functionsStub.https,
  "firebase-functions/v2/scheduler": functionsStub.scheduler,
  stripe: function () {
    return {
      webhookEndpoints: { create: () => {} },
    };
  },
});

test("GET /cars includes private public cars and dealer active cars", async () => {
  const res = await request(app).get("/cars");
  assert.equal(res.status, 200);
  const ids = res.body.cars.map((c) => c.id);
  assert.ok(ids.includes("public-car-1"), "Private seller public car should be visible");
  assert.ok(ids.includes("dealer-active-car"), "Dealer active car should be visible");
  assert.ok(!ids.includes("dealer-network-free-car"), "Dealer-network-free car should NOT be visible publicly");
  assert.ok(!ids.includes("dealer-draft-car"), "Dealer draft car should NOT be visible publicly");
});

test("GET /cars/:id allows fetching dealer active cars publicly", async () => {
  const res = await request(app).get("/cars/dealer-active-car");
  assert.equal(res.status, 200);
  assert.equal(res.body.car.id, "dealer-active-car");
});

test("GET /cars/:id explicitly prevents fetching dealer-network cars by anonymous users", async () => {
  const res = await request(app).get("/cars/dealer-network-free-car");
  assert.equal(res.status, 404);
});

test("GET /dealer/network/cars ONLY returns eligible private seller dealer-network-free inventory", async () => {
  const res = await request(app)
    .get("/dealer/network/cars")
    .set("Authorization", "Bearer valid-dealer-token");
  assert.equal(res.status, 200);
  const ids = res.body.cars.map((c) => c.id);
  assert.ok(ids.includes("dealer-network-free-car"), "Private dealer-network-free should be in dealer network");
  assert.ok(!ids.includes("dealer-active-car"), "Dealer inventory should NOT be in dealer network (now public only)");
});
