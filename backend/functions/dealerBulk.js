const MAX_BULK_ROWS = 100;
const MAX_LOOKUP_REGISTRATIONS = 25;
const LOOKUP_CONCURRENCY = 5;
const REQUIRED_BULK_FIELDS = [
  ["registrationNumber", "Registration number"],
  ["make", "Make"],
  ["model", "Model"],
  ["year", "Year"],
  ["price", "Price"],
  ["mileage", "Mileage"],
];

function normalizeRegistration(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

// Validates every row independently so one bad spreadsheet line never blocks the rest.
function validateBulkRows(rows, { validateListingPayload, validateDealerPrivatePayload, existingRegistrations = new Set() }) {
  if (!Array.isArray(rows) || rows.length === 0) return { error: "Add at least one vehicle." };
  if (rows.length > MAX_BULK_ROWS) return { error: `Upload up to ${MAX_BULK_ROWS} vehicles at a time.` };
  const seen = new Set();
  const results = rows.map((row, index) => {
    const payload = row && typeof row === "object" ? row : {};
    const { listing, errors } = validateListingPayload(payload, { partial: true });
    const { privateData, errors: privateErrors } = validateDealerPrivatePayload(payload);
    const rowErrors = [...errors, ...privateErrors];
    for (const [field, label] of REQUIRED_BULK_FIELDS) {
      if (listing[field] === undefined || listing[field] === "" || listing[field] === null) rowErrors.push(`${label} is required.`);
    }
    const registration = normalizeRegistration(listing.registrationNumber);
    if (registration && existingRegistrations.has(registration)) rowErrors.push("This registration is already in your inventory.");
    if (registration && seen.has(registration)) rowErrors.push("This registration appears more than once in the upload.");
    if (registration) seen.add(registration);
    return rowErrors.length ? { row: index + 1, errors: rowErrors } : { row: index + 1, listing, privateData };
  });
  return { results };
}

function validateLookupRequest(vehicles) {
  if (!Array.isArray(vehicles) || vehicles.length === 0) return "Add at least one registration.";
  if (vehicles.length > MAX_LOOKUP_REGISTRATIONS) return `Look up to ${MAX_LOOKUP_REGISTRATIONS} registrations at a time.`;
  return "";
}

// Each paid lookup is isolated: a failed registration is reported and the rest still resolve.
async function lookupRegistrations(vehicles, { lookupVehicle, safeVehicleLookup, concurrency = LOOKUP_CONCURRENCY }) {
  const results = new Array(vehicles.length);
  let next = 0;
  async function worker() {
    while (next < vehicles.length) {
      const index = next++;
      const registrationNumber = normalizeRegistration(vehicles[index]?.registrationNumber);
      const mileage = Number(vehicles[index]?.mileage);
      if (!registrationNumber) { results[index] = { registrationNumber, error: "Registration number is required." }; continue; }
      if (!Number.isFinite(mileage) || mileage < 0) { results[index] = { registrationNumber, error: "Enter a valid mileage." }; continue; }
      try {
        results[index] = { registrationNumber, vehicle: safeVehicleLookup(await lookupVehicle({ registrationNumber, mileage })) };
      } catch (error) {
        results[index] = { registrationNumber, error: error.statusCode && error.statusCode < 500 ? error.message : "We could not look up this vehicle." };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, vehicles.length) }, worker));
  return results;
}

module.exports = { MAX_BULK_ROWS, MAX_LOOKUP_REGISTRATIONS, normalizeRegistration, validateBulkRows, validateLookupRequest, lookupRegistrations };
