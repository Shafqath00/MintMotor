const crypto = require("crypto");
const { normalizeUkPostcode, isValidUkPostcode } = require("./validators");

const DEALER_STATUS = Object.freeze({
  APPROVED: "approved",
  SUSPENDED: "suspended",
});

const DEALER_LISTING_STATUS = Object.freeze({ DRAFT: "draft", ACTIVE: "active", RESERVED: "reserved", SOLD: "sold", ARCHIVED: "archived" });

const DEALER_APPLICATION_STATUS = Object.freeze({
  SUBMITTED: "submitted",
  UNDER_REVIEW: "under_review",
  APPROVED: "approved",
  REJECTED: "rejected",
});

const DEALER_TYPES = new Set(["independent", "franchise", "specialist", "commercial", "other"]);

function text(value, max = 160) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalizeDealerEmail(value) {
  return text(value, 254).toLowerCase();
}

function normalizedEmailHash(email) {
  return crypto.createHash("sha256").update(normalizeDealerEmail(email)).digest("hex");
}

function validateDealerApplication(payload = {}) {
  const application = {
    businessName: text(payload.businessName || payload.tradingName, 160),
    contactName: text(payload.contactName, 120),
    email: normalizeDealerEmail(payload.email),
    phone: text(payload.phone || payload.telephone, 40),
    postcode: normalizeUkPostcode(payload.postcode),
    address: text(payload.address || payload.addressLine1, 300),
    companyNumber: text(payload.companyNumber, 32),
    vatNumber: text(payload.vatNumber, 32),
    website: text(payload.website, 300),
    estimatedVehicleCount: Number(payload.estimatedVehicleCount),
    dealerType: text(payload.dealerType, 40).toLowerCase(),
  };
  const errors = [];
  if (!application.businessName) errors.push("Business name is required.");
  if (!application.contactName) errors.push("Contact name is required.");
  if (!/^\S+@\S+\.\S+$/.test(application.email)) errors.push("Enter a valid email address.");
  if (!application.phone) errors.push("Telephone number is required.");
  if (!isValidUkPostcode(application.postcode)) errors.push("Enter a valid UK postcode.");
  if (!application.address) errors.push("Business address is required.");
  if (!DEALER_TYPES.has(application.dealerType)) errors.push("Choose a supported dealer type.");
  if (!Number.isInteger(application.estimatedVehicleCount) || application.estimatedVehicleCount < 0 || application.estimatedVehicleCount > 100000) {
    errors.push("Estimated vehicle count must be a whole number.");
  }
  return { application, errors };
}

function canTransitionApplication(from, to) {
  return new Set([
    `${DEALER_APPLICATION_STATUS.SUBMITTED}:${DEALER_APPLICATION_STATUS.UNDER_REVIEW}`,
    `${DEALER_APPLICATION_STATUS.UNDER_REVIEW}:${DEALER_APPLICATION_STATUS.APPROVED}`,
    `${DEALER_APPLICATION_STATUS.UNDER_REVIEW}:${DEALER_APPLICATION_STATUS.REJECTED}`,
  ]).has(`${from}:${to}`);
}

function serializeDate(value) {
  return value?.toDate?.().toISOString?.() || value || null;
}

function serializeDealerApplication(snapshotOrData) {
  const data = typeof snapshotOrData?.data === "function" ? snapshotOrData.data() : snapshotOrData || {};
  return {
    id: snapshotOrData?.id || data.id || "",
    businessName: data.businessName || "",
    contactName: data.contactName || "",
    email: data.email || "",
    phone: data.phone || "",
    postcode: data.postcode || "",
    address: data.address || "",
    companyNumber: data.companyNumber || "",
    vatNumber: data.vatNumber || "",
    website: data.website || "",
    estimatedVehicleCount: Number(data.estimatedVehicleCount || 0),
    dealerType: data.dealerType || "",
    status: data.status || DEALER_APPLICATION_STATUS.SUBMITTED,
    dealerId: data.dealerId || "",
    createdAt: serializeDate(data.createdAt),
    updatedAt: serializeDate(data.updatedAt),
  };
}

function serializeDealer(snapshotOrData) {
  const data = typeof snapshotOrData?.data === "function" ? snapshotOrData.data() : snapshotOrData || {};
  return {
    id: snapshotOrData?.id || data.authUid || "",
    businessName: data.businessName || "",
    contactName: data.contactName || "",
    email: data.email || "",
    phone: data.phone || "",
    postcode: data.postcode || "",
    address: data.address || "",
    companyNumber: data.companyNumber || "",
    vatNumber: data.vatNumber || "",
    website: data.website || "",
    dealerType: data.dealerType || "",
    dealerStatus: data.dealerStatus || DEALER_STATUS.SUSPENDED,
    emailVerified: data.emailVerified === true,
    activationEmailSentAt: serializeDate(data.activationEmailSentAt),
    createdAt: serializeDate(data.createdAt),
    updatedAt: serializeDate(data.updatedAt),
  };
}

function serializeAdminDealer(snapshotOrData) {
  const data = typeof snapshotOrData?.data === "function" ? snapshotOrData.data() : snapshotOrData || {};
  return {
    ...serializeDealer(snapshotOrData),
    applicationId: data.applicationId || "",
    dealerTierKey: data.dealerTierKey || "",
    dealerSubscriptionStatus: data.dealerSubscriptionStatus || "inactive",
    dealerActiveListingLimit: data.dealerActiveListingLimit ?? null,
    dealerFeaturedListingLimit: data.dealerFeaturedListingLimit ?? null,
    dealerSubscriptionCurrentPeriodEnd: serializeDate(data.dealerSubscriptionCurrentPeriodEnd),
    activationEmailLastError: data.activationEmailLastError || "",
    approvedBy: data.approvedBy || "",
    approvedAt: serializeDate(data.approvedAt),
    suspendedBy: data.suspendedBy || "",
    suspendedAt: serializeDate(data.suspendedAt),
    reactivatedBy: data.reactivatedBy || "",
    reactivatedAt: serializeDate(data.reactivatedAt),
  };
}

function publicDealerCar(car = {}) {
  const { tradePrice, dealerNotes, dealerId, ownerDealerId, ...safeCar } = car;
  return safeCar;
}

module.exports = {
  DEALER_STATUS,
  DEALER_LISTING_STATUS,
  DEALER_APPLICATION_STATUS,
  canTransitionApplication,
  normalizeDealerEmail,
  normalizedEmailHash,
  publicDealerCar,
  serializeDealer,
  serializeAdminDealer,
  serializeDealerApplication,
  validateDealerApplication,
};
