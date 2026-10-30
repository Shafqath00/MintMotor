// Retirement grants are written once by the migration, never by Stripe webhooks.
const RETIREMENT_ID = 'seller-plan-retirement-v1';
const MIGRATIONS = 'platformMigrations';
const PROGRESS = 'sellerPlanRetirementSubscriptions';

function millis(value) {
  if (value?.toMillis) return value.toMillis();
  if (value?.toDate) return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value);
  return NaN;
}
function privatePublic(car = {}) {
  return car.sellerType === 'private' && car.ownerType !== 'dealer' && !car.dealerId && car.listingPlan === 'public-subscription' && car.visibility === 'public' && car.status === 'published';
}
function isLegacyPublicAdvert(car = {}, now = Date.now()) {
  return privatePublic(car) && Number.isFinite(millis(car.legacyPublicUntil)) && millis(car.legacyPublicUntil) > millis(now);
}
function objectId(value) { return typeof value === 'string' ? value : value?.id; }
function isDealerSubscription(subscription = {}) { return Boolean(subscription.metadata?.dealerTierKey || subscription.metadata?.role === 'dealer'); }

// invoice.period_end is NOT the purchased service period; use the paid recurring line.
function paidPublicUntilFromInvoice(subscription, invoice, cutoff) {
  if (!['active', 'past_due', 'unpaid', 'canceled', 'paused'].includes(subscription?.status) || isDealerSubscription(subscription)) return null;
  if (invoice?.status !== 'paid' || !(invoice.amount_paid > 0) || !(invoice.status_transitions?.paid_at > 0) || invoice.status_transitions.paid_at * 1000 > millis(cutoff)) return null;
  const invoiceSubscription = objectId(invoice.subscription) || objectId(invoice.parent?.subscription_details?.subscription);
  if (invoiceSubscription && invoiceSubscription !== subscription.id) return null;
  const ends = (invoice.lines?.data || []).flatMap(line => {
    const details = line.parent?.subscription_item_details;
    const lineSubscription = objectId(line.subscription) || objectId(details?.subscription) || invoiceSubscription;
    const itemId = objectId(line.subscription_item) || objectId(details?.subscription_item);
    const item = subscription.items?.data?.find(candidate => candidate.id === itemId);
    if (lineSubscription !== subscription.id || !(line.amount > 0) || line.proration || details?.proration || !(line.type === 'subscription' || details || item)) return [];
    const start = line.period?.start * 1000;
    const end = line.period?.end * 1000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > millis(cutoff) || end <= millis(cutoff) || end <= start) return [];
    const boundary = (item?.current_period_end || subscription.current_period_end) * 1000;
    return [Number.isFinite(boundary) ? Math.min(end, boundary) : end];
  });
  return ends.length ? Math.max(...ends) : null;
}
async function allDocuments(database, name, pageSize) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('pageSize must be an integer between 1 and 500');
  const docs = []; let after;
  while (true) {
    let query = database.collection(name).orderBy('__name__').limit(pageSize);
    if (after) query = query.startAfter(after);
    const page = await query.get(); docs.push(...page.docs);
    if (page.docs.length < pageSize) return docs;
    after = page.docs.at(-1);
  }
}
async function snapshotCandidates(database, pageSize) {
  const [users, cars, dealers] = await Promise.all([allDocuments(database, 'users', pageSize), allDocuments(database, 'cars', pageSize), allDocuments(database, 'dealers', pageSize)]);
  const dealerSubscriptions = new Set(dealers.map(doc => doc.data().stripeDealerSubscriptionId).filter(Boolean));
  const grouped = new Map();
  for (const user of users) {
    const profile = user.data();
    if (profile.role === 'dealer' || profile.dealerTierKey || !profile.stripeSubscriptionId || dealerSubscriptions.has(profile.stripeSubscriptionId)) continue;
    const id = profile.stripeSubscriptionId;
    if (!grouped.has(id)) grouped.set(id, { subscriptionId: id, ownerIds: [], customerIds: [], listingIds: [] });
    const group = grouped.get(id); group.ownerIds.push(user.id);
    if (profile.stripeCustomerId) group.customerIds.push(profile.stripeCustomerId);
  }
  for (const listing of cars) {
    const value = listing.data(); if (!privatePublic(value)) continue;
    const group = [...grouped.values()].find(candidate => candidate.ownerIds.includes(value.ownerId));
    if (group) group.listingIds.push(listing.id);
    else {
      const id = `unlinked:${value.ownerId || 'unknown'}`;
      if (!grouped.has(id)) grouped.set(id, { subscriptionId: null, ownerIds: [value.ownerId || ''], customerIds: [], listingIds: [] });
      grouped.get(id).listingIds.push(listing.id);
    }
  }
  return [...grouped.values()];
}
async function paidEvidence(stripe, subscription, cutoff) {
  let invoice = subscription.latest_invoice;
  if (typeof invoice === 'string') invoice = await stripe.invoices.retrieve(invoice);
  let end = paidPublicUntilFromInvoice(subscription, invoice, cutoff);
  if (end) return { legacyPublicUntil: new Date(end), paidInvoiceId: invoice.id };
  // A failed renewal can replace latest_invoice; inspect prior paid invoices too.
  if (stripe.invoices?.list) {
    let after;
    do {
      const page = await stripe.invoices.list({ subscription: subscription.id, status: 'paid', limit: 100, ...(after ? { starting_after: after } : {}) });
      for (const paid of page.data) {
        const candidate = paidPublicUntilFromInvoice(subscription, paid, cutoff);
        if (candidate && (!end || candidate > end)) { end = candidate; invoice = paid; }
      }
      if (!page.has_more) break;
      if (!page.data.length) throw new Error('Stripe returned an empty invoice page with has_more');
      after = page.data.at(-1).id;
    } while (true);
  }
  return { legacyPublicUntil: end ? new Date(end) : null, paidInvoiceId: end ? invoice.id : null };
}
function progressId(group) { return group.subscriptionId || `unlinked_${encodeURIComponent(group.ownerIds[0] || 'unknown')}`; }

async function expireLegacySellerAdverts({ database, now = Date.now(), timestamp = new Date(millis(now)), pageSize = 200, onExpired } = {}) {
  let count = 0;
  for (const listing of await allDocuments(database, 'cars', pageSize)) {
    const candidate = listing.data();
    if (!privatePublic(candidate) || !Number.isFinite(millis(candidate.legacyPublicUntil)) || millis(candidate.legacyPublicUntil) > millis(now)) continue;
    const expired = await database.runTransaction(async transaction => {
      const current = await transaction.get(listing.ref); const car = current.data();
      if (!current.exists || !privatePublic(car) || !Number.isFinite(millis(car.legacyPublicUntil)) || millis(car.legacyPublicUntil) > millis(now)) return null;
      transaction.update(listing.ref, { status: 'draft', updatedAt: timestamp });
      return { ...car, status: 'draft' };
    });
    if (expired) { count++; if (onExpired) await onExpired({ id: listing.id, car: expired }); }
  }
  return count;
}

async function runSellerRetirementMigration({ database, stripe, dryRun = true, now = Date.now(), timestamp = new Date(millis(now)), pageSize = 200, storageStatusDatabase, onListingMigrated } = {}) {
  if (!database) throw new Error('database is required');
  const sentinelRef = database.collection(MIGRATIONS).doc(RETIREMENT_ID);
  let sentinel = (await sentinelRef.get()).data();
  if (!sentinel) {
    const groups = await snapshotCandidates(database, pageSize);
    sentinel = { version: 1, cutoff: new Date(millis(now)), subscriptions: groups };
    // A bounded atomic manifest guarantees that interrupted snapshots never add new members.
    if (Buffer.byteLength(JSON.stringify(sentinel)) > 800_000) throw new Error('Retirement manifest exceeds safe document size; partition this migration before applying. No changes made.');
    if (!dryRun) sentinel = await database.runTransaction(async transaction => {
      const existing = await transaction.get(sentinelRef);
      if (existing.exists) return existing.data();
      transaction.set(sentinelRef, sentinel); return sentinel;
    });
  }
  const report = { dryRun, cutoff: sentinel.cutoff, subscriptions: [], errors: [] };
  for (const group of sentinel.subscriptions) {
    const progressRef = database.collection(PROGRESS).doc(progressId(group));
    let progress = (await progressRef.get()).data() || {};
    const result = { subscriptionId: group.subscriptionId, listingIds: group.listingIds, status: progress.status || (dryRun ? 'unverified' : 'pending') };
    report.subscriptions.push(result);
    if (dryRun || progress.status === 'complete' || progress.status === 'skipped-dealer') continue;
    try {
      if (!progress.evidenceResolved) {
        let evidence = { legacyPublicUntil: null, paidInvoiceId: null }; let originalCancellation = null; let skipCancellation = true;
        if (group.subscriptionId) {
          if (!stripe?.subscriptions?.retrieve) throw new Error('Stripe is required to verify and retire seller subscriptions');
          const subscription = await stripe.subscriptions.retrieve(group.subscriptionId, { expand: ['latest_invoice'] });
          if (isDealerSubscription(subscription)) { await progressRef.set({ status: 'skipped-dealer', updatedAt: timestamp }, { merge: true }); result.status = 'skipped-dealer'; continue; }
          if (subscription.id !== group.subscriptionId || (group.customerIds.length && !group.customerIds.includes(objectId(subscription.customer))) || (subscription.metadata?.firebaseUid && !group.ownerIds.includes(subscription.metadata.firebaseUid))) throw new Error('Subscription ownership mismatch; manual review required');
          evidence = await paidEvidence(stripe, subscription, sentinel.cutoff);
          originalCancellation = { cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end), cancelAt: subscription.cancel_at || null, status: subscription.status };
          const periodEnd = subscription.items?.data?.[0]?.current_period_end || subscription.current_period_end;
          skipCancellation = ['canceled', 'incomplete_expired'].includes(subscription.status) || Boolean(subscription.cancel_at_period_end) || Boolean(subscription.cancel_at && periodEnd && subscription.cancel_at <= periodEnd);
        }
        // Freeze evidence before any external mutation; retries cannot grant a renewed period.
        progress = await database.runTransaction(async transaction => {
          const existing = (await transaction.get(progressRef)).data() || {};
          if (existing.evidenceResolved) return existing;
          const frozen = { ...existing, ...evidence, originalCancellation, skipCancellation, evidenceResolved: true, status: 'pending', listingIds: group.listingIds, updatedAt: timestamp };
          transaction.set(progressRef, frozen); return frozen;
        });
      }
      for (const id of group.listingIds) {
        const ref = database.collection('cars').doc(id);
        const migrated = await database.runTransaction(async transaction => {
          const current = await transaction.get(ref); const car = current.data();
          if (!current.exists || !privatePublic(car) || !group.ownerIds.includes(car.ownerId)) return null;
          // Missing/null is meaningful after the initial write: never replace a frozen rejection.
          if (car.legacySellerRetirementVersion === 1) return car;
          const legacyPublicUntil = Object.hasOwn(car, 'legacyPublicUntil') ? car.legacyPublicUntil : progress.legacyPublicUntil;
          const patch = { legacySellerRetirementVersion: 1, legacyPublicUntil, legacyStripeSubscriptionId: group.subscriptionId, updatedAt: timestamp };
          if (!Number.isFinite(millis(legacyPublicUntil)) || millis(legacyPublicUntil) <= millis(now)) patch.status = 'draft';
          transaction.update(ref, patch); return { ...car, ...patch };
        });
        if (migrated && storageStatusDatabase) {
          const [owner, deletion] = await Promise.all([database.collection('users').doc(migrated.ownerId).get(), database.collection('accountDeletionRequests').doc(migrated.ownerId).get()]);
          const profile = owner.data() || {};
          const accountActive = !['pending', 'finalizing', 'completed'].includes(deletion.data()?.status) && !profile.deletedAt && profile.disabled !== true && !['deleted', 'disabled', 'suspended'].includes(profile.status);
          await storageStatusDatabase.collection('storageSellerListings').doc(id).set({ ownerId: migrated.ownerId, sellerType: migrated.sellerType, listingPlan: migrated.listingPlan, visibility: migrated.visibility, status: migrated.status, legacyPublicUntil: migrated.legacyPublicUntil || null, accountActive }, { merge: true });
        }
        if (migrated && onListingMigrated) await onListingMigrated({ id, car: migrated });
      }
      if (!progress.cancellationComplete && !progress.skipCancellation) {
        await stripe.subscriptions.update(group.subscriptionId, { cancel_at_period_end: true }, { idempotencyKey: `${RETIREMENT_ID}-${group.subscriptionId}` });
      }
      await progressRef.set({ cancellationComplete: true, status: 'complete', lastError: null, updatedAt: timestamp }, { merge: true }); result.status = 'complete';
    } catch (error) {
      const message = error?.message || String(error); result.status = 'error'; result.error = message;
      report.errors.push({ subscriptionId: group.subscriptionId, error: message });
      await progressRef.set({ status: 'error', lastError: message, updatedAt: timestamp }, { merge: true });
    }
  }
  return report;
}
module.exports = { RETIREMENT_ID, isLegacyPublicAdvert, expireLegacySellerAdverts, runSellerRetirementMigration, paidPublicUntilFromInvoice, isDealerSubscription };
