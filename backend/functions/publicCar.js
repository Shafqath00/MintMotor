const { sanitizeVehicleHistory } = require("./validators");

function publicCar(car = {}) {
  const {lookupRaw, sellerPostcode, sellerGeo, vehicleHistory, ...publicListing} = car;
  const sanitizedHistory = sanitizeVehicleHistory(vehicleHistory);
  return {
    ...publicListing,
    ...(sanitizedHistory ? {vehicleHistory: sanitizedHistory} : {}),
    contactEmail: Boolean(car.showEmail) ? car.contactEmail : "",
    contactPhone: Boolean(car.showPhone) ? car.contactPhone : "",
  };
}

function safeVehicleLookup(lookup = {}) {
  const {lookupRaw, ...safeLookup} = lookup;
  return safeLookup;
}

module.exports = {publicCar, safeVehicleLookup};