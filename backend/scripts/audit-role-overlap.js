// Read-only: lists accounts that are both a dealer and a main-site seller, which
// the role lock no longer allows. Resolve each one by hand before deploying.
const { admin, database } = require("../functions/firebase");

async function auditRoleOverlap() {
  const dealerIds = new Set();
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    for (const user of page.users) if (user.customClaims?.role === "dealer") dealerIds.add(user.uid);
    pageToken = page.pageToken;
  } while (pageToken);
  const dealers = await database.collection("dealers").get();
  for (const doc of dealers.docs) dealerIds.add(doc.id);

  const overlaps = [];
  for (const uid of dealerIds) {
    const [cars, profile] = await Promise.all([
      database.collection("cars").where("ownerId", "==", uid).get(),
      database.collection("users").doc(uid).get(),
    ]);
    const privateCars = cars.docs.filter((doc) => doc.data().sellerType === "private").map((doc) => ({ id: doc.id, status: doc.data().status, listingPlan: doc.data().listingPlan || "" }));
    const sellerSubscription = profile.exists ? profile.data().subscriptionStatus || "" : "";
    if (privateCars.length || ["active", "trialing", "past_due"].includes(sellerSubscription)) overlaps.push({ uid, privateCars, sellerSubscription });
  }
  console.log(JSON.stringify({ dealersChecked: dealerIds.size, overlaps }, null, 2));
}

auditRoleOverlap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
