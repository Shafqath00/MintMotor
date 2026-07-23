class VehicleLookupError extends Error {
  constructor(message, statusCode = 500, details = undefined) {
    super(message);
    this.name = "VehicleLookupError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

const SEEDED_VEHICLES = {
  PL65VNG: {
    registrationNumber: "PL65VNG",
    make: "Land Rover",
    model: "Range Rover Sport",
    variant: "3.0 SD V6 Autobiography Dynamic Auto 4WD Euro 6 (s/s) 5dr",
    year: 2016,
    fuelType: "Diesel",
    transmission: "Automatic",
    bodyType: "SUV",
    engineSize: "3.0L",
    color: "White",
    dateOfFirstRegistration: "2016-02-22",
    motDueDate: "2027-07-03",
    seats: 5,
    doors: 5,
    co2Emissions: "185g/km",
    insuranceGroup: "49E",
    fuelConsumptionUrban: "35.8 mpg",
    fuelConsumptionExtraUrban: "44.1 mpg",
    fuelConsumptionCombined: "40.4 mpg",
    features: [
      "18-Way Driver and Passenger Seats",
      "21in Alloy Wheels",
      "Bluetooth Audio Streaming",
      "Climate Control",
      "Parking Camera",
      "Heated Seats",
    ],
    basePrice: 15170,
  },
};

function normalizeRegistration(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function asText(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim() || fallback;
}

function asNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = typeof value === "string" ? value.replace(/,/g, "") : value;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : fallback;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function titleCase(value) {
  return asText(value)
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeFuelType(value) {
  const text = titleCase(value);
  if (["Petrol", "Diesel", "Electric", "Hybrid"].includes(text)) return text;
  if (text.includes("Hybrid")) return "Hybrid";
  if (text.includes("Electric")) return "Electric";
  return text || "Petrol";
}

function normalizeTransmission(value) {
  const text = asText(value).toLowerCase();
  return text.includes("manual") ? "Manual" : "Automatic";
}

function isoDate(value) {
  if (!value) return "";
  const raw = String(value);
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  const ukMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (ukMatch) return `${ukMatch[3]}-${ukMatch[2]}-${ukMatch[1]}`;
  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  return raw.slice(0, 10);
}

function mpg(value) {
  const number = asNumber(value, 0);
  return number > 0 ? `${number} mpg` : "";
}

function gramsPerKm(value) {
  const number = asNumber(value, 0);
  return number > 0 ? `${number}g/km` : "";
}

function calculateRecommendedPrice(vehicle, mileage) {
  const numericMileage = Number.isFinite(Number(mileage)) ? Number(mileage) : 0;
  const basePrice = asNumber(vehicle.basePrice || vehicle.recommendedPrice || vehicle.price, 0);
  if (!basePrice) {
    return Math.max(1000, Math.round((18000 - numericMileage * 0.04) / 100) * 100);
  }

  const baseMileage = asNumber(vehicle.baseMileage, 90000);
  const mileageDelta = baseMileage - numericMileage;
  const mileageAdjustment = Math.round(mileageDelta * 0.035);
  return Math.max(500, Math.round((basePrice + mileageAdjustment) / 10) * 10);
}

function findMotDueDate(dataItems = {}, response = {}) {
  return isoDate(firstValue(
    dataItems.VehicleStatus?.MotVed?.MotDue,
    dataItems.MotHistory?.MotDueDate,
    dataItems.MotHistory?.MotDue,
    response.MotHistory?.MotDueDate,
    response.VehicleStatus?.MotVed?.MotDue,
  ));
}

function findValuation(response = {}, dataItems = {}) {
  const valuation = dataItems.Valuation || dataItems.Valuations || response.Valuation || response.Valuations || {};
  const candidates = [
    valuation.Retail,
    valuation.RetailValue,
    valuation.PrivateSale,
    valuation.PrivateSaleValue,
    valuation.Clean,
    valuation.Average,
    valuation.Valuation,
    valuation.Value,
    valuation.CurrentValue,
    valuation.MarketValue,
  ];
  return asNumber(firstValue(...candidates), 0);
}

function findImages(response = {}, dataItems = {}) {
  const imageData = dataItems.VehicleImages || dataItems.Images || response.VehicleImages || response.Images || {};
  const list = Array.isArray(imageData) ? imageData : imageData.ImageList || imageData.Images || [];
  if (Array.isArray(list)) {
    return list.map((item) => asText(item.Url || item.ImageUrl || item.UrlFull || item)).filter(Boolean).slice(0, 20);
  }
  return [imageData.Url, imageData.ImageUrl, imageData.UrlFull].map(asText).filter(Boolean).slice(0, 20);
}

function findFeatures(response = {}, dataItems = {}) {
  const specs = dataItems.SpecificationAndOptions || dataItems.Specification || response.SpecificationAndOptions || response.Specification || {};
  const list = specs.OptionList || specs.Options || specs.FeatureList || specs.Features || [];
  if (Array.isArray(list)) {
    return list
      .map((item) => asText(item.Description || item.Name || item.OptionName || item))
      .filter(Boolean)
      .slice(0, 80);
  }
  return [];
}

function historyStatus(value) {
  if (value === true || value === false) return value ? "recorded" : "clear";
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? (value > 0 ? "recorded" : "clear") : "unavailable";
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "recorded", "alert"].includes(normalized)) return "recorded";
    if (["false", "no", "clear"].includes(normalized)) return "clear";
    if (/^\d+$/.test(normalized)) return Number(normalized) > 0 ? "recorded" : "clear";
    return "unavailable";
  }
  if (!value || typeof value !== "object") return "unavailable";

  const count = firstValue(value.RecordCount, value.Count, value.Total);
  if (count !== undefined) return historyStatus(count);
  if (value.Value !== undefined) return historyStatus(value.Value);
  if (value.Status !== undefined) return historyStatus(value.Status);
  return "unavailable";
}

function historyItem(label, value, detail = "") {
  const status = historyStatus(value);
  return {
    status,
    label,
    ...(status === "unavailable" ? {detail: detail || "Not supplied by provider"} : detail || value?.Message ? {detail: detail || asText(value.Message)} : {}),
  };
}

function validIsoDate(value) {
  const date = isoDate(value);
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";

  const [year, month, day] = match.slice(1).map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  return calendarDate.getUTCFullYear() === year
    && calendarDate.getUTCMonth() === month - 1
    && calendarDate.getUTCDate() === day
    ? date
    : "";
}

function optionalNonNegativeNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = asNumber(value, NaN);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function normalizeMotResult(value) {
  const result = asText(value).toLowerCase();
  if (["pass", "passed"].includes(result)) return "passed";
  if (["fail", "failed"].includes(result)) return "failed";
  return undefined;
}

function explicitMotStatus(mot = {}) {
  const status = asText(firstValue(mot.Status, mot.MotStatus, mot.ResultStatus)).toLowerCase();
  if (["not found", "not-found", "no record"].includes(status)) return "not-found";
  if (["valid", "current", "active"].includes(status)) return "valid";
  if (status === "expired") return "expired";
  return undefined;
}

function mapMotSummary(mot = {}, checkedAt = new Date().toISOString()) {
  const expiryDate = validIsoDate(firstValue(mot.MotDueDate, mot.MotDue));
  const latestTestDate = validIsoDate(mot.LatestTestDate);
  const latestMileage = optionalNonNegativeNumber(mot.LatestMileage);
  const advisoryCount = optionalNonNegativeNumber(mot.AdvisoryCount);
  const failureCount = optionalNonNegativeNumber(mot.FailureCount);
  const latestResult = normalizeMotResult(mot.LatestResult);
  const providerStatus = explicitMotStatus(mot);
  const status = providerStatus || (expiryDate ? (expiryDate >= String(checkedAt).slice(0, 10) ? "valid" : "expired") : "unavailable");

  return {
    status,
    ...(expiryDate ? {expiryDate} : {}),
    ...(latestMileage !== undefined ? {latestMileage} : {}),
    ...(latestTestDate ? {latestTestDate} : {}),
    ...(latestResult ? {latestResult} : {}),
    ...(advisoryCount !== undefined ? {advisoryCount} : {}),
    ...(failureCount !== undefined ? {failureCount} : {}),
  };
}

function mapVehicleHistory(response, registrationNumber, checkedAt = new Date().toISOString()) {
  const dataItems = response?.DataItems || response?.dataItems || {};
  const source = dataItems.VdiCheck || dataItems.VDICheck || dataItems.VehicleHistory
    || response?.VdiCheck || response?.VDICheck || response?.VehicleHistory || {};
  const items = {
    outstandingFinance: historyItem("Outstanding finance", source.Finance ?? source.OutstandingFinance),
    stolen: historyItem("Stolen vehicle", source.Stolen),
    writtenOff: historyItem("Insurance write-off", source.WrittenOff ?? source.WriteOff),
    scrapped: historyItem("Scrapped", source.Scrapped),
    imported: historyItem("Imported", source.Imported),
    exported: historyItem("Exported", source.Exported),
    mileageAnomaly: historyItem("Mileage anomaly", source.Mileage?.IsAnomaly ?? source.MileageAnomaly),
    colourChanges: historyItem("Colour changes", source.ColourChanges),
    plateChanges: historyItem("Registration plate changes", source.PlateChanges),
  };
  const statuses = Object.values(items).map((item) => item.status);
  const mot = dataItems.MotHistory || response?.MotHistory || {};

  return {
    provider: "ukvehicledata",
    checkedAt,
    registrationNumber: normalizeRegistration(registrationNumber),
    summaryStatus: statuses.includes("recorded") ? "attention" : statuses.every((status) => status === "clear") ? "clear" : "unavailable",
    ...items,
    mot: mapMotSummary(mot, checkedAt),
  };
}
function mapUkvdResponse(payload, {registrationNumber, mileage}) {
  const response = payload?.Response || payload?.response || payload || {};
  const registration = response.VehicleRegistration || response.vehicleRegistration || {};
  const smmt = response.SmmtDetails || response.SMMTDetails || response.smmtDetails || {};
  const dataItems = response.DataItems || response.dataItems || {};
  const technical = dataItems.TechnicalDetails || dataItems.technicalDetails || {};
  const dimensions = technical.Dimensions || {};
  const consumption = technical.Consumption || {};
  const classification = dataItems.ClassificationDetails || {};

  const make = titleCase(firstValue(registration.Make, smmt.Marque, smmt.Make, classification.Smmt?.Make));
  const model = titleCase(firstValue(smmt.Range, registration.Model, classification.Dvla?.Model));
  const variant = asText(firstValue(smmt.ModelVariant, registration.MakeModelCombined, registration.Model));
  const recommendedFromProvider = findValuation(response, dataItems);
  const baseVehicle = {
    recommendedPrice: recommendedFromProvider,
    basePrice: recommendedFromProvider,
    baseMileage: asNumber(firstValue(dataItems.MotHistory?.LatestMileage, response.MotHistory?.LatestMileage), 90000),
  };
  const recommendedPrice = calculateRecommendedPrice(baseVehicle, mileage);

  if (!make && !model) {
    throw new VehicleLookupError("Vehicle not found for that registration number.", 404, payload);
  }

  return {
    registrationNumber: normalizeRegistration(firstValue(registration.Vrm, registration.VRM, registrationNumber)),
    make,
    model,
    variant,
    year: asNumber(firstValue(registration.YearOfManufacture, registration.yearOfManufacture), new Date().getFullYear()),
    price: recommendedPrice,
    mileage: Number(mileage) || 0,
    fuelType: normalizeFuelType(firstValue(registration.FuelType, registration.Fuel, smmt.FuelType)),
    transmission: normalizeTransmission(firstValue(smmt.Transmission, registration.Transmission, registration.TransmissionType)),
    bodyType: titleCase(firstValue(technical.Dimensions?.BodyShape, smmt.BodyStyle, registration.DoorPlanLiteral)) || "SUV",
    engineSize: asNumber(firstValue(smmt.NominalEngineCapacity, registration.EngineCapacity, smmt.EngineCapacity), 0)
      ? `${asNumber(firstValue(smmt.NominalEngineCapacity, registration.EngineCapacity, smmt.EngineCapacity), 0) >= 100 ? (asNumber(firstValue(smmt.NominalEngineCapacity, registration.EngineCapacity, smmt.EngineCapacity), 0) / 1000).toFixed(1) : asNumber(firstValue(smmt.NominalEngineCapacity, registration.EngineCapacity, smmt.EngineCapacity), 0)}L`
      : "",
    color: titleCase(firstValue(registration.Colour, registration.Color)),
    dateOfFirstRegistration: isoDate(firstValue(registration.DateFirstRegistered, registration.DateFirstRegisteredUk)),
    motDueDate: findMotDueDate(dataItems, response),
    seats: asNumber(firstValue(registration.SeatingCapacity, dimensions.NumberOfSeats), undefined),
    doors: asNumber(firstValue(smmt.NumberOfDoors, registration.NumberOfDoors), undefined),
    co2Emissions: gramsPerKm(firstValue(registration.Co2Emissions, technical.Performance?.Co2, dataItems.VehicleStatus?.MotVed?.VedCo2Emissions)),
    insuranceGroup: asText(firstValue(dataItems.InsuranceDetails?.Group, response.InsuranceDetails?.Group, registration.AbiBrokerNetCode)),
    fuelConsumptionUrban: mpg(consumption.UrbanCold?.Mpg),
    fuelConsumptionExtraUrban: mpg(consumption.ExtraUrban?.Mpg),
    fuelConsumptionCombined: mpg(consumption.Combined?.Mpg),
    recommendedPrice,
    valuationNote: recommendedFromProvider
      ? `UK Vehicle Data valuation adjusted for seller mileage of ${(Number(mileage) || 0).toLocaleString("en-GB")} miles.`
      : `UK Vehicle Data details found. Add your asking price or use this starter valuation adjusted for ${(Number(mileage) || 0).toLocaleString("en-GB")} miles.`,
    images: findImages(response, dataItems),
    features: findFeatures(response, dataItems),
    location: "",
    sellerPostcode: "",
    description: "",
    attentionGrabber: "",
    contactName: "",
    contactEmail: "",
    contactPhone: "",
    showEmail: false,
    showPhone: false,
    isFeatured: false,
    isNew: false,
    lookupProvider: "ukvehicledata",
    vehicleHistory: mapVehicleHistory(response, registrationNumber),
  };
}

function buildUkvdUrl(vrm) {
  const apiKey = process.env.UKVD_API_KEY;
  const packageId = process.env.UKVD_PACKAGE_ID;
  if (!apiKey || !packageId) return "";

  const baseUrl = (process.env.UKVD_API_BASE_URL || "https://uk1.ukvehicledata.co.uk/api/datapackage").replace(/\/$/, "");
  const url = new URL(`${baseUrl}/${encodeURIComponent(packageId)}`);
  url.searchParams.set("v", "2");
  url.searchParams.set("api_nullitems", "1");
  url.searchParams.set("auth_apikey", apiKey);
  url.searchParams.set("key_VRM", vrm);
  return url.toString();
}

async function fetchUkvdVehicle(registrationNumber) {
  const normalized = normalizeRegistration(registrationNumber);
  const url = buildUkvdUrl(normalized);
  if (!url) return null;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: process.env.UKVD_API_KEY,
    },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const statusCode = response.status === 404 ? 404 : 502;
    throw new VehicleLookupError("Unable to fetch vehicle details from UK Vehicle Data.", statusCode, payload);
  }

  const lookupStatus = payload?.Response?.StatusInformation?.Lookup?.StatusCode || payload?.Response?.StatusCode;
  if (lookupStatus && !/^success$/i.test(String(lookupStatus))) {
    throw new VehicleLookupError("Vehicle not found for that registration number.", 404, payload);
  }

  return payload;
}

function seededLookup(registrationNumber, mileage, reason = "") {
  const normalized = normalizeRegistration(registrationNumber);
  const seeded = SEEDED_VEHICLES[normalized] || null;

  if (!seeded) {
    return {
      registrationNumber: normalized,
      mileage: Number(mileage) || 0,
      lookupProvider: "manual-fallback",
      recommendedPrice: Math.max(1000, Math.round((18000 - (Number(mileage) || 0) * 0.04) / 100) * 100),
      valuationNote: reason || "We could not match this registration yet. Add the vehicle details manually and use this as a starter valuation.",
      features: [],
    };
  }

  const recommendedPrice = calculateRecommendedPrice(seeded, mileage);
  return {
    ...seeded,
    registrationNumber: normalized,
    mileage: Number(mileage) || 0,
    price: recommendedPrice,
    recommendedPrice,
    location: "",
    sellerPostcode: "",
    description: "",
    attentionGrabber: "",
    contactName: "",
    contactEmail: "",
    contactPhone: "",
    showEmail: false,
    showPhone: false,
    images: [],
    isFeatured: false,
    isNew: false,
    lookupProvider: "seeded-fallback",
    valuationNote: reason || `Recommended from registration details and mileage of ${(Number(mileage) || 0).toLocaleString("en-GB")} miles.`,
  };
}

async function lookupVehicle({registrationNumber, mileage}) {
  const normalized = normalizeRegistration(registrationNumber);

  try {
    const ukvdPayload = await fetchUkvdVehicle(normalized);
    if (ukvdPayload) return mapUkvdResponse(ukvdPayload, {registrationNumber: normalized, mileage});
    return seededLookup(normalized, mileage, "UK Vehicle Data is not configured yet. Add UKVD_API_KEY and UKVD_PACKAGE_ID to enable live lookup.");
  } catch (error) {
    if (error instanceof VehicleLookupError && error.statusCode === 404) throw error;
    return seededLookup(normalized, mileage, "UK Vehicle Data is temporarily unavailable. You can continue by editing the draft manually.");
  }
}

module.exports = {
  VehicleLookupError,
  lookupVehicle,
  normalizeRegistration,
  mapUkvdResponse,
  mapVehicleHistory,
  buildUkvdUrl,
};
