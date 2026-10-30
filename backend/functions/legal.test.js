const test = require("node:test");
const assert = require("node:assert/strict");
const { LEGAL_POLICY_VERSION, buildSubscriptionAcceptance, validateSubscriptionAcknowledgement } = require("./legal");

test("rejects checkout without immediate-service acknowledgement", () => {
  assert.deepEqual(
    validateSubscriptionAcknowledgement({ policyVersion: LEGAL_POLICY_VERSION, immediateServiceAcknowledged: false }).errors,
    ["You must request immediate subscription access before continuing."],
  );
});

test("buildSubscriptionAcceptance records the checkout and policy context", () => {
  assert.deepEqual(buildSubscriptionAcceptance({
    accountType: "seller",
    userId: "seller-1",
    checkoutSessionId: "cs_test_123",
  }), {
    accountType: "seller",
    userId: "seller-1",
    checkoutSessionId: "cs_test_123",
    policyVersion: LEGAL_POLICY_VERSION,
    immediateServiceAcknowledged: true,
  });
});
