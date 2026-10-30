const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEALER_STATUS,
  DEALER_APPLICATION_STATUS,
  canTransitionApplication,
  normalizeDealerEmail,
  normalizedEmailHash,
  publicDealerCar,
  serializeDealer,
  serializeAdminDealer,
  serializeDealerApplication,
  validateDealerApplication,
} = require("./dealers");

test("normalizes dealer email for identity and lock keys", () => {
  assert.equal(normalizeDealerEmail("  DEALER@MINT.TEST  "), "dealer@mint.test");
  assert.equal(normalizedEmailHash(" DEALER@MINT.TEST "), normalizedEmailHash("dealer@mint.test"));
});

test("validates and normalizes a dealer application", () => {
  const { application, errors } = validateDealerApplication({
    businessName: "Mint Cars Ltd", contactName: "Ava Smith", email: "AVA@MINT.TEST ",
    phone: "07700 900123", postcode: "sw1a1aa", address: "1 Dealer Way",
    dealerType: "independent", estimatedVehicleCount: "12",
  });
  assert.deepEqual(errors, []);
  assert.equal(application.email, "ava@mint.test");
  assert.equal(application.postcode, "SW1A 1AA");
  assert.equal(application.estimatedVehicleCount, 12);
});

test("rejects invalid postcode, unsupported dealer type, and negative stock estimate", () => {
  const { errors } = validateDealerApplication({
    businessName: "Cars", contactName: "Ava", email: "ava@mint.test", phone: "07700",
    postcode: "not a postcode", address: "1 Road", dealerType: "unknown", estimatedVehicleCount: -2,
  });
  assert.equal(errors.length, 3);
});

test("bounds free text and ignores unexpected privileged input", () => {
  const { application } = validateDealerApplication({
    businessName: "B".repeat(300), contactName: "Ava", email: "ava@mint.test", phone: "07700",
    postcode: "SW1A 1AA", address: "1 Road", dealerType: "other", estimatedVehicleCount: 1,
    decisionNote: "staff secret", dealerStatus: "approved", role: "admin",
  });
  assert.equal(application.businessName.length, 160);
  assert.equal(application.decisionNote, undefined);
  assert.equal(application.dealerStatus, undefined);
  assert.equal(application.role, undefined);
});

test("allows only the intended application lifecycle transitions", () => {
  assert.equal(canTransitionApplication(DEALER_APPLICATION_STATUS.SUBMITTED, DEALER_APPLICATION_STATUS.UNDER_REVIEW), true);
  assert.equal(canTransitionApplication(DEALER_APPLICATION_STATUS.UNDER_REVIEW, DEALER_APPLICATION_STATUS.APPROVED), true);
  assert.equal(canTransitionApplication(DEALER_APPLICATION_STATUS.UNDER_REVIEW, DEALER_APPLICATION_STATUS.REJECTED), true);
  assert.equal(canTransitionApplication(DEALER_APPLICATION_STATUS.SUBMITTED, DEALER_APPLICATION_STATUS.APPROVED), false);
  assert.equal(canTransitionApplication(DEALER_APPLICATION_STATUS.APPROVED, DEALER_APPLICATION_STATUS.REJECTED), false);
});

test("applicant and dealer serializers omit internal review and audit fields", () => {
  const application = serializeDealerApplication({ id: "app-1", data: () => ({ businessName: "Cars", status: "rejected", decisionNote: "private", reviewedBy: "admin-1", activationEmailLastError: "internal" }) });
  const dealer = serializeDealer({ id: "dealer-1", data: () => ({ authUid: "dealer-1", businessName: "Cars", dealerStatus: DEALER_STATUS.APPROVED, approvedBy: "admin-1", suspendedBy: "admin-2", activationEmailLastError: "internal" }) });
  assert.equal(application.decisionNote, undefined);
  assert.equal(application.reviewedBy, undefined);
  assert.equal(application.activationEmailLastError, undefined);
  assert.equal(dealer.approvedBy, undefined);
  assert.equal(dealer.suspendedBy, undefined);
  assert.equal(dealer.activationEmailLastError, undefined);
  assert.equal(serializeAdminDealer({ id: "dealer-1", data: () => ({ activationEmailLastError: "internal" }) }).activationEmailLastError, "internal");
});

test("public car projection removes trade and dealer-only data", () => {
  const result = publicDealerCar({ id: "car-1", visibility: "dealer-network", tradePrice: 22500, dealerNotes: "private", dealerId: "dealer-1", ownerDealerId: "dealer-1", price: 24995 });
  assert.deepEqual(result, { id: "car-1", visibility: "dealer-network", price: 24995 });
});
