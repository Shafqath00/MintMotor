// Listing moderation (hide / reject / restore) and the complaints people raise about listings.
const MODERATION_STATUS = Object.freeze({ OK: "ok", HIDDEN: "hidden", REJECTED: "rejected" });
const REPORT_REASONS = Object.freeze(["scam", "wrong_info", "inappropriate", "already_sold", "duplicate", "other"]);
const REPORT_STATUS = Object.freeze({ OPEN: "open", REVIEWING: "reviewing", RESOLVED: "resolved", DISMISSED: "dismissed" });
const REPORTS_PER_HOUR = 5;

// Hidden and rejected cars disappear from the main site, the dealer site and image delivery.
const isModeratedOut = (car) => car?.moderationStatus === MODERATION_STATUS.HIDDEN || car?.moderationStatus === MODERATION_STATUS.REJECTED;

// Suspending an account hides its cars; reactivating restores only the ones the suspension hid.
async function setOwnerSuspensionHide({ database, FieldValue, ownerField, ownerId, actorUid, hide }) {
  const snapshot = await database.collection("cars").where(ownerField, "==", ownerId).get();
  let affected = 0;
  for (const doc of snapshot.docs) {
    const car = doc.data();
    if (hide && !isModeratedOut(car)) {
      await doc.ref.set({ moderationStatus: MODERATION_STATUS.HIDDEN, moderationReason: "Account suspended", moderatedBy: actorUid, moderatedAt: FieldValue.serverTimestamp(), hiddenBySuspension: true }, { merge: true });
      affected += 1;
    } else if (!hide && car.hiddenBySuspension === true) {
      await doc.ref.set({ moderationStatus: MODERATION_STATUS.OK, moderationReason: "", moderatedBy: actorUid, moderatedAt: FieldValue.serverTimestamp(), hiddenBySuspension: false }, { merge: true });
      affected += 1;
    }
  }
  return affected;
}

function validateModeration(body = {}) {
  const action = String(body.action || "");
  const reason = String(body.reason || "").trim().slice(0, 500);
  const errors = [];
  if (!["hide", "reject", "restore"].includes(action)) errors.push("Choose hide, reject or restore.");
  if ((action === "hide" || action === "reject") && reason.length < 5) errors.push("Give a reason of at least 5 characters so the team can see why.");
  return { action, reason, errors };
}

function moderationPatch(action, reason, actorUid, FieldValue) {
  const status = action === "hide" ? MODERATION_STATUS.HIDDEN : action === "reject" ? MODERATION_STATUS.REJECTED : MODERATION_STATUS.OK;
  return {
    moderationStatus: status,
    moderationReason: status === MODERATION_STATUS.OK ? "" : reason,
    moderatedBy: actorUid,
    moderatedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function validateReport(body = {}) {
  const reason = String(body.reason || "");
  const message = String(body.message || "").trim().slice(0, 1000);
  const errors = [];
  if (!REPORT_REASONS.includes(reason)) errors.push("Choose a reason for your report.");
  if (reason === "other" && message.length < 10) errors.push("Tell us a little more (at least 10 characters).");
  return { report: { reason, message }, errors };
}

// One open report per person per car, and a small hourly cap, so the queue can't be flooded.
async function createReport({ database, FieldValue, carId, car, reporter, body, site, now = () => Date.now() }) {
  const { report, errors } = validateReport(body);
  if (errors.length) return { errors };
  const mine = await database.collection("listingReports").where("reporterKey", "==", reporter.key).get();
  const existing = mine.docs.map((doc) => doc.data());
  if (existing.some((row) => row.carId === carId && [REPORT_STATUS.OPEN, REPORT_STATUS.REVIEWING].includes(row.status))) return { duplicate: true };
  if (existing.filter((row) => now() - (row.createdAtMs || 0) < 3_600_000).length >= REPORTS_PER_HOUR) return { rateLimited: true };
  const ref = database.collection("listingReports").doc();
  await ref.set({
    carId, carLabel: [car.year, car.make, car.model].filter(Boolean).join(" "), ownerId: car.ownerId || "", sellerType: car.sellerType || "",
    ...report, site, status: REPORT_STATUS.OPEN,
    reporterKey: reporter.key, reporterUid: reporter.uid || "", reporterEmail: reporter.email || "",
    createdAt: FieldValue.serverTimestamp(), createdAtMs: now(),
  });
  return { id: ref.id };
}

function serializeReport(snapshot) {
  const data = typeof snapshot.data === "function" ? snapshot.data() : snapshot;
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  return {
    id: snapshot.id, carId: data.carId || "", carLabel: data.carLabel || "", ownerId: data.ownerId || "", sellerType: data.sellerType || "",
    reason: data.reason || "", message: data.message || "", site: data.site || "main", status: data.status || REPORT_STATUS.OPEN,
    reporterUid: data.reporterUid || "", reporterEmail: data.reporterEmail || "",
    resolutionNote: data.resolutionNote || "", resolvedBy: data.resolvedBy || "",
    createdAt: iso(data.createdAtMs), resolvedAt: iso(data.resolvedAtMs),
  };
}

function validateReportReview(body = {}) {
  const errors = [];
  const patch = {};
  if (!Object.values(REPORT_STATUS).includes(body.status)) errors.push("Choose a status for this complaint.");
  else patch.status = body.status;
  const note = String(body.note || "").trim().slice(0, 1000);
  if ([REPORT_STATUS.RESOLVED, REPORT_STATUS.DISMISSED].includes(patch.status) && note.length < 3) errors.push("Add a short note explaining the outcome.");
  patch.resolutionNote = note;
  return { patch, errors };
}

module.exports = { setOwnerSuspensionHide, MODERATION_STATUS, REPORT_REASONS, REPORT_STATUS, REPORTS_PER_HOUR, isModeratedOut, validateModeration, moderationPatch, validateReport, createReport, serializeReport, validateReportReview };
