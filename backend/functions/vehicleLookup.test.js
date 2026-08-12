const assert = require("node:assert/strict");
const test = require("node:test");
const {
  VehicleLookupError,
  buildUkvdUrl,
  lookupVehicle,
  mapVehicleCheckReport,
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


test("mapVehicleCheckReport creates a package-limited, normalized live report snapshot", () => {
  const payload = {
    Response: {
      ...historyPayload.Response,
      DataItems: {
        ...historyPayload.Response.DataItems,
        MiaftrDetails: {RecordCount: 0},
        PncDetails: {Stolen: {RecordCount: 1, Message: "Police interest recorded"}},
        MotHistoryDetails: {
          MotDueDate: "2027-03-04",
          MotTests: [
            {TestDate: "2024-03-03", Mileage: 42100, Result: "Pass"},
            {TestDate: "2025-03-03", Mileage: 46120, Result: "Pass"},
          ],
        },
        VehicleTaxDetails: {TaxStatus: "Taxed", TaxDueDate: "2026-09-01"},
        UkvdValuationDetails: {PrivateSale: 18000, Retail: 19600},
        SpecAndOptionsDetails: {OptionList: [{Description: "Heated seats"}]},
      },
    },
  };

  const report = mapVehicleCheckReport(payload, "ab12 cde", "2026-08-02T10:00:00.000Z");

  assert.equal(report.registrationNumber, "AB12CDE");
  assert.equal(report.checkedAt, "2026-08-02T10:00:00.000Z");
  assert.equal(report.vehicle.make, "Bmw");
  assert.equal(report.mot.status, "valid");
  assert.deepEqual(report.mot.mileageTimeline, [
    {date: "2024-03-03", mileage: 42100, result: "passed"},
    {date: "2025-03-03", mileage: 46120, result: "passed"},
  ]);
  assert.equal(report.tax.status, "taxed");
  assert.equal(report.tax.expiryDate, "2026-09-01");
  assert.equal(report.valuation.privateSale, 18000);
  assert.equal(report.valuation.retail, 19600);
  assert.deepEqual(report.specification.features, ["Heated seats"]);
  assert.equal(report.checks.stolen.status, "recorded");
  assert.equal(report.checks.writtenOff.status, "clear");
  assert.deepEqual(report.excludedChecks, [
    "Outstanding finance",
    "Keeper information",
    "Imported/exported status",
    "Colour changes",
    "Registration changes",
  ]);
  assert.equal("rawPayload" in report, false);
});
test("normalizeRegistration strips spaces and punctuation", () => {
  assert.equal(normalizeRegistration(" ab12 cde "), "AB12CDE");
});

test("buildUkvdUrl uses configured package, key and VRM", () => {
  const original = {...process.env};
  process.env.UKVD_API_KEY = "test-key";
  process.env.UKVD_PACKAGE_ID = "package-id";
  process.env.UKVD_API_BASE_URL = "https://uk.api.vehicledataglobal.com/r2/lookup";

  const url = new URL(buildUkvdUrl("AB12CDE"));
  assert.equal(url.origin + url.pathname, "https://uk.api.vehicledataglobal.com/r2/lookup");
  assert.equal(url.searchParams.get("packagename"), "package-id");
  assert.equal(url.searchParams.get("apikey"), "test-key");
  assert.equal(url.searchParams.get("vrm"), "AB12CDE");

  process.env = original;
});

test("mapVehicleCheckReport maps the current Vehicle Data Global Results response", () => {
  const payload = {
    RequestInformation: {PackageName: "mintmotors", SearchTerm: "PL65VNG", SearchType: "VRM"},
    ResponseInformation: {StatusCode: 0, StatusMessage: "Success", IsSuccessStatusCode: true, ResponseId: "response-1"},
    Results: {
      VehicleDetails: {VehicleIdentification: {Vrm: "PL65VNG", DvlaMake: "LAND ROVER", DvlaModel: "RANGE ROVER SPORT", YearOfManufacture: 2016, DateFirstRegistered: "2016-02-22T00:00:00Z", DvlaBodyType: "ESTATE", DvlaFuelType: "HEAVY OIL"}, DvlaTechnicalDetails: {NumberOfSeats: 5, EngineCapacityCc: 2993}},
      ModelDetails: {ModelIdentification: {Make: "Land Rover", Model: "Range Rover Sport Autobiography Dynamic SDV6 Auto", ModelVariant: "SDV6 Autobiography Dynamic"}, BodyDetails: {BodyStyle: "SUV", NumberOfDoors: 5, NumberOfSeats: 5}, Powertrain: {FuelType: "Diesel", IceDetails: {EngineCapacityCc: 2993}, Transmission: {TransmissionType: "Automatic"}}},
      MotHistoryDetails: {MotDueDate: "2027-07-03T00:00:00Z", MotTestDetailsList: [{TestDate: "2026-06-25T12:15:21Z", TestPassed: true, OdometerReading: "90485"}]},
      PncDetails: {IsStolen: false}, MiaftrDetails: {WriteOffRecordList: []},
      ValuationDetails: {ValuationFigures: {PrivateClean: 14608, DealerForecourt: 17495}},
      VehicleTaxDetails: {TaxStatus: "Taxed", TaxDueDate: "2027-06-01T00:00:00Z"},
      SpecAndOptionsDetails: {FactoryEquipmentList: [{Description: "Heated front seats"}]},
    },
  };
  const report = mapVehicleCheckReport(payload, "PL65VNG", "2026-08-02T11:00:00.000Z");
  assert.equal(report.reference, "response-1");
  assert.equal(report.vehicle.make, "Land Rover");
  assert.equal(report.vehicle.model, "Range Rover Sport Autobiography Dynamic Sdv6 Auto");
  assert.equal(report.vehicle.transmission, "Automatic");
  assert.deepEqual(report.mot.mileageTimeline, [{date: "2026-06-25", mileage: 90485, result: "passed"}]);
  assert.equal(report.checks.stolen.status, "clear");
  assert.equal(report.checks.writtenOff.status, "clear");
  assert.equal(report.valuation.privateSale, 14608);
  assert.equal(report.valuation.retail, 17495);
  assert.equal(report.tax.status, "taxed");
  assert.deepEqual(report.specification.features, ["Heated front seats"]);
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

test("mapVehicleHistory rejects impossible MOT calendar dates", () => {
  const invalidDate = mapVehicleHistory({DataItems: {MotHistory: {MotDueDate: "2026-02-30"}}}, "AB12CDE", "2026-02-01T10:00:00.000Z");
  const explicitStatus = mapVehicleHistory({DataItems: {MotHistory: {MotDueDate: "2026-02-30", Status: "Valid"}}}, "AB12CDE", "2026-02-01T10:00:00.000Z");

  assert.equal(invalidDate.mot.status, "unavailable");
  assert.equal("expiryDate" in invalidDate.mot, false);
  assert.equal(explicitStatus.mot.status, "valid");
  assert.equal("expiryDate" in explicitStatus.mot, false);
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
