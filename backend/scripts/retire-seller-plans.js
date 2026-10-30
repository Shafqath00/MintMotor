#!/usr/bin/env node
// No live work occurs when this module is imported by tests/tooling.
const { runSellerRetirementMigration, expireLegacySellerAdverts } = require('../functions/sellerRetirement');
const { protectExistingSellerMedia } = require('../functions/sellerRetirementMedia');


async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('Usage: node backend/scripts/retire-seller-plans.js [--dry-run | --apply]\nDefault: read-only Firestore preview, no Stripe or Storage calls. --apply verifies paid periods, stops renewals and protects private media.');
    return;
  }
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) throw new Error('Use --apply OR --dry-run (default).');
  // Superseded on 2026-10-31: paid public seller adverts are kept (see docs/platform-split-rollout.md).
  // Applying this would cancel every seller subscription and draft their adverts.
  if (args.includes('--apply')) throw new Error('Seller plan retirement is cancelled. Paid public seller adverts are part of the platform; do not run --apply.');
  const dryRun = true;
  const { admin, database, storage, storageStatusDatabase } = require('../functions/firebase');
  const key = process.env.STRIPE_SECRET_KEY_MINT || process.env.STRIPE_SECRET_KEY;
  if (!dryRun && !key) throw new Error('Set STRIPE_SECRET_KEY_MINT (or STRIPE_SECRET_KEY) before --apply.');
  const Stripe = !dryRun ? require('../functions/node_modules/stripe') : null;
  const stripe = Stripe ? new Stripe(key) : null;
  const now = Date.now();
  const retirement = await runSellerRetirementMigration({ database, stripe, dryRun, now, timestamp: admin.firestore.FieldValue.serverTimestamp(), storageStatusDatabase });
  if (!dryRun) await expireLegacySellerAdverts({ database, now, timestamp: admin.firestore.FieldValue.serverTimestamp() });
  const media = await protectExistingSellerMedia({ database, storageStatusDatabase, bucket: dryRun ? null : storage.bucket(), dryRun, now });
  console.log(JSON.stringify({ retirement, media }, null, 2));
  if (retirement.errors.length || media.errors.length) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, protectExistingSellerMedia };
