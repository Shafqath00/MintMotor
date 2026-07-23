const assert = require("node:assert/strict");
const test = require("node:test");
const {publicCar, safeVehicleLookup} = require("./publicCar");

test("publicCar removes provider raw data and private seller location", () => {
  const result = publicCar({
    id: "car-1",
    lookupRaw: {secret: "provider-payload"},
    sellerPostcode: "M1 1AE",
    sellerGeo: {lat: 53.4, lng: -2.2},
    showEmail: false,
    showPhone: false,
    contactEmail: "seller@example.com",
    contactPhone: "+447700900000",
  });

  assert.equal(result.lookupRaw, undefined);
  assert.equal(result.sellerPostcode, undefined);
  assert.equal(result.sellerGeo, undefined);
  assert.equal(result.contactEmail, "");
  assert.equal(result.contactPhone, "");
});

test("publicCar only returns enabled contact details", () => {
  const result = publicCar({
    showEmail: true,
    showPhone: true,
    contactEmail: "seller@example.com",
    contactPhone: "+447700900000",
  });

  assert.equal(result.contactEmail, "seller@example.com");
  assert.equal(result.contactPhone, "+447700900000");
});

test("safeVehicleLookup strips legacy provider raw data", () => {
  const result = safeVehicleLookup({
    make: "BMW",
    lookupRaw: {secret: "provider-payload"},
  });

  assert.deepEqual(result, {make: "BMW"});
});

test("publicCar sanitizes legacy stored vehicle history", () => {
  const result = publicCar({
    vehicleHistory: {
      provider: "ukvehicledata",
      summaryStatus: "clear",
      stolen: {status: "clear", label: "Stolen vehicle", raw: {secret: true}},
      raw: {secret: true},
    },
  });

  assert.equal(result.vehicleHistory.raw, undefined);
  assert.equal(result.vehicleHistory.stolen.raw, undefined);
  assert.equal(result.vehicleHistory.stolen.status, "clear");
});
test("publicCar strips server-only vehicle history attestation", () => {
  const result = publicCar({vehicleHistoryVerified: true});
  assert.equal(result.vehicleHistoryVerified, undefined);
});