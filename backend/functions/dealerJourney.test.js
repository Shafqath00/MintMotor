const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const proxyquire = require("proxyquire");

test("dealer application, approval, verification, draft and plan-gated publication", async () => {
  const collections = new Map(); let sequence = 0; let verified = false; const emails = [];
  function collection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    const rows = collections.get(name);
    const query = (filters = []) => ({
      where(field, op, value) { return query([...filters, [field, op, value]]); },
      async get() { const docs = [...rows.entries()].filter(([, data]) => filters.every(([field, op, value]) => op === "==" ? data[field] === value : value.includes(data[field]))).map(([id, data]) => ({ id, exists: true, data: () => data })); return { docs, size: docs.length }; },
    });
    return { ...query(), doc(id = `record-${++sequence}`) { return {
      id, async get() { return { id, exists: rows.has(id), data: () => rows.get(id) }; },
      async set(data, options = {}) { rows.set(id, options.merge ? { ...rows.get(id), ...data } : data); },
      async update(data) { rows.set(id, { ...rows.get(id), ...data }); },
      async create(data) { if (rows.has(id)) throw new Error("Already exists"); rows.set(id, data); },
      async delete() { rows.delete(id); },
    }; } };
  }
  const db = { collection, async runTransaction(fn) { return fn({ get: ref => ref.get(), set: (ref, data, options) => ref.set(data, options), update: (ref, data) => ref.update(data), create: (ref, data) => ref.create(data), delete: ref => ref.delete() }); } };
  const user = { uid: "dealer-1", email: "dealer@example.test", emailVerified: false, customClaims: {} };
  const admin = { auth: () => ({
    async verifyIdToken(token) { return token === "admin" ? { uid: "admin-1", role: "admin" } : { uid: user.uid, role: user.customClaims.role, email_verified: verified }; },
    async getUserByEmail() { throw Object.assign(new Error("missing"), { code: "auth/user-not-found" }); },
    async createUser() { return user; }, async setCustomUserClaims(_uid, claims) { user.customClaims = claims; },
    async getUser() { return { ...user, emailVerified: verified }; },
    async generatePasswordResetLink() { return "https://auth.test/setup"; }, async generateEmailVerificationLink() { return "https://auth.test/verify"; },
  }) };
  const { mintapi: app } = proxyquire("./index", {
    "./firebase": { admin, database: db, storage: {}, storageStatusDatabase: db },
    "./dealerEmail": { sendDealerActivationEmail: async value => { emails.push(value); }, sendDealerPlanActivatedEmail: async () => {} },
    "./vehiclePublish": { refreshVehicleDataForPublish: async () => ({ vehicleHistory: null, vehicleHistoryVerified: false }) },
    "firebase-functions/v2/https": { onRequest: (_options, handler) => handler },
    "firebase-functions/v2/scheduler": { onSchedule: () => () => {} },
  });
  const application = await request(app).post("/dealer-applications").send({ businessName: "Example Cars", contactName: "Sam", email: user.email, phone: "07700 900123", postcode: "SW1A 1AA", address: "1 Dealer Way", dealerType: "independent", estimatedVehicleCount: 5 });
  assert.equal(application.status, 201); const id = application.body.application.id;
  assert.equal((await request(app).post(`/admin/dealer-applications/${id}/approve`).set("Authorization", "Bearer admin")).status, 409);
  assert.equal((await request(app).patch(`/admin/dealer-applications/${id}`).set("Authorization", "Bearer admin").send({ status: "under_review" })).status, 200);
  assert.equal((await request(app).post(`/admin/dealer-applications/${id}/approve`).set("Authorization", "Bearer admin")).status, 200);
  assert.equal(emails.length, 1); assert.match(emails[0].setupLink, /setup/); assert.match(emails[0].verificationLink, /verify/);
  assert.equal((await request(app).get("/dealer/me").set("Authorization", "Bearer dealer")).body.code, "email_unverified");
  verified = true;
  assert.equal((await request(app).get("/dealer/me").set("Authorization", "Bearer dealer")).status, 200);
  const draft = await request(app).post("/dealer/cars").set("Authorization", "Bearer dealer").send({ registrationNumber: "AB12CDE", make: "Ford", model: "Focus", year: 2020, price: 12000, tradePrice: 9000, mileage: 5000, location: "London", sellerPostcode: "SW1A 1AA", contactName: "Sam", contactEmail: user.email, description: "Good condition", images: ["https://example.test/car.jpg"] });
  assert.equal(draft.status, 201); assert.equal(draft.body.car.status, "draft"); const carId = draft.body.car.id;
  assert.equal((await request(app).post(`/dealer/cars/${carId}/publish`).set("Authorization", "Bearer dealer")).status, 403);
  await db.collection("dealers").doc(user.uid).set({ dealerTierKey: "starter", dealerSubscriptionStatus: "active", dealerActiveListingLimit: 10, dealerFeaturedListingLimit: 2 }, { merge: true });
  const published = await request(app).post(`/dealer/cars/${carId}/publish`).set("Authorization", "Bearer dealer");
  assert.equal(published.status, 200, JSON.stringify(published.body)); assert.equal(published.body.car.status, "active");
  const publicCar = await request(app).get(`/cars/${carId}`); assert.equal(publicCar.status, 200); assert.equal(publicCar.body.car.tradePrice, undefined);
});
