function normalizeReport(report) {
  return JSON.parse(JSON.stringify(report));
}

function createVehicleCheckStore({database, fetchReport, now = () => new Date().toISOString()}) {
  function reportsFor(uid) {
    return database.collection("users").doc(uid).collection("vehicleChecks");
  }

  return {
    async create(uid, registrationNumber) {
      const report = normalizeReport(await fetchReport(registrationNumber, now()));
      const doc = reportsFor(uid).doc();
      await doc.set(report);
      return {id: doc.id, ...report};
    },
    async list(uid) {
      const snapshot = await reportsFor(uid).orderBy("checkedAt", "desc").get();
      return snapshot.docs.map((doc) => ({id: doc.id, ...doc.data()}));
    },
    async get(uid, reportId) {
      const snapshot = await reportsFor(uid).doc(reportId).get();
      return snapshot.exists ? {id: snapshot.id, ...snapshot.data()} : null;
    },
  };
}

module.exports = {createVehicleCheckStore};