const { isLegacyPublicAdvert } = require('./sellerRetirement');

async function protectExistingSellerMedia({ database, storageStatusDatabase, bucket, dryRun, now = Date.now() }) {
  const { prepareSellerListingImages, finalizeSellerListingImages } = require('./sellerMedia');
  const report = { dryRun, protected: [], deferredPublic: [], errors: [] };
  let after;
  do {
    let query = database.collection('cars').orderBy('__name__').limit(200);
    if (after) query = query.startAfter(after);
    const page = await query.get();
    for (const listing of page.docs) {
      const car = listing.data();
      if (car.sellerType !== 'private' || car.ownerType === 'dealer' || car.dealerId) continue;
      if (isLegacyPublicAdvert(car, now)) { report.deferredPublic.push(listing.id); continue; }
      if (dryRun) { report.protected.push({ id: listing.id, status: 'unverified' }); continue; }
      const progressRef = database.collection('sellerPlanRetirementMedia').doc(listing.id);
      try {
        let progress = (await progressRef.get()).data();
        // Keep the old source manifest until revocation succeeds, including after
        // a crash between car persistence and source deletion.
        if (!progress?.plan || progress.status === 'complete') {
          const plan = await prepareSellerListingImages({ bucket, car: { ...car, images: car.images || [] }, carId: listing.id, dryRun: false });
          progress = { status: 'prepared', plan, inputImages: car.images || [], updatedAt: new Date(now) };
          await progressRef.set(progress);
        }
        const persisted = await database.runTransaction(async transaction => {
          const current = await transaction.get(listing.ref); const value = current.data();
          if (!current.exists || isLegacyPublicAdvert(value, now) || value.sellerType !== 'private' || value.ownerId !== progress.plan.ownerId) throw new Error('Listing ownership or public entitlement changed; manual review required');
          const actual = JSON.stringify(value.images || []);
          if (actual !== JSON.stringify(progress.inputImages) && actual !== JSON.stringify(progress.plan.images)) throw new Error('Listing photos changed during migration; manual review required');
          transaction.update(listing.ref, { images: progress.plan.images, updatedAt: new Date(now) });
          return { ...value, images: progress.plan.images };
        });
        const [user, deletion] = await Promise.all([database.collection('users').doc(persisted.ownerId).get(), database.collection('accountDeletionRequests').doc(persisted.ownerId).get()]);
        const profile = user.data() || {};
        const accountActive = !['pending', 'finalizing', 'completed'].includes(deletion.data()?.status) && !profile.deletedAt && profile.disabled !== true && !['deleted', 'disabled', 'suspended'].includes(profile.status);
        await storageStatusDatabase.collection('storageSellerListings').doc(listing.id).set({ ownerId: persisted.ownerId, sellerType: persisted.sellerType, listingPlan: persisted.listingPlan, visibility: persisted.visibility, status: persisted.status, legacyPublicUntil: persisted.legacyPublicUntil || null, accountActive }, { merge: true });
        await finalizeSellerListingImages({ bucket, plan: progress.plan, persistedImages: persisted.images, dryRun: false });
        await progressRef.set({ status: 'complete', lastError: null, updatedAt: new Date(now) }, { merge: true });
        report.protected.push({ id: listing.id, status: 'complete' });
      } catch (error) {
        await progressRef.set({ lastError: error.message, updatedAt: new Date(now) }, { merge: true });
        report.errors.push({ id: listing.id, error: error.message });
      }
    }
    if (page.docs.length < 200) break;
    after = page.docs.at(-1);
  } while (true);
  return report;
}

module.exports = { protectExistingSellerMedia };
