const test = require("node:test");
const assert = require("node:assert/strict");
const { createTestDb } = require("./testDb");
const { createAuditLog, sanitizeDetails, actorFromRequest } = require("./adminAudit");

const FieldValue = { serverTimestamp: () => "SERVER_TIME" };
function setup() {
  const database = createTestDb();
  let clock = 1_000;
  const log = createAuditLog({ database, FieldValue, logger: { error() {} }, now: () => (clock += 10) });
  return { database, log };
}
const admin = { type: "admin", uid: "admin-1", email: "a@x.test", role: "owner" };

test("records entries with actor, target, summary and clean details", async () => {
  const { log, database } = setup();
  const id = await log.record({ action: "listing.hide", category: "moderation", actor: admin, target: { type: "listing", id: "car-1", label: "2020 Ford Focus" }, summary: "Hid a listing", details: { reason: "Spam", token: "secret", nested: { a: 1, password: "x" } } });
  const row = database.rows("auditLog")[id];
  assert.equal(row.action, "listing.hide");
  assert.deepEqual(row.actor, { type: "admin", uid: "admin-1", email: "a@x.test", name: "", role: "owner" });
  assert.deepEqual(row.details, { reason: "Spam", nested: { a: 1 } });
  assert.equal(row.createdAt, "SERVER_TIME");
});

test("never throws: invalid entries or a failing database return null", async () => {
  const { log } = setup();
  assert.equal(await log.record({ action: "x", category: "nope", actor: admin }), null);
  const broken = createAuditLog({ database: { collection() { throw new Error("down"); } }, FieldValue, logger: { error() {} } });
  assert.equal(await broken.record({ action: "listing.hide", category: "moderation", actor: admin }), null);
});

test("lists newest first, filters, and pages with a cursor", async () => {
  const { log } = setup();
  for (let i = 0; i < 6; i++) await log.record({ action: i % 2 ? "user.suspend" : "listing.hide", category: i % 2 ? "account" : "moderation", actor: admin, target: { type: "x", id: `t${i}` }, summary: `entry ${i}` });
  const first = await log.list({ limit: 4 });
  assert.deepEqual(first.entries.map((e) => e.summary), ["entry 5", "entry 4", "entry 3", "entry 2"]);
  assert.ok(first.nextBefore);
  const second = await log.list({ limit: 4, before: first.nextBefore });
  assert.deepEqual(second.entries.map((e) => e.summary), ["entry 1", "entry 0"]);
  assert.equal(second.nextBefore, null);
  assert.deepEqual((await log.list({ category: "account" })).entries.map((e) => e.summary), ["entry 5", "entry 3", "entry 1"]);
  assert.deepEqual((await log.list({ q: "ENTRY 2" })).entries.map((e) => e.summary), ["entry 2"]);
  assert.equal((await log.list({ actorUid: "someone-else" })).entries.length, 0);
});

test("timeline merges what was done to and by one record, without duplicates", async () => {
  const { log } = setup();
  await log.record({ action: "listing.create", category: "listing", actor: { type: "user", uid: "u1" }, target: { type: "listing", id: "car-1" }, summary: "created" });
  await log.record({ action: "listing.hide", category: "moderation", actor: admin, target: { type: "listing", id: "car-1" }, summary: "hidden" });
  await log.record({ action: "account.login", category: "account", actor: { type: "user", uid: "u1" }, target: { type: "user", id: "u1" }, summary: "self" });
  assert.deepEqual((await log.timeline("car-1")).map((e) => e.summary), ["hidden", "created"]);
  assert.deepEqual((await log.timeline("u1")).map((e) => e.summary), ["self", "created"]);
});

test("sanitising limits depth and size and the actor comes from the verified request", () => {
  assert.equal(sanitizeDetails("x".repeat(500)).length, 301);
  assert.deepEqual(sanitizeDetails({ a: { b: { c: 1 } } }), { a: {} });
  assert.deepEqual(actorFromRequest({ adminRole: "support", user: { uid: "a", email: "a@x" } }), { type: "admin", uid: "a", email: "a@x", role: "support" });
  assert.deepEqual(actorFromRequest({ dealer: { id: "d1", email: "d@x", businessName: "D Ltd" }, user: { uid: "d1" } }), { type: "dealer", uid: "d1", email: "d@x", name: "D Ltd" });
  assert.deepEqual(actorFromRequest({ user: { uid: "u", email: "u@x" } }), { type: "user", uid: "u", email: "u@x" });
});
