const test = require("node:test");
const assert = require("node:assert/strict");
const { createTestDb } = require("./testDb");
const { isModeratedOut, validateModeration, moderationPatch, validateReport, createReport, serializeReport, validateReportReview, REPORTS_PER_HOUR } = require("./adminModeration");

const FieldValue = { serverTimestamp: () => "SERVER_TIME" };
const car = { year: 2020, make: "Ford", model: "Focus", ownerId: "u1", sellerType: "private" };

test("hidden and rejected cars are moderated out; ok and legacy cars are not", () => {
  assert.equal(isModeratedOut({ moderationStatus: "hidden" }), true);
  assert.equal(isModeratedOut({ moderationStatus: "rejected" }), true);
  assert.equal(isModeratedOut({ moderationStatus: "ok" }), false);
  assert.equal(isModeratedOut({}), false);
  assert.equal(isModeratedOut(null), false);
});

test("hiding or rejecting needs a reason; restoring does not and clears it", () => {
  assert.ok(validateModeration({ action: "hide" }).errors.length);
  assert.ok(validateModeration({ action: "reject", reason: "no" }).errors.length);
  assert.ok(validateModeration({ action: "delete", reason: "long enough" }).errors.length);
  assert.deepEqual(validateModeration({ action: "restore" }).errors, []);
  assert.equal(validateModeration({ action: "hide", reason: "  Looks like a scam  " }).reason, "Looks like a scam");
  assert.deepEqual(moderationPatch("hide", "Scam", "admin-1", FieldValue).moderationStatus, "hidden");
  assert.equal(moderationPatch("reject", "Fake", "admin-1", FieldValue).moderationStatus, "rejected");
  const restored = moderationPatch("restore", "ignored", "admin-1", FieldValue);
  assert.deepEqual([restored.moderationStatus, restored.moderationReason], ["ok", ""]);
});

test("report input is validated", () => {
  assert.ok(validateReport({ reason: "bogus" }).errors.length);
  assert.ok(validateReport({ reason: "other", message: "short" }).errors.length);
  assert.deepEqual(validateReport({ reason: "scam" }).errors, []);
  assert.equal(validateReport({ reason: "scam", message: "x".repeat(2000) }).report.message.length, 1000);
});

test("creates one open report per reporter and car, caps hourly volume, and stores who and where", async () => {
  const database = createTestDb();
  const reporter = { key: "uid:r1", uid: "r1", email: "r@x.test" };
  const first = await createReport({ database, FieldValue, carId: "c1", car, reporter, body: { reason: "scam", message: "Looks fake" }, site: "main", now: () => 1000 });
  assert.ok(first.id);
  const row = database.rows("listingReports")[first.id];
  assert.deepEqual([row.carLabel, row.status, row.site, row.reporterUid], ["2020 Ford Focus", "open", "main", "r1"]);
  assert.equal((await createReport({ database, FieldValue, carId: "c1", car, reporter, body: { reason: "scam" }, site: "main", now: () => 2000 })).duplicate, true);
  for (let i = 2; i <= REPORTS_PER_HOUR; i++) await createReport({ database, FieldValue, carId: `c${i}`, car, reporter, body: { reason: "scam" }, site: "main", now: () => 3000 + i });
  assert.equal((await createReport({ database, FieldValue, carId: "c99", car, reporter, body: { reason: "scam" }, site: "main", now: () => 9000 })).rateLimited, true);
  assert.ok((await createReport({ database, FieldValue, carId: "c99", car, reporter, body: { reason: "scam" }, site: "main", now: () => 9_000_000 })).id);
  assert.deepEqual((await createReport({ database, FieldValue, carId: "c1", car, reporter: { key: "ip:1" }, body: { reason: "x" }, site: "main" })).errors.length, 1);
});

test("reviewing a complaint needs a status and a note for final outcomes", () => {
  assert.ok(validateReportReview({ status: "nope" }).errors.length);
  assert.ok(validateReportReview({ status: "resolved" }).errors.length);
  assert.deepEqual(validateReportReview({ status: "reviewing" }).errors, []);
  assert.deepEqual(validateReportReview({ status: "dismissed", note: "Not an issue" }).patch, { status: "dismissed", resolutionNote: "Not an issue" });
  const out = serializeReport({ id: "r1", data: () => ({ carId: "c1", reason: "scam", createdAtMs: Date.parse("2026-10-01T00:00:00Z"), status: "open" }) });
  assert.equal(out.createdAt, "2026-10-01T00:00:00.000Z");
});
