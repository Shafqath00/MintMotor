const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const proxyquire = require("proxyquire");

const records = {
  dealers: { one: { businessName: "One Cars", dealerStatus: "approved", applicationId: "app-one" }, two: { businessName: "Two Cars", dealerStatus: "approved" } },
  dealerApplications: { "app-one": { businessName: "One Cars", decisionNote: "Internal", reviewedBy: "admin-1" } },
  cars: { first: { dealerId: "one", make: "Ford", status: "active" }, second: { dealerId: "two", make: "Audi", status: "active" } },
  dealerCarPrivate: { first: { tradePrice: 12345 }, second: { tradePrice: 98765 } },
  users: {},
};
const database = { collection(name) { const rows = records[name] || {}; return {
  doc(id) { return { async get() { return { id, exists: !!rows[id], data: () => rows[id] }; } }; },
  where(field, op, value) { return { async get() { return { docs: Object.entries(rows).filter(([, row]) => row[field] === value).map(([id, row]) => ({ id, data: () => row })) }; } }; },
}; } };
const admin = { auth: () => ({ async verifyIdToken(token) { return token === "admin" ? { uid: "admin-1", role: "admin" } : { uid: "dealer-1", role: "dealer" }; }, async getUser() { return { emailVerified: true, metadata: { lastSignInTime: "2026-01-01T00:00:00Z" } }; } }) };
const { mintapi: app } = proxyquire("./index", {
  "./firebase": { admin, database, storage: {}, storageStatusDatabase: database },
  "firebase-functions/v2/https": { onRequest: (_options, handler) => handler },
  "firebase-functions/v2/scheduler": { onSchedule: () => () => {} },
});

test("admin dealer inventory includes only the selected dealer's private stock", async () => {
  const response = await request(app).get("/admin/dealers/one/cars").set("Authorization", "Bearer admin");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.cars.map(car => car.id), ["first"]);
  assert.equal(response.body.cars[0].tradePrice, 12345);
});

test("dealer detail is admin-only and includes current auth and application details", async () => {
  const denied = await request(app).get("/admin/dealers/one").set("Authorization", "Bearer dealer");
  assert.equal(denied.status, 403);
  const response = await request(app).get("/admin/dealers/one").set("Authorization", "Bearer admin");
  assert.equal(response.status, 200);
  assert.equal(response.body.dealer.emailVerified, true);
  assert.equal(response.body.application.decisionNote, "Internal");
  assert.equal((await request(app).get("/admin/dealers/missing/cars").set("Authorization", "Bearer admin")).status, 404);
});
