const LISTING_STATUS = {
  DRAFT: "draft",
  PUBLISHED: "published",
  SOLD: "sold",
};

const ENQUIRY_STATUS = {
  NEW: "new",
  READ: "read",
  CLOSED: "closed",
};

const USER_ROLES = {
  USER: "user",
  ADMIN: "admin",
};

const FUEL_TYPES = ["Petrol", "Diesel", "Electric", "Hybrid"];
const TRANSMISSIONS = ["Automatic", "Manual"];
const SERVICE_HISTORY = ["full", "part", "none", ""];

function asString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeUkPostcode(value) {
  const compact = asString(value).toUpperCase().replace(/\s+/g, "");
  if (!compact) return "";
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

function isValidUkPostcode(value) {
  const postcode = normalizeUkPostcode(value);
  return /^(GIR 0AA|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})$/.test(postcode);
}

function asStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => asString(item))
    .filter(Boolean)
    .slice(0, 80);
}

function asOptionalPositiveNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

const HISTORY_ITEM_STATUS = new Set(["clear", "recorded", "unavailable"]);
const HISTORY_SUMMARY_STATUS = new Set(["clear", "attention", "unavailable"]);
const MOT_STATUS = new Set(["valid", "expired", "not-found", "unavailable"]);
const HISTORY_ITEM_KEYS = ["outstandingFinance", "stolen", "writtenOff", "scrapped", "imported", "exported", "mileageAnomaly", "colourChanges", "plateChanges"];
const HISTORY_ITEM_LABELS = {outstandingFinance: "Outstanding finance", stolen: "Stolen vehicle", writtenOff: "Insurance write-off", scrapped: "Scrapped", imported: "Imported", exported: "Exported", mileageAnomaly: "Mileage anomaly", colourChanges: "Colour changes", plateChanges: "Registration plate changes"};

function normalizeRegistrationNumber(value) {
  return asString(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function sanitizeHistoryItem(value = {}) {
  return {status: HISTORY_ITEM_STATUS.has(value?.status) ? value.status : "unavailable", label: asString(value?.label).slice(0, 80), detail: asString(value?.detail).slice(0, 300)};
}

function sanitizeMot(value = {}) {
  const mot = {status: MOT_STATUS.has(value?.status) ? value.status : "unavailable"};
  const expiryDate = asString(value?.expiryDate).slice(0, 10);
  const latestTestDate = asString(value?.latestTestDate).slice(0, 10);
  const latestResult = asString(value?.latestResult).toLowerCase();
  const latestMileage = asOptionalPositiveNumber(value?.latestMileage);
  const advisoryCount = asOptionalPositiveNumber(value?.advisoryCount);
  const failureCount = asOptionalPositiveNumber(value?.failureCount);
  if (expiryDate) mot.expiryDate = expiryDate;
  if (latestTestDate) mot.latestTestDate = latestTestDate;
  if (["passed", "failed"].includes(latestResult)) mot.latestResult = latestResult;
  if (latestMileage !== undefined) mot.latestMileage = latestMileage;
  if (advisoryCount !== undefined) mot.advisoryCount = advisoryCount;
  if (failureCount !== undefined) mot.failureCount = failureCount;
  return mot;
}

function validateVehicleHistory(value, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push("Vehicle history must be an object supplied by UK Vehicle Data.");
    return false;
  }
  if (value.provider !== "ukvehicledata") {
    errors.push("Vehicle history must be supplied by UK Vehicle Data.");
    return false;
  }
  if (value.summaryStatus !== undefined && !HISTORY_SUMMARY_STATUS.has(value.summaryStatus)) errors.push("Vehicle history summary status is not supported.");
  for (const key of HISTORY_ITEM_KEYS) {
    const item = value[key];
    if (item === undefined) continue;
    if (!item || typeof item !== "object" || Array.isArray(item) || !HISTORY_ITEM_STATUS.has(item.status)) errors.push(`Vehicle history ${key} status is not supported.`);
  }
  if (value.mot !== undefined && (!value.mot || typeof value.mot !== "object" || Array.isArray(value.mot) || !MOT_STATUS.has(value.mot.status))) errors.push("Vehicle history MOT status is not supported.");
  return errors.length === 0;
}

function sanitizeVehicleHistory(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.provider !== "ukvehicledata") return undefined;
  const history = {provider: "ukvehicledata", checkedAt: asString(value.checkedAt).slice(0, 40), registrationNumber: normalizeRegistrationNumber(value.registrationNumber), summaryStatus: HISTORY_SUMMARY_STATUS.has(value.summaryStatus) ? value.summaryStatus : "unavailable"};
  for (const key of HISTORY_ITEM_KEYS) if (value[key] !== undefined) history[key] = sanitizeHistoryItem(value[key]);
  if (value.mot !== undefined) history.mot = sanitizeMot(value.mot);
  return history;
}

function unavailableVehicleHistory(registrationNumber) {
  const history = {provider: "ukvehicledata", checkedAt: new Date().toISOString(), registrationNumber: normalizeRegistrationNumber(registrationNumber), summaryStatus: "unavailable", mot: {status: "unavailable"}};
  for (const key of HISTORY_ITEM_KEYS) history[key] = {status: "unavailable", label: HISTORY_ITEM_LABELS[key], detail: "Unable to refresh this check."};
  return history;
}

function historyMatchesRegistration(history, registrationNumber) {
  return normalizeRegistrationNumber(history?.registrationNumber) === normalizeRegistrationNumber(registrationNumber);
}

function selectVehicleHistoryForPublish({lookup = {}, currentHistory, currentHistoryVerified = false, registrationNumber} = {}) {
  const refreshedHistory = sanitizeVehicleHistory(lookup.vehicleHistory);
  if (lookup.lookupProvider === "ukvehicledata" && refreshedHistory && historyMatchesRegistration(refreshedHistory, registrationNumber)) {
    return {vehicleHistory: refreshedHistory, vehicleHistoryVerified: true};
  }

  const trustedCurrentHistory = sanitizeVehicleHistory(currentHistory);
  if (currentHistoryVerified === true && trustedCurrentHistory && historyMatchesRegistration(trustedCurrentHistory, registrationNumber)) {
    return {vehicleHistory: trustedCurrentHistory, vehicleHistoryVerified: true};
  }

  return {vehicleHistory: unavailableVehicleHistory(registrationNumber), vehicleHistoryVerified: false};
}

function prepareVehicleHistoryUpdate({current = {}, payload = {}, listing = {}} = {}) {
  const nextListing = {...listing};
  delete nextListing.vehicleHistoryVerified;

  const currentRegistration = normalizeRegistrationNumber(current.registrationNumber);
  const registrationProvided = payload.registrationNumber !== undefined;
  const nextRegistration = registrationProvided
    ? normalizeRegistrationNumber(payload.registrationNumber)
    : currentRegistration;
  const registrationChanged = registrationProvided && nextRegistration !== currentRegistration;

  if (registrationChanged) {
    nextListing.vehicleHistoryVerified = false;
    return {
      listing: nextListing,
      clearVehicleHistory: payload.vehicleHistory === undefined,
    };
  }

  if (current.vehicleHistoryVerified === true) {
    delete nextListing.vehicleHistory;
    nextListing.vehicleHistoryVerified = true;
    return {listing: nextListing, clearVehicleHistory: false};
  }

  nextListing.vehicleHistoryVerified = false;
  return {listing: nextListing, clearVehicleHistory: false};
}

function validateListingPayload(payload = {}, options = {}) {
  const allowPartial = Boolean(options.partial);
  const errors = [];

  const listing = {
    status: asString(payload.status).toLowerCase(),
    registrationNumber: asString(payload.registrationNumber).toUpperCase(),
    make: asString(payload.make),
    model: asString(payload.model),
    variant: asString(payload.variant),
    year: asNumber(payload.year),
    price: asNumber(payload.price),
    mileage: asNumber(payload.mileage),
    fuelType: asString(payload.fuelType),
    transmission: asString(payload.transmission),
    bodyType: asString(payload.bodyType),
    engineSize: asString(payload.engineSize),
    color: asString(payload.color),
    location: asString(payload.location),
    sellerPostcode: normalizeUkPostcode(payload.sellerPostcode),
    description: asString(payload.description),
    attentionGrabber: asString(payload.attentionGrabber).slice(0, 60),
    features: asStringArray(payload.features),
    images: asStringArray(payload.images).slice(0, 20),
    contactName: asString(payload.contactName),
    contactEmail: asString(payload.contactEmail).toLowerCase(),
    contactPhone: asString(payload.contactPhone),
    showEmail: asBoolean(payload.showEmail),
    showPhone: asBoolean(payload.showPhone),
    isFeatured: asBoolean(payload.isFeatured),
    recommendedPrice: asOptionalPositiveNumber(payload.recommendedPrice),
    valuationNote: asString(payload.valuationNote).slice(0, 500),
    motDueDate: asString(payload.motDueDate),
    serviceHistory: asString(payload.serviceHistory).toLowerCase(),
    seats: asOptionalPositiveNumber(payload.seats),
    doors: asOptionalPositiveNumber(payload.doors),
    previousOwners: asOptionalPositiveNumber(payload.previousOwners),
    keysCount: asOptionalPositiveNumber(payload.keysCount),
    co2Emissions: asString(payload.co2Emissions).slice(0, 40),
    insuranceGroup: asString(payload.insuranceGroup).slice(0, 20),
    fuelConsumptionUrban: asString(payload.fuelConsumptionUrban).slice(0, 40),
    fuelConsumptionExtraUrban: asString(payload.fuelConsumptionExtraUrban).slice(0, 40),
    fuelConsumptionCombined: asString(payload.fuelConsumptionCombined).slice(0, 40),
    lookupProvider: asString(payload.lookupProvider).slice(0, 80),
  };

  if (payload.vehicleHistory !== undefined) {
    const historyErrors = [];
    if (validateVehicleHistory(payload.vehicleHistory, historyErrors)) {
      listing.vehicleHistory = sanitizeVehicleHistory(payload.vehicleHistory);
    }
    errors.push(...historyErrors);
  }

  if (!allowPartial || payload.make !== undefined) {
    if (!listing.make) errors.push("Make is required.");
  }
  if (!allowPartial || payload.model !== undefined) {
    if (!listing.model) errors.push("Model is required.");
  }
  if (!allowPartial || payload.year !== undefined) {
    const currentYear = new Date().getFullYear() + 1;
    if (listing.year < 1900 || listing.year > currentYear) {
      errors.push("Year must be a valid vehicle year.");
    }
  }
  if (!allowPartial || payload.price !== undefined) {
    if (listing.price < 1) errors.push("Price must be greater than zero.");
  }
  if (!allowPartial || payload.mileage !== undefined) {
    if (listing.mileage < 0) errors.push("Mileage cannot be negative.");
  }
  if (!allowPartial || payload.fuelType !== undefined) {
    if (listing.fuelType && !FUEL_TYPES.includes(listing.fuelType)) {
      errors.push("Fuel type is not supported.");
    }
  }
  if (!allowPartial || payload.transmission !== undefined) {
    if (listing.transmission && !TRANSMISSIONS.includes(listing.transmission)) {
      errors.push("Transmission is not supported.");
    }
  }
  if (!allowPartial) {
    if (!listing.location) errors.push("Location is required.");
  }
  if (payload.sellerPostcode !== undefined && listing.sellerPostcode && !isValidUkPostcode(listing.sellerPostcode)) {
    errors.push("Enter a valid UK seller postcode.");
  }
  if (!allowPartial || payload.contactName !== undefined) {
    if (!listing.contactName) errors.push("Contact name is required.");
  }
  if (!allowPartial || payload.contactEmail !== undefined) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(listing.contactEmail)) {
      errors.push("A valid contact email is required.");
    }
  }
  if (listing.showPhone && !listing.contactPhone) {
    errors.push("Phone number is required when phone contact is public.");
  }
  if (payload.serviceHistory !== undefined && !SERVICE_HISTORY.includes(listing.serviceHistory)) {
    errors.push("Service history is not supported.");
  }

  const cleanListing = Object.fromEntries(Object.entries(listing).filter(([, value]) => value !== undefined));
  return {listing: cleanListing, errors};
}

function validatePublishListing(listing = {}) {
  const {errors} = validateListingPayload(listing);

  if (!Array.isArray(listing.images) || listing.images.length === 0) {
    errors.push("At least one vehicle photo is required.");
  }
  if (!asString(listing.description)) {
    errors.push("Description is required before publishing.");
  }
  if (!isValidUkPostcode(listing.sellerPostcode)) {
    errors.push("A valid seller postcode is required before publishing.");
  }

  return errors;
}

function hasActiveSubscription(profile = {}) {
  const activeStatuses = new Set(["active", "trialing"]);
  if (!activeStatuses.has(profile.subscriptionStatus)) return false;

  if (!profile.subscriptionCurrentPeriodEnd) return true;
  const periodEnd = typeof profile.subscriptionCurrentPeriodEnd?.toDate === "function"
    ? profile.subscriptionCurrentPeriodEnd.toDate()
    : new Date(profile.subscriptionCurrentPeriodEnd);

  return !Number.isNaN(periodEnd.getTime()) && periodEnd.getTime() > Date.now();
}

function validateSellerPublishRequirements({authUser = {}, profile = {}} = {}) {
  const errors = [];
  const emailVerified = authUser.email_verified === true || authUser.emailVerified === true || profile.emailVerified === true;
  const phoneVerified = Boolean(authUser.phone_number || authUser.phoneNumber || profile.phoneVerified);

  if (!hasActiveSubscription(profile)) {
    errors.push("An active MintMotor seller subscription is required before publishing.");
  }
  if (!emailVerified) {
    errors.push("Verify your email address before publishing.");
  }
  if (!phoneVerified) {
    errors.push("Verify your mobile number before publishing.");
  }

  return errors;
}

function validateEnquiryPayload(payload = {}) {
  const enquiry = {
    name: asString(payload.name),
    email: asString(payload.email).toLowerCase(),
    phone: asString(payload.phone),
    message: asString(payload.message),
  };

  const errors = [];
  if (!enquiry.name) errors.push("Name is required.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(enquiry.email)) {
    errors.push("A valid email is required.");
  }
  if (!enquiry.message || enquiry.message.length < 10) {
    errors.push("Message must be at least 10 characters.");
  }

  return {enquiry, errors};
}

function validateAdminCarPayload(payload = {}) {
  const patch = {};
  const errors = [];

  if (payload.status !== undefined) {
    if (!Object.values(LISTING_STATUS).includes(payload.status)) {
      errors.push("Listing status is not supported.");
    } else {
      patch.status = payload.status;
    }
  }

  if (payload.isFeatured !== undefined) {
    if (typeof payload.isFeatured !== "boolean") {
      errors.push("Featured must be true or false.");
    } else {
      patch.isFeatured = payload.isFeatured;
    }
  }

  if (payload.adminNote !== undefined) {
    patch.adminNote = asString(payload.adminNote).slice(0, 500);
  }

  return {patch, errors};
}

function validateAdminEnquiryPayload(payload = {}) {
  const patch = {};
  const errors = [];

  if (payload.status !== undefined) {
    if (!Object.values(ENQUIRY_STATUS).includes(payload.status)) {
      errors.push("Enquiry status is not supported.");
    } else {
      patch.status = payload.status;
    }
  }

  return {patch, errors};
}

function validateAdminUserPayload(payload = {}) {
  const patch = {};
  const errors = [];

  if (payload.role !== undefined) {
    if (!Object.values(USER_ROLES).includes(payload.role)) {
      errors.push("User role is not supported.");
    } else {
      patch.role = payload.role;
      patch.isAdmin = payload.role === USER_ROLES.ADMIN;
    }
  }

  if (payload.displayName !== undefined) {
    patch.displayName = asString(payload.displayName).slice(0, 120);
  }

  if (payload.phone !== undefined) {
    patch.phone = asString(payload.phone).slice(0, 40);
  }

  return {patch, errors};
}

module.exports = {
  LISTING_STATUS,
  ENQUIRY_STATUS,
  USER_ROLES,
  FUEL_TYPES,
  TRANSMISSIONS,
  SERVICE_HISTORY,
  normalizeUkPostcode,
  isValidUkPostcode,
  hasActiveSubscription,
  validateAdminCarPayload,
  validateAdminEnquiryPayload,
  validateAdminUserPayload,
  validateEnquiryPayload,
  validateListingPayload,
  validatePublishListing,
  validateSellerPublishRequirements,
  sanitizeVehicleHistory,
  selectVehicleHistoryForPublish,
  prepareVehicleHistoryUpdate,
};

