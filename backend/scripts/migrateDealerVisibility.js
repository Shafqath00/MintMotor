const { admin, database } = require("../functions/firebase");
const isDryRun = process.argv.includes("--dry-run");
async function migrateDealerVisibility() {
  console.log(`Starting dealer cars visibility migration...${isDryRun ? " (DRY RUN)" : ""}`);
  
  const snapshot = await database.collection("cars")
    .where("sellerType", "==", "dealer")
    .where("visibility", "==", "dealer-network")
    .get();
    
  if (snapshot.empty) {
    console.log("No dealer cars found requiring migration. (Idempotent run)");
    return;
  }

  console.log(`Found ${snapshot.size} dealer cars to migrate.`);

  let migratedCount = 0;
  let batch = database.batch();
  let batchCount = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    
    // Safety check: Ensure it's actually a dealer vehicle and not a private seller's dealer-network-free car
    if (data.sellerType === "dealer") {
      migratedCount++;
      if (isDryRun) {
        console.log(`[DRY RUN] Would update: Car ID: ${doc.id}, Dealer ID: ${data.dealerId}, visibility: dealer-network -> public`);
      } else {
        batch.update(doc.ref, {
          visibility: "public",
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        batchCount++;

        // Commit in batches of 500 (Firestore limit)
        if (batchCount === 500) {
          await batch.commit();
          batch = database.batch();
          batchCount = 0;
        }
      }
    }
  }

  if (!isDryRun && batchCount > 0) {
    await batch.commit();
  }

  if (isDryRun) {
    console.log(`[DRY RUN] Complete. ${migratedCount} dealer cars would be updated.`);
  } else {
    console.log(`Migration complete. Successfully updated visibility to "public" for ${migratedCount} dealer cars.`);
  }
}

migrateDealerVisibility().then(() => process.exit(0)).catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
