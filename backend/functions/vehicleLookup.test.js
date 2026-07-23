const assert = require("node:assert/strict");
const test = require("node:test");
const {
  VehicleLookupError,
  buildUkvdUrl,
  lookupVehicle,
  mapVehicleHistory,
  mapUkvdResponse,
  normalizeRegistration,
} = require("./vehicleLookup");

const sampleUkvdPayload = {
  Response: {
    StatusCode: "Success",
    StatusInformation: {Lookup: {StatusCode: "Success"}},
    VehicleRegistration: {
      Vrm: "AB12CDE",
      Make: "BMW",
      Model: "X5 XDRIVE30D M SPORT AUTO",
      Colour: "BLACK",
      FuelType: "DIESEL",
      Transmission: "MANUAL",
      EngineCapacity: "2993",
      YearOfManufacture: "2013",
      DateFirstRegistered: "2013-11-15T00:00:00",
      SeatingCapacity: 5,
      Co2Emissions: 164,
    },
    SmmtDetails: {
      Range: "X5",
      ModelVariant: "XDRIVE30D M SPORT",
      Transmission: "AUTOMATIC",
      BodyStyle: "ESTATE",
      NumberOfDoors: 5,
      NominalEngineCapacity: 3,
    },
    DataItems: {
      TechnicalDetails: {
        Dimensions: {BodyShape: "SUV", NumberOfSeats: 5},
        Consumption: {
          UrbanCold: {Mpg: 39.8},
          ExtraUrban: {Mpg: 49.6},
          Combined: {Mpg: 45.6},
        },
      },
      VehicleStatus: {MotVed: {MotDue: "2027-03-04T00:00:00"}},
      Valuation: {PrivateSale: 18000},
      VehicleImages: {ImageList: [{Url: "https://example.com/car.jpg"}]},
      SpecificationAndOptions: {OptionList: [{Description: "Heated seats"}]},
    },
  },
};
const historyPayload = {
  Response: {
    ...sampleUkvdPayload.Response,
    DataItems: {
      ...sampleUkvdPayload.Response.DataItems,
      VdiCheck: {
        Finance: {RecordCount: 0},
        Stolen: {RecordCount: 1, Message: "Police interest recorded"},
        WrittenOff: {RecordCount: 0},
        Scrapped: {RecordCount: 0},
        Imported: {RecordCount: 0},
        Exported: {RecordCount: 0},
        Mileage: {IsAnomaly: false},
        ColourChanges: {RecordCount: 0},
        PlateChanges: {RecordCount: 2},
      },
      MotHistory: {
        MotDueDate: "2027-03-04",
        LatestMileage: 50120,
        LatestTestDate: "2026-03-04",
        LatestResult: "Pass",
        AdvisoryCount: 2,
        FailureCount: 1,
      },
    },
  },
};

test("normalizeRegistration strips spaces and punctuation", () => {
  assert.equal(normalizeRegistration(" ab12 cde "), "AB12CDE");
});

test("buildUkvdUrl uses configured package, key and VRM", () => {
  const original = {...process.env};
  process.env.UKVD_API_KEY = "test-key";
  process.env.UKVD_PACKAGE_ID = "package-id";
  process.env.UKVD_API_BASE_URL = "https://uk1.ukvehicledata.co.uk/api/datapackage";

  const url = new URL(buildUkvdUrl("AB12CDE"));
  assert.equal(url.origin + url.pathname, "https://uk1.ukvehicledata.co.uk/api/datapackage/package-id");
  assert.equal(url.searchParams.get("auth_apikey"), "test-key");
  assert.equal(url.searchParams.get("key_VRM"), "AB12CDE");

  process.env = original;
});

test("mapUkvdResponse maps full UKVD vehicle details into MintMotor listing fields", () => {
  const vehicle = mapUkvdResponse(sampleUkvdPayload, {registrationNumber: "AB12CDE", mileage: 50000});

  assert.equal(vehicle.lookupProvider, "ukvehicledata");
  assert.equal(vehicle.make, "Bmw");
  assert.equal(vehicle.model, "X5");
  assert.equal(vehicle.variant, "XDRIVE30D M SPORT");
  assert.equal(vehicle.fuelType, "Diesel");
  assert.equal(vehicle.transmission, "Automatic");
  assert.equal(vehicle.bodyType, "Suv");
  assert.equal(vehicle.doors, 5);
  assert.equal(vehicle.seats, 5);
  assert.equal(vehicle.motDueDate, "2027-03-04");
  assert.equal(vehicle.fuelConsumptionCombined, "45.6 mpg");
  assert.equal(vehicle.images[0], "https://example.com/car.jpg");
  assert.equal(vehicle.features[0], "Heated seats");
  assert.ok(vehicle.recommendedPrice > 0);
});

test("mapVehicleHistory distinguishes clear, recorded and unavailable UKVD facts", () => {
  const history = mapVehicleHistory(historyPayload.Response, "AB12CDE", "2026-07-23T10:00:00.000Z");

  assert.equal(history.outstandingFinance.status, "clear");
  assert.equal(history.stolen.status, "recorded");
  assert.equal(history.plateChanges.status, "recorded");
  assert.equal(history.summaryStatus, "attention");
  assert.equal(history.mot.latestMileage, 50120);
});

test("mapVehicleHistory never treats missing provider facts as clear", () => {
  const history = mapVehicleHistory({DataItems: {}}, "AB12CDE", "2026-07-23T10:00:00.000Z");

  assert.equal(history.outstandingFinance.status, "unavailable");
  assert.equal(history.summaryStatus, "unavailable");
});

test("mapVehicleHistory treats malformed provider values as unavailable", () => {
  const history = mapVehicleHistory({
    DataItems: {
      VdiCheck: {
        Finance: {RecordCount: "unknown"},
        Stolen: {},
        WrittenOff: "not-sure",
        Scrapped: 0,
        Imported: false,
        Exported: true,
      },
    },
  }, "AB12CDE", "2026-07-23T10:00:00.000Z");

  assert.equal(history.outstandingFinance.status, "unavailable");
  assert.equal(history.stolen.status, "unavailable");
  assert.equal(history.writtenOff.status, "unavailable");
  assert.equal(history.scrapped.status, "clear");
  assert.equal(history.imported.status, "clear");
  assert.equal(history.exported.status, "recorded");
});

test("mapVehicleHistory conforms MOT details to the VehicleHistoryCheck contract", () => {
  const history = mapVehicleHistory(historyPayload.Response, "AB12CDE", "2026-07-23T10:00:00.000Z");

  assert.equal(history.mot.status, "valid");
  assert.equal(history.mot.expiryDate, "2027-03-04");
  assert.equal(history.mot.latestResult, "passed");
  assert.equal("dueDate" in history.mot, false);
});

test("mapVehicleHistory omits absent MOT facts and recognizes unavailable states", () => {
  const expired = mapVehicleHistory({DataItems: {MotHistory: {MotDueDate: "2025-01-01", LatestResult: "unknown"}}}, "AB12CDE", "2026-07-23T10:00:00.000Z");
  const notFound = mapVehicleHistory({DataItems: {MotHistory: {Status: "Not Found"}}}, "AB12CDE", "2026-07-23T10:00:00.000Z");
  const unavailable = mapVehicleHistory({DataItems: {}}, "AB12CDE", "2026-07-23T10:00:00.000Z");

  assert.equal(expired.mot.status, "expired");
  assert.equal(expired.mot.expiryDate, "2025-01-01");
  assert.equal("latestMileage" in expired.mot, false);
  assert.equal("advisoryCount" in expired.mot, false);
  assert.equal("failureCount" in expired.mot, false);
  assert.equal("latestResult" in expired.mot, false);
  assert.equal(notFound.mot.status, "not-found");
  assert.equal(unavailable.mot.status, "unavailable");
});

test("lookup results do not expose raw UKVD provider payloads", async () => {
  const originalEnv = {...process.env};
  delete process.env.UKVD_API_KEY;
  delete process.env.UKVD_PACKAGE_ID;

  const mapped = mapUkvdResponse(historyPayload, {registrationNumber: "AB12CDE", mileage: 50000});
  const seededFallback = await lookupVehicle({registrationNumber: "PL65VNG", mileage: 90485});
  const manualFallback = await lookupVehicle({registrationNumber: "ZZ99ZZZ", mileage: 90485});

  assert.equal("lookupRaw" in mapped, false);
  assert.equal("lookupRaw" in seededFallback, false);
  assert.equal("lookupRaw" in manualFallback, false);

  process.env = originalEnv;
});
test("mapUkvdResponse includes normalized vehicle history", () => {
  const vehicle = mapUkvdResponse(historyPayload, {registrationNumber: "AB12CDE", mileage: 50000});

  assert.equal(vehicle.vehicleHistory.provider, "ukvehicledata");
  assert.equal(vehicle.vehicleHistory.stolen.status, "recorded");
});
test("mapUkvdResponse throws clear not found error when no make/model is returned", () => {
  assert.throws(
    () => mapUkvdResponse({Response: {StatusCode: "Success"}}, {registrationNumber: "BADVRM", mileage: 10000}),
    (error) => error instanceof VehicleLookupError && error.statusCode === 404,
  );
});

test("lookupVehicle uses UKVD when configured and fetch succeeds", async () => {
  const originalEnv = {...process.env};
  const originalFetch = global.fetch;
  process.env.UKVD_API_KEY = "test-key";
  process.env.UKVD_PACKAGE_ID = "package-id";
  global.fetch = async () => ({ok: true, json: async () => sampleUkvdPayload});

  const vehicle = await lookupVehicle({registrationNumber: "AB12CDE", mileage: 50000});
  assert.equal(vehicle.lookupProvider, "ukvehicledata");

  global.fetch = originalFetch;
  process.env = originalEnv;
});

test("lookupVehicle falls back when UKVD is not configured", async () => {
  const originalEnv = {...process.env};
  delete process.env.UKVD_API_KEY;
  delete process.env.UKVD_PACKAGE_ID;

  const vehicle = await lookupVehicle({registrationNumber: "PL65VNG", mileage: 90485});
  assert.equal(vehicle.lookupProvider, "seeded-fallback");
  assert.equal(vehicle.make, "Land Rover");

  process.env = originalEnv;
});
