const ALLOWED_STATUSES = new Set(["published", "draft"]);
const MAX_BATCH_WRITES = 400;

async function updateScsStockStatus({ database, status, timestamp }) {
  if (!ALLOWED_STATUSES.has(status)) {
    throw new Error("SCS stock status must be published or draft.");
  }

  const snapshot = await database.collection("cars").where("source", "==", "scs-cars").get();

  for (let offset = 0; offset < snapshot.docs.length; offset += MAX_BATCH_WRITES) {
    const batch = database.batch();
    const docs = snapshot.docs.slice(offset, offset + MAX_BATCH_WRITES);

    for (const doc of docs) {
      const patch = { status, updatedAt: timestamp };
      if (status === "published" && !doc.data().publishedAt) {
        patch.publishedAt = timestamp;
      }
      batch.set(doc.ref, patch, { merge: true });
    }

    await batch.commit();
  }

  return { count: snapshot.docs.length, status };
}

module.exports = { updateScsStockStatus };
