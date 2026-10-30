const assert = require('node:assert/strict');
const test = require('node:test');
const { isLegacyPublicAdvert, expireLegacySellerAdverts, runSellerRetirementMigration, paidPublicUntilFromInvoice } = require('./sellerRetirement');

function fakeDatabase(seed = {}) {
  const records = new Map(Object.entries(seed).flatMap(([name, docs]) => Object.entries(docs).map(([id, value]) => [`${name}/${id}`, value])));
  let writes = 0;
  const clone = (value) => value === undefined ? value : structuredClone(value);
  function doc(path) {
    return { path, id: path.split('/').at(-1), async get() { return snap(path); },
      async set(value, options) { writes++; records.set(path, options?.merge ? { ...records.get(path), ...clone(value) } : clone(value)); },
      async update(value) { assert.ok(records.has(path)); writes++; records.set(path, { ...records.get(path), ...clone(value) }); } };
  }
  function snap(path) { return { id: path.split('/').at(-1), exists: records.has(path), ref: doc(path), data: () => clone(records.get(path)) }; }
  function query(name, filters = [], maximum = Infinity, after = '') {
    return { doc: (id) => doc(`${name}/${id}`), where: (key, op, value) => query(name, [...filters, [key, op, value]], maximum, after),
      orderBy: () => query(name, filters, maximum, after), limit: (n) => query(name, filters, n, after), startAfter: (s) => query(name, filters, maximum, s.id || s),
      async get() { const docs = [...records.keys()].filter(p => p.startsWith(`${name}/`) && !p.slice(name.length + 1).includes('/')).sort().map(snap).filter(s => s.id > after).filter(s => filters.every(([key, op, value]) => op === '==' ? s.data()[key] === value : s.data()[key] <= value)).slice(0, maximum); return { docs }; } };
  }
  return { records, get writes() { return writes; }, collection: query,
    async runTransaction(fn) { const operations = []; const result = await fn({ get: r => r.get(), set: (r,v,o) => operations.push(() => r.set(v,o)), update: (r,v) => operations.push(() => r.update(v)) }); for (const op of operations) await op(); return result; },
    batch() { const operations = []; return { set: (r,v,o) => operations.push(() => r.set(v,o)), update: (r,v) => operations.push(() => r.update(v)), async commit() { for (const op of operations) await op(); } }; } };
}
const now = 1_800_000_000_000;
const car = (extra = {}) => ({ sellerType: 'private', ownerId: 'seller', listingPlan: 'public-subscription', visibility: 'public', status: 'published', ...extra });
const invoice = (extra = {}) => ({ id: 'in_paid', status: 'paid', amount_paid: 900, status_transitions: { paid_at: now / 1000 - 100 }, subscription: 'sub_seller', lines: { data: [{ amount: 900, type: 'subscription', subscription: 'sub_seller', subscription_item: 'si_seller', period: { start: now / 1000 - 200, end: now / 1000 + 200 } }] }, ...extra });
const subscription = (extra = {}) => ({ id: 'sub_seller', customer: 'cus_seller', metadata: { firebaseUid: 'seller' }, status: 'active', latest_invoice: invoice(), current_period_end: now / 1000 + 200, items: { data: [{ id: 'si_seller', current_period_end: now / 1000 + 200 }] }, ...extra });
function fixture(extra = {}) { return fakeDatabase({ users: { seller: { stripeSubscriptionId: 'sub_seller', stripeCustomerId: 'cus_seller' }, dealer: { role: 'dealer', stripeSubscriptionId: 'sub_dealer' } }, cars: { paid: car(), draft: car({ status: 'draft' }), free: car({ listingPlan: 'dealer-network-free', visibility: 'dealer-network' }), dealer: car({ ownerId: 'dealer', sellerType: 'dealer' }), ...extra } }); }
function fakeStripe(sub = subscription()) { const calls = []; return { calls, subscriptions: { async retrieve(id) { calls.push(['retrieve', id]); return structuredClone(sub); }, async update(id, patch) { calls.push(['update', id, patch]); return { ...sub, ...patch }; } } }; }

test('public access uses only an immutable per-listing paid window and stops exactly at expiry', () => {
  assert.equal(isLegacyPublicAdvert(car({ legacyPublicUntil: new Date(now + 1) }), now), true);
  for (const extra of [{ legacyPublicUntil: new Date(now) }, { legacyPublicUntil: null }, { legacyPublicUntil: 'bad' }, { legacyPublicUntil: new Date(now + 1), status: 'draft' }, { legacyPublicUntil: new Date(now + 1), sellerType: 'dealer' }, { legacyPublicUntil: new Date(now + 1), listingPlan: 'dealer-network-free' }]) assert.equal(isLegacyPublicAdvert(car(extra), now), false);
});
test('paid evidence rejects trials, unpaid invoices, unrelated lines and payments after cutoff', () => {
  assert.equal(paidPublicUntilFromInvoice(subscription(), invoice(), now), now + 200_000);
  for (const bad of [invoice({ status: 'open' }), invoice({ amount_paid: 0 }), invoice({ status_transitions: { paid_at: now / 1000 + 1 } }), invoice({ subscription: 'sub_other' }), invoice({ lines: { data: [{ amount: 900, subscription: 'sub_other', period: { end: now / 1000 + 200 } }] } })]) assert.equal(paidPublicUntilFromInvoice(subscription(), bad, now), null);
  assert.equal(paidPublicUntilFromInvoice(subscription({ status: 'trialing' }), invoice(), now), null);
});
test('dry run defaults to no database mutations and no Stripe calls', async () => {
  const database = fixture(); const stripe = fakeStripe();
  const result = await runSellerRetirementMigration({ database, stripe, now, pageSize: 1 });
  assert.equal(result.dryRun, true); assert.equal(database.writes, 0); assert.deepEqual(stripe.calls, []); assert.equal(result.subscriptions.length, 1);
});
test('migration snapshots only published paid private adverts, cancels seller renewals and never extends on rerun', async () => {
  const database = fixture(); const stripe = fakeStripe();
  const first = await runSellerRetirementMigration({ database, stripe, now, dryRun: false, pageSize: 1 });
  assert.deepEqual(first.errors, []); assert.equal(database.records.get('cars/paid').legacyPublicUntil.getTime(), now + 200_000);
  assert.equal(database.records.get('cars/draft').legacyPublicUntil, undefined); assert.equal(database.records.get('cars/dealer').legacyPublicUntil, undefined);
  assert.ok(stripe.calls.some(([method,id]) => method === 'update' && id === 'sub_seller')); assert.ok(!stripe.calls.some(([,id]) => id === 'sub_dealer'));
  database.records.set('cars/new', car());
  await runSellerRetirementMigration({ database, stripe, now: now + 1000, dryRun: false });
  assert.equal(database.records.get('cars/new').legacyPublicUntil, undefined); assert.equal(stripe.calls.filter(([m]) => m === 'update').length, 1);
});
test('Stripe cancellation failures are durable and retry without rereading the paid period', async () => {
  const database = fixture(); const stripe = fakeStripe(); let fail = true;
  stripe.subscriptions.update = async (id, patch) => { stripe.calls.push(['update', id, patch]); if (fail) throw new Error('temporary'); };
  const first = await runSellerRetirementMigration({ database, stripe, now, dryRun: false }); assert.equal(first.errors.length, 1);
  fail = false;
  const second = await runSellerRetirementMigration({ database, stripe, now: now + 1000, dryRun: false }); assert.deepEqual(second.errors, []);
  assert.equal(stripe.calls.filter(([m]) => m === 'retrieve').length, 1); assert.equal(database.records.get('cars/paid').legacyPublicUntil.getTime(), now + 200_000);
});
test('expiry is idempotent, keeps free conversions and future windows intact, and never auto-shares', async () => {
  const database = fixture({ paid: car({ legacyPublicUntil: new Date(now) }), future: car({ legacyPublicUntil: new Date(now + 1) }), converted: car({ legacyPublicUntil: new Date(now - 1), listingPlan: 'dealer-network-free', visibility: 'dealer-network' }) });
  assert.equal(await expireLegacySellerAdverts({ database, now }), 1); assert.equal(await expireLegacySellerAdverts({ database, now }), 0);
  assert.equal(database.records.get('cars/paid').status, 'draft'); assert.equal(database.records.get('cars/paid').visibility, 'public'); assert.equal(database.records.get('cars/converted').status, 'published');
});
module.exports = { fakeDatabase };

test('existing early cancellation is preserved and unverified active subscriptions get no public window', async () => {
  const database = fixture(); const stripe = fakeStripe(subscription({ latest_invoice: invoice({ status: 'open' }), cancel_at: now / 1000 + 20 }));
  const result = await runSellerRetirementMigration({ database, stripe, now, dryRun: false });
  assert.deepEqual(result.errors, []); assert.equal(database.records.get('cars/paid').legacyPublicUntil, null); assert.equal(database.records.get('cars/paid').status, 'draft');
  assert.equal(stripe.calls.filter(([m]) => m === 'update').length, 0);
});
test('duplicate user references to one subscription are processed once', async () => {
  const database = fixture(); database.records.set('users/alias', { stripeSubscriptionId: 'sub_seller' }); const stripe = fakeStripe();
  const result = await runSellerRetirementMigration({ database, stripe, now, dryRun: false });
  assert.deepEqual(result.errors, []); assert.equal(result.subscriptions.length, 1); assert.equal(stripe.calls.filter(([m]) => m === 'update').length, 1);
});
test('dealer metadata overrides a stale seller profile and never cancels dealer billing', async () => {
  const database = fixture(); const stripe = fakeStripe(subscription({ metadata: { firebaseUid: 'seller', dealerTierKey: 'pro' } }));
  const result = await runSellerRetirementMigration({ database, stripe, now, dryRun: false });
  assert.equal(result.subscriptions[0].status, 'skipped-dealer'); assert.equal(stripe.calls.filter(([m]) => m === 'update').length, 0); assert.equal(database.records.get('cars/paid').legacyPublicUntil, undefined);
});
test('a failed latest invoice can use an earlier actually paid service period, never a post-cutoff payment', async () => {
  const database = fixture(); const stripe = fakeStripe(subscription({ status: 'past_due', latest_invoice: invoice({ status: 'open' }) }));
  stripe.invoices = { async list() { return { data: [invoice(), invoice({ id: 'in_late', status_transitions: { paid_at: now / 1000 + 1 }, lines: { data: [{ amount: 900, type: 'subscription', subscription: 'sub_seller', period: { start: now / 1000, end: now / 1000 + 5000 } }] } })], has_more: false }; } };
  await runSellerRetirementMigration({ database, stripe, now, dryRun: false }); assert.equal(database.records.get('cars/paid').legacyPublicUntil.getTime(), now + 200_000);
});

test('a preexisting per-listing retirement bound cannot be extended by a later verified period', async () => {
  const database = fixture({ paid: car({ legacyPublicUntil: new Date(now + 10) }) });
  await runSellerRetirementMigration({ database, stripe: fakeStripe(), now, dryRun: false });
  assert.equal(database.records.get('cars/paid').legacyPublicUntil.getTime(), now + 10);
});

test('dealer registry protects a dealer subscription even when a user profile is stale', async () => {
  const database = fixture(); database.records.set('dealers/seller', { stripeDealerSubscriptionId: 'sub_seller' }); const stripe = fakeStripe();
  await runSellerRetirementMigration({ database, stripe, now, dryRun: false });
  assert.deepEqual(stripe.calls, []);
});
test('script media preview makes no Storage calls and no writes', async () => {
  const { protectExistingSellerMedia } = require('./sellerRetirementMedia');
  const database = fixture(); const bucket = { name: 'bucket', file() { throw new Error('Storage must not be called'); } };
  const report = await protectExistingSellerMedia({ database, storageStatusDatabase: database, bucket, dryRun: true, now });
  assert.deepEqual(report.errors, []); assert.equal(database.writes, 0);
});

test('media sweep resumes the original-source journal after a revocation failure', async () => {
  const { protectExistingSellerMedia } = require('./sellerRetirementMedia');
  const source = 'users/seller/cars/free/photo.jpg'; const destination = 'private-sellers/seller/cars/free/photo.jpg';
  const database = fakeDatabase({ users: { seller: {} }, cars: { free: car({ listingPlan: 'dealer-network-free', visibility: 'dealer-network', images: [source] }) } });
  const objects = new Map([[source, { contentType: 'image/jpeg', size: 10, metadata: { firebaseStorageDownloadTokens: 'legacy' } }]]);
  let failDeletion = true; let copies = 0;
  const bucket = { name: 'bucket', file(path) { return { path,
    async getMetadata() { if (!objects.has(path)) throw new Error('missing object'); return [objects.get(path)]; },
    async exists() { return [objects.has(path)]; },
    async copy(target, options) { copies++; objects.set(target.path, { ...objects.get(path), ...options.metadata }); },
    async setMetadata(value) { objects.set(path, { ...objects.get(path), ...value }); },
    async delete() { if (failDeletion) throw new Error('temporary delete outage'); objects.delete(path); },
  }; } };
  const first = await protectExistingSellerMedia({ database, storageStatusDatabase: database, bucket, dryRun: false, now });
  assert.equal(first.errors.length, 1); assert.deepEqual(database.records.get('cars/free').images, [destination]); assert.ok(objects.has(source));
  failDeletion = false;
  const second = await protectExistingSellerMedia({ database, storageStatusDatabase: database, bucket, dryRun: false, now });
  assert.deepEqual(second.errors, []); assert.ok(!objects.has(source)); assert.equal(copies, 1); assert.equal(database.records.get('sellerPlanRetirementMedia/free').status, 'complete');
});
