const assert = require("node:assert/strict");
const test = require("node:test");
const {createVehicleCheckStore} = require("./vehicleCheckStore");

const report = {reference: "REF-1", registrationNumber: "AB12CDE", checkedAt: "2026-08-02T10:00:00.000Z"};

test("create stores a normalized report beneath its buyer and returns its id", async () => {
  const writes = [];
  const database = {collection: () => ({doc: (uid) => ({collection: () => ({doc: () => ({id: "report-1", set: async (data) => writes.push({uid, data})})})})})};
  const store = createVehicleCheckStore({database, fetchReport: async () => report});
  const saved = await store.create("buyer-1", "ab12 cde");
  assert.equal(saved.id, "report-1");
  assert.equal(writes[0].uid, "buyer-1");
  assert.equal(writes[0].data.registrationNumber, "AB12CDE");
  assert.equal("rawPayload" in writes[0].data, false);
});

test("create does not write when the live provider fails", async () => {
  let wrote = false;
  const database = {collection: () => ({doc: () => ({collection: () => ({doc: () => ({id: "report-1", set: async () => { wrote = true; }})})})})};
  const store = createVehicleCheckStore({database, fetchReport: async () => { throw new Error("provider unavailable"); }});
  await assert.rejects(() => store.create("buyer-1", "AB12CDE"), /provider unavailable/);
  assert.equal(wrote, false);
});