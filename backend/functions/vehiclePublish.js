async function refreshVehicleDataForPublish({
  car,
  lookupVehicle,
  selectVehicleHistoryForPublish,
  logger,
}) {
  let lookup = { lookupProvider: "unavailable" };

  try {
    lookup = await lookupVehicle({
      registrationNumber: car.registrationNumber,
      mileage: car.mileage,
    });
  } catch (error) {
    lookup = {
      lookupProvider: error?.statusCode === 404 ? "not-found" : "unavailable",
    };
    logger.warn("Unable to refresh vehicle history before publishing", error);
  }

  return selectVehicleHistoryForPublish({
    lookup,
    currentHistory: car.vehicleHistory,
    currentHistoryVerified: car.vehicleHistoryVerified === true,
    registrationNumber: car.registrationNumber,
  });
}

module.exports = { refreshVehicleDataForPublish };
