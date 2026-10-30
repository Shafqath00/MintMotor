const LEGAL_POLICY_VERSION = "2026-09-27";

function validateSubscriptionAcknowledgement(input = {}) {
  const errors = [];
  if (input.policyVersion !== LEGAL_POLICY_VERSION) errors.push("Please review the current subscription terms before continuing.");
  if (input.immediateServiceAcknowledged !== true) errors.push("You must request immediate subscription access before continuing.");
  return errors.length ? { errors } : { policyVersion: LEGAL_POLICY_VERSION, immediateServiceAcknowledged: true };
}

function buildSubscriptionAcceptance({ accountType, userId, checkoutSessionId, dealerTierKey }) {
  return {
    accountType,
    userId,
    checkoutSessionId,
    policyVersion: LEGAL_POLICY_VERSION,
    immediateServiceAcknowledged: true,
    ...(dealerTierKey ? { dealerTierKey } : {}),
  };
}

module.exports = { LEGAL_POLICY_VERSION, buildSubscriptionAcceptance, validateSubscriptionAcknowledgement };
