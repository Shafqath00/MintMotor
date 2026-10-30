const test = require("node:test");
const assert = require("node:assert/strict");
const { validateBulkRows, validateLookupRequest, lookupRegistrations, MAX_BULK_ROWS } = require("./dealerBulk");
const { validateListingPayload } = require("./validators");

const validateDealerPrivatePayload = (payload) => Number.isFinite(Number(payload.tradePrice)) && payload.tradePrice !== undefined
  ? { privateData: { tradePrice: Number(payload.tradePrice), dealerNotes: "" }, errors: [] }
  : { privateData: {}, errors: ["Enter a valid trade price."] };
const row = (overrides = {}) => ({ registrationNumber: "AB12 CDE", make: "Ford", model: "Focus", year: 2020, price: 9000, mileage: 20000, tradePrice: 8000, ...overrides });

test("bulk rows are validated independently, with duplicate and existing registrations rejected", () => {
  const { results } = validateBulkRows([row(), row({ make: "" }), row({ registrationNumber: "ab12cde" }), row({ registrationNumber: "XY99 ZZZ" })], {
    validateListingPayload, validateDealerPrivatePayload, existingRegistrations: new Set(["XY99ZZZ"]),
  });
  assert.ok(results[0].listing);
  assert.match(results[1].errors.join(" "), /Make is required/);
  assert.match(results[2].errors.join(" "), /more than once/);
  assert.match(results[3].errors.join(" "), /already in your inventory/);
  assert.deepEqual(results.map((result) => result.row), [1, 2, 3, 4]);
});

test("bulk upload enforces row limits", () => {
  assert.ok(validateBulkRows([], { validateListingPayload, validateDealerPrivatePayload }).error);
  assert.ok(validateBulkRows(Array.from({ length: MAX_BULK_ROWS + 1 }, () => row()), { validateListingPayload, validateDealerPrivatePayload }).error);
  assert.ok(validateLookupRequest(Array.from({ length: 26 }, () => ({}))));
  assert.equal(validateLookupRequest([{ registrationNumber: "AB12CDE", mileage: 1 }]), "");
});

test("registration lookups isolate failures and cap concurrency", async () => {
  let running = 0; let peak = 0;
  const lookupVehicle = async ({ registrationNumber }) => {
    running++; peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    if (registrationNumber === "BAD1") throw Object.assign(new Error("Vehicle not found."), { statusCode: 404 });
    if (registrationNumber === "DOWN1") throw new Error("upstream secret detail");
    return { registrationNumber, make: "Ford" };
  };
  const vehicles = ["AB12CDE", "BAD1", "DOWN1", "", "CD34EFG", "EF56GHI", "GH78IJK"].map((registrationNumber) => ({ registrationNumber, mileage: 100 }));
  const results = await lookupRegistrations(vehicles, { lookupVehicle, safeVehicleLookup: (vehicle) => vehicle, concurrency: 2 });
  assert.equal(peak, 2);
  assert.equal(results[0].vehicle.make, "Ford");
  assert.equal(results[1].error, "Vehicle not found.");
  assert.equal(results[2].error, "We could not look up this vehicle.");
  assert.match(results[3].error, /required/);
  assert.equal(results.filter((result) => result.vehicle).length, 4);
});
