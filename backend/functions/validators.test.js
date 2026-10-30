const assert = require("node:assert/strict");
const test = require("node:test");
const {
  validateAdminCarPayload,
  validateAdminEnquiryPayload,
  validateAdminUserPayload,
  normalizeUkPostcode,
  validateEnquiryPayload,
  validateListingPayload,
  validatePublishListing,
  validateSellerPublishRequirements,
  hasActiveSubscription,
  sanitizeVehicleHistory,
  selectVehicleHistoryForPublish,
  prepareVehicleHistoryUpdate,
} = require("./validators");

test("validateListingPayload accepts a complete private seller listing", () => {
  const { errors, listing } = validateListingPayload({
    make: "BMW",
    model: "M4",
    year: 2024,
    price: 78000,
    mileage: 4200,
    fuelType: "Petrol",
    transmission: "Automatic",
    location: "London",
    sellerPostcode: "sw1a1aa",
    contactName: "Ava Seller",
    contactEmail: "AVA@EXAMPLE.COM",
    contactPhone: "+44 7000 000000",
    showPhone: true,
  });

  assert.deepEqual(errors, []);
  assert.equal(listing.contactEmail, "ava@example.com");
  assert.equal(listing.sellerPostcode, "SW1A 1AA");
});

test("validateListingPayload preserves a seller opting out of MintMotor enquiries", () => {
  const { errors, listing } = validateListingPayload(
    { allowEnquiries: false },
    { partial: true },
  );

  assert.deepEqual(errors, []);
  assert.equal(listing.allowEnquiries, false);
});

test("validateListingPayload partial updates include only explicitly supplied fields", () => {
  const { errors, listing } = validateListingPayload({ images: ["dealer-photo.jpg"] }, { partial: true });

  assert.deepEqual(errors, []);
  assert.deepEqual(listing, { images: ["dealer-photo.jpg"] });
});

test("validateListingPayload rejects invalid public phone settings", () => {
  const { errors } = validateListingPayload({
    make: "BMW",
    model: "M4",
    year: 2024,
    price: 78000,
    mileage: 4200,
    fuelType: "Petrol",
    transmission: "Automatic",
    location: "London",
    contactName: "Ava Seller",
    contactEmail: "ava@example.com",
    showPhone: true,
  });

  assert.match(errors.join(" "), /Phone number is required/);
});

test("validatePublishListing requires photo and description", () => {
  const errors = validatePublishListing({
    make: "Audi",
    model: "RS6",
    year: 2023,
    price: 65000,
    mileage: 12000,
    fuelType: "Petrol",
    transmission: "Automatic",
    location: "Manchester",
    sellerPostcode: "M1 1AE",
    contactName: "Sam Seller",
    contactEmail: "sam@example.com",
    images: [],
    description: "",
  });

  assert.match(errors.join(" "), /photo/);
  assert.match(errors.join(" "), /Description/);
});

test("validatePublishListing requires seller postcode", () => {
  const errors = validatePublishListing({
    make: "Audi",
    model: "RS6",
    year: 2023,
    price: 65000,
    mileage: 12000,
    fuelType: "Petrol",
    transmission: "Automatic",
    location: "Manchester",
    contactName: "Sam Seller",
    contactEmail: "sam@example.com",
    images: ["photo.jpg"],
    description: "Clean private seller car with full service history.",
  });

  assert.match(errors.join(" "), /seller postcode/);
});

test("validateListingPayload rejects invalid seller postcodes", () => {
  const { errors } = validateListingPayload(
    { sellerPostcode: "not-a-postcode" },
    { partial: true },
  );

  assert.match(errors.join(" "), /valid UK seller postcode/);
});

test("normalizeUkPostcode formats compact UK postcodes", () => {
  assert.equal(normalizeUkPostcode("sw1a1aa"), "SW1A 1AA");
});

test("validateEnquiryPayload rejects short messages", () => {
  const { errors } = validateEnquiryPayload({
    name: "Buyer",
    email: "buyer@example.com",
    message: "Hi",
  });

  assert.match(errors.join(" "), /10 characters/);
});

test("validateAdminCarPayload accepts status and featured controls", () => {
  const { patch, errors } = validateAdminCarPayload({
    status: "published",
    isFeatured: true,
    adminNote: "Looks good",
  });

  assert.deepEqual(errors, []);
  assert.equal(patch.status, "published");
  assert.equal(patch.isFeatured, true);
});

test("validateAdminEnquiryPayload rejects unsupported statuses", () => {
  const { errors } = validateAdminEnquiryPayload({ status: "ignored" });

  assert.match(errors.join(" "), /status is not supported/);
});

test("validateAdminUserPayload maps admin role to admin flag", () => {
  const { patch, errors } = validateAdminUserPayload({ role: "admin" });

  assert.deepEqual(errors, []);
  assert.equal(patch.role, "admin");
  assert.equal(patch.isAdmin, true);
});

test("validateListingPayload accepts vehicle lookup and valuation fields", () => {
  const { errors, listing } = validateListingPayload(
    {
      recommendedPrice: 15170,
      valuationNote: "Adjusted for MOT mileage.",
      motDueDate: "2027-07-03",
      serviceHistory: "full",
      dateOfFirstRegistration: "2018-04-21",
      seats: 5,
      doors: 5,
      previousOwners: 2,
      keysCount: 2,
      co2Emissions: "185g/km",
      insuranceGroup: "49E",
      fuelConsumptionUrban: "35.8 mpg",
      fuelConsumptionExtraUrban: "44.1 mpg",
      fuelConsumptionCombined: "40.4 mpg",
      lookupProvider: "seeded-fallback",
      lookupRaw: { matched: true },
    },
    { partial: true },
  );

  assert.deepEqual(errors, []);
  assert.equal(listing.recommendedPrice, 15170);
  assert.equal(listing.serviceHistory, "full");
  assert.equal(listing.seats, 5);
  assert.equal(listing.previousOwners, 2);
  assert.equal(listing.keysCount, 2);
  assert.equal(listing.dateOfFirstRegistration, "2018-04-21");
  assert.equal(listing.lookupRaw, undefined);
});

test("validateSellerPublishRequirements rejects inactive subscription and unverified contact", () => {
  const errors = validateSellerPublishRequirements({
    authUser: { email_verified: false },
    profile: { subscriptionStatus: "inactive" },
  });

  assert.match(errors.join(" "), /subscription/);
  assert.match(errors.join(" "), /email/);
  assert.match(errors.join(" "), /mobile/);
});

test("validateSellerPublishRequirements accepts active subscription and verified contact", () => {
  const errors = validateSellerPublishRequirements({
    authUser: { email_verified: true, phone_number: "+447700900000" },
    profile: {
      subscriptionStatus: "active",
      subscriptionCurrentPeriodEnd: new Date(
        Date.now() + 86400000,
      ).toISOString(),
    },
  });

  assert.deepEqual(errors, []);
});

test("hasActiveSubscription rejects expired active subscriptions", () => {
  assert.equal(
    hasActiveSubscription({
      subscriptionStatus: "active",
      subscriptionCurrentPeriodEnd: new Date(
        Date.now() - 86400000,
      ).toISOString(),
    }),
    false,
  );
});

test("validateListingPayload allows draft lookup payload with empty location", () => {
  const { errors, listing } = validateListingPayload(
    {
      registrationNumber: "PL65VNG",
      make: "Land Rover",
      model: "Range Rover Sport",
      year: 2016,
      price: 15170,
      mileage: 50000,
      fuelType: "Diesel",
      transmission: "Automatic",
      location: "",
      contactName: "Private seller",
      contactEmail: "seller@example.com",
    },
    { partial: true },
  );

  assert.deepEqual(errors, []);
  assert.equal(listing.location, "");
});

test("validateListingPayload allowlists UKVD vehicle history fields", () => {
  const { errors, listing } = validateListingPayload(
    {
      vehicleHistory: {
        provider: "ukvehicledata",
        checkedAt: "2026-07-23T10:00:00.000Z",
        registrationNumber: "ab12 cde",
        summaryStatus: "attention",
        stolen: {
          status: "recorded",
          label: "Stolen vehicle",
          detail: "A provider result",
          providerPayload: { secret: true },
        },
        mot: {
          status: "valid",
          expiryDate: "2027-01-01",
          latestMileage: 42000,
          raw: { secret: true },
        },
        raw: { secret: true },
      },
    },
    { partial: true },
  );

  assert.deepEqual(errors, []);
  assert.deepEqual(listing.vehicleHistory, {
    provider: "ukvehicledata",
    checkedAt: "2026-07-23T10:00:00.000Z",
    registrationNumber: "AB12CDE",
    summaryStatus: "attention",
    stolen: {
      status: "recorded",
      label: "Stolen vehicle",
      detail: "A provider result",
    },
    mot: {
      status: "valid",
      expiryDate: "2027-01-01",
      latestMileage: 42000,
    },
  });
});

test("validateListingPayload rejects invalid vehicle history states instead of storing them", () => {
  const { errors, listing } = validateListingPayload(
    {
      vehicleHistory: {
        provider: "ukvehicledata",
        summaryStatus: "clear",
        stolen: { status: "definitely-clear" },
        mot: { status: "current" },
      },
    },
    { partial: true },
  );

  assert.match(
    errors.join(" "),
    /Vehicle history stolen status is not supported/,
  );
  assert.match(errors.join(" "), /Vehicle history MOT status is not supported/);
  assert.equal(listing.vehicleHistory, undefined);
});

test("sanitizeVehicleHistory discards history from non-UKVD providers", () => {
  assert.equal(
    sanitizeVehicleHistory({ provider: "manual-fallback" }),
    undefined,
  );
});

test("selectVehicleHistoryForPublish retains an attested matching UKVD snapshot when refresh falls back", () => {
  const existing = {
    provider: "ukvehicledata",
    summaryStatus: "attention",
    stolen: { status: "recorded", label: "Stolen vehicle" },
    mot: { status: "expired" },
  };
  const result = selectVehicleHistoryForPublish({
    lookup: { lookupProvider: "manual-fallback" },
    currentHistory: { ...existing, registrationNumber: "AB12CDE" },
    currentHistoryVerified: true,
    registrationNumber: "AB12CDE",
  });

  assert.equal(result.vehicleHistoryVerified, true);
  assert.equal(result.vehicleHistory.provider, "ukvehicledata");
  assert.equal(result.vehicleHistory.stolen.status, "recorded");
});

test("selectVehicleHistoryForPublish stores an unavailable UKVD snapshot after an untrusted fallback", () => {
  const result = selectVehicleHistoryForPublish({
    lookup: { lookupProvider: "seeded-fallback" },
    currentHistory: { provider: "manual-fallback", summaryStatus: "clear" },
    registrationNumber: "AB12CDE",
  });

  assert.equal(result.vehicleHistoryVerified, false);
  assert.equal(result.vehicleHistory.provider, "ukvehicledata");
  assert.equal(result.vehicleHistory.summaryStatus, "unavailable");
  assert.equal(result.vehicleHistory.stolen.status, "unavailable");
  assert.equal(result.vehicleHistory.mot.status, "unavailable");
});

test("validateListingPayload never accepts client vehicle history attestation", () => {
  const { listing } = validateListingPayload(
    { vehicleHistoryVerified: true },
    { partial: true },
  );
  assert.equal(listing.vehicleHistoryVerified, undefined);
});

test("selectVehicleHistoryForPublish rejects forged unverified client history on fallback", () => {
  const result = selectVehicleHistoryForPublish({
    lookup: { lookupProvider: "manual-fallback" },
    currentHistory: {
      provider: "ukvehicledata",
      registrationNumber: "AB12CDE",
      summaryStatus: "clear",
      stolen: { status: "clear", label: "Stolen vehicle" },
    },
    currentHistoryVerified: false,
    registrationNumber: "AB12CDE",
  });

  assert.equal(result.vehicleHistoryVerified, false);
  assert.equal(result.vehicleHistory.summaryStatus, "unavailable");
});

test("selectVehicleHistoryForPublish rejects an attested history for another registration on fallback", () => {
  const result = selectVehicleHistoryForPublish({
    lookup: { lookupProvider: "seeded-fallback" },
    currentHistory: {
      provider: "ukvehicledata",
      registrationNumber: "AB12CDE",
      summaryStatus: "clear",
      stolen: { status: "clear", label: "Stolen vehicle" },
    },
    currentHistoryVerified: true,
    registrationNumber: "CD34EFG",
  });

  assert.equal(result.vehicleHistoryVerified, false);
  assert.equal(result.vehicleHistory.registrationNumber, "CD34EFG");
  assert.equal(result.vehicleHistory.summaryStatus, "unavailable");
});

test("selectVehicleHistoryForPublish attests only a matching UKVD refresh", () => {
  const result = selectVehicleHistoryForPublish({
    lookup: {
      lookupProvider: "ukvehicledata",
      vehicleHistory: {
        provider: "ukvehicledata",
        registrationNumber: "AB12CDE",
        summaryStatus: "clear",
        stolen: { status: "clear", label: "Stolen vehicle" },
      },
    },
    registrationNumber: "AB12CDE",
  });

  assert.equal(result.vehicleHistoryVerified, true);
  assert.equal(result.vehicleHistory.summaryStatus, "clear");
});

test("prepareVehicleHistoryUpdate preserves an attested snapshot on same-registration client overwrite attempts", () => {
  const result = prepareVehicleHistoryUpdate({
    current: { registrationNumber: "AB12CDE", vehicleHistoryVerified: true },
    payload: {
      registrationNumber: "ab12 cde",
      vehicleHistory: { provider: "ukvehicledata" },
    },
    listing: {
      registrationNumber: "AB12CDE",
      vehicleHistory: { provider: "ukvehicledata" },
    },
  });

  assert.equal(result.listing.vehicleHistory, undefined);
  assert.equal(result.listing.vehicleHistoryVerified, true);
  assert.equal(result.clearVehicleHistory, false);
});

test("prepareVehicleHistoryUpdate preserves attestation on unrelated same-registration edits", () => {
  const result = prepareVehicleHistoryUpdate({
    current: { registrationNumber: "AB12CDE", vehicleHistoryVerified: true },
    payload: { price: 12000 },
    listing: { price: 12000 },
  });

  assert.equal(result.listing.vehicleHistoryVerified, true);
  assert.equal(result.clearVehicleHistory, false);
});

test("prepareVehicleHistoryUpdate invalidates and clears history when registration changes", () => {
  const result = prepareVehicleHistoryUpdate({
    current: { registrationNumber: "AB12CDE", vehicleHistoryVerified: true },
    payload: { registrationNumber: "CD34EFG" },
    listing: { registrationNumber: "CD34EFG" },
  });

  assert.equal(result.listing.vehicleHistoryVerified, false);
  assert.equal(result.clearVehicleHistory, true);
});
test("selectVehicleHistoryForPublish discards a matching attested snapshot after a UKVD not-found outcome", () => {
  const result = selectVehicleHistoryForPublish({
    lookup: { lookupProvider: "not-found" },
    currentHistory: {
      provider: "ukvehicledata",
      registrationNumber: "AB12CDE",
      summaryStatus: "clear",
      stolen: { status: "clear", label: "Stolen vehicle" },
    },
    currentHistoryVerified: true,
    registrationNumber: "AB12CDE",
  });

  assert.equal(result.vehicleHistoryVerified, false);
  assert.equal(result.vehicleHistory.summaryStatus, "unavailable");
});

test("validateTrendingMakes keeps an ordered unique make list", () => {
  const { validateTrendingMakes } = require("./validators");
  const result = validateTrendingMakes({ trendingMakes: ["BMW", "Audi", "Tesla"] });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.trendingMakes, ["BMW", "Audi", "Tesla"]);
});
