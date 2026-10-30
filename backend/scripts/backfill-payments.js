#!/usr/bin/env node
// Copies existing Stripe invoices into the `payments` collection so the admin Payments and revenue
// views include history from before invoice events were recorded. Safe to re-run: each invoice is one record.
//   node backend/scripts/backfill-payments.js            (preview, writes nothing)
//   node backend/scripts/backfill-payments.js --apply    (writes)
// Needs STRIPE_SECRET_KEY_MINT (or STRIPE_SECRET_KEY) and Firebase application-default credentials.
const { recordInvoiceEvent } = require("../functions/adminPayments");

async function main(args = process.argv.slice(2)) {
  if (args.some((arg) => !["--apply"].includes(arg))) throw new Error("Use --apply to write, or no flags to preview.");
  const apply = args.includes("--apply");
  const key = process.env.STRIPE_SECRET_KEY_MINT || process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Set STRIPE_SECRET_KEY_MINT (or STRIPE_SECRET_KEY).");
  const { database } = require("../functions/firebase");
  const { FieldValue } = require("firebase-admin/firestore");
  const Stripe = require("../functions/node_modules/stripe");
  const stripe = new Stripe(key);

  async function resolveCustomer(customerId) {
    const seller = await database.collection("users").where("stripeCustomerId", "==", customerId).limit(1).get();
    if (seller.docs[0]) return { accountType: "seller", accountId: seller.docs[0].id, label: seller.docs[0].data().email || "" };
    const dealer = await database.collection("dealers").where("stripeDealerCustomerId", "==", customerId).limit(1).get();
    if (dealer.docs[0]) return { accountType: "dealer", accountId: dealer.docs[0].id, label: dealer.docs[0].data().businessName || "" };
    return null;
  }

  const report = { seen: 0, written: 0, byStatus: {} };
  for await (const invoice of stripe.invoices.list({ limit: 100 })) {
    if (invoice.status === "draft") continue;
    report.seen += 1;
    const eventType = invoice.status === "paid" ? "invoice.paid" : invoice.status === "uncollectible" ? "invoice.payment_failed" : "invoice.open";
    report.byStatus[invoice.status] = (report.byStatus[invoice.status] || 0) + 1;
    if (apply) { await recordInvoiceEvent({ database, FieldValue, invoice, eventType, resolveCustomer }); report.written += 1; }
  }
  console.log(JSON.stringify({ mode: apply ? "apply" : "preview", ...report }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
