const test = require("node:test");
const assert = require("node:assert/strict");
const { createTestDb } = require("./testDb");
const { invoiceToPayment, recordInvoiceEvent, recordRefund, serializePayment, filterPayments, netPence } = require("./adminPayments");

const FieldValue = { serverTimestamp: () => "SERVER_TIME" };
const invoice = (over = {}) => ({
  id: "in_1", number: "MM-0001", status: "paid", customer: "cus_1", currency: "GBP", amount_paid: 9900, amount_due: 9900, created: 1_790_000_000,
  subscription_details: { metadata: { firebaseUid: "dealer-1", dealerTierKey: "starter" } },
  lines: { data: [{ description: "Starter plan", period: { start: 1_790_000_000, end: 1_792_592_000 } }] },
  hosted_invoice_url: "https://stripe.test/i/1", ...over,
});

test("maps a paid dealer invoice, reading the account from subscription metadata", async () => {
  const payment = await invoiceToPayment(invoice(), "invoice.paid");
  assert.deepEqual({ type: payment.accountType, id: payment.accountId, tier: payment.tierKey, status: payment.status, paid: payment.amountPaidPence, currency: payment.currency }, { type: "dealer", id: "dealer-1", tier: "starter", status: "paid", paid: 9900, currency: "gbp" });
  assert.equal(payment.periodEndMs, 1_792_592_000_000);
});

test("falls back to the Stripe customer when metadata is missing, and treats seller metadata as a seller", async () => {
  const resolved = await invoiceToPayment(invoice({ subscription_details: { metadata: {} } }), "invoice.paid", async (id) => (id === "cus_1" ? { accountType: "seller", accountId: "u1", label: "a@b.test" } : null));
  assert.deepEqual([resolved.accountType, resolved.accountId, resolved.accountLabel], ["seller", "u1", "a@b.test"]);
  assert.equal((await invoiceToPayment(invoice({ subscription_details: { metadata: { firebaseUid: "u2" } } }), "invoice.paid")).accountType, "seller");
  assert.equal((await invoiceToPayment(invoice({ subscription_details: { metadata: {} } }), "invoice.paid")).accountType, "unknown");
});

test("failed payments are recorded as failed with a reason and attempt count", async () => {
  const payment = await invoiceToPayment(invoice({ status: "open", amount_paid: 0, attempt_count: 2 }), "invoice.payment_failed");
  assert.equal(payment.status, "failed");
  assert.equal(payment.attemptCount, 2);
  assert.ok(payment.failureReason);
});

test("recording is idempotent and a collected payment is never downgraded by a late failure event", async () => {
  const database = createTestDb();
  await recordInvoiceEvent({ database, FieldValue, invoice: invoice({ status: "open", amount_paid: 0 }), eventType: "invoice.payment_failed", now: () => 1 });
  assert.equal(database.rows("payments").in_1.status, "failed");
  await recordInvoiceEvent({ database, FieldValue, invoice: invoice(), eventType: "invoice.paid", now: () => 2 });
  assert.equal(database.rows("payments").in_1.status, "paid");
  await recordInvoiceEvent({ database, FieldValue, invoice: invoice({ status: "open", amount_paid: 0 }), eventType: "invoice.payment_failed", now: () => 3 });
  assert.equal(database.rows("payments").in_1.status, "paid");
  assert.equal(Object.keys(database.rows("payments")).length, 1);
  assert.equal(await recordInvoiceEvent({ database, FieldValue, invoice: {}, eventType: "invoice.paid" }), null);
});

test("refunds update the recorded payment and ignore unknown invoices", async () => {
  const database = createTestDb();
  await recordInvoiceEvent({ database, FieldValue, invoice: invoice(), eventType: "invoice.paid" });
  assert.equal(await recordRefund({ database, FieldValue, charge: { invoice: "in_other", amount: 9900, amount_refunded: 9900 } }), null);
  await recordRefund({ database, FieldValue, charge: { invoice: "in_1", amount: 9900, amount_refunded: 2000 } });
  assert.equal(database.rows("payments").in_1.status, "paid");
  await recordRefund({ database, FieldValue, charge: { invoice: "in_1", amount: 9900, amount_refunded: 9900 } });
  const refunded = serializePayment({ id: "in_1", data: () => database.rows("payments").in_1 });
  assert.equal(refunded.status, "refunded");
  assert.equal(netPence(refunded), 0);
});

test("filters by status, type, text and date, newest first", async () => {
  const rows = [
    serializePayment({ id: "a", data: () => ({ status: "paid", accountType: "dealer", accountLabel: "Mint Cars", invoiceCreatedMs: Date.parse("2026-10-01") }) }),
    serializePayment({ id: "b", data: () => ({ status: "failed", accountType: "seller", accountLabel: "Sam", invoiceCreatedMs: Date.parse("2026-10-20") }) }),
    serializePayment({ id: "c", data: () => ({ status: "paid", accountType: "seller", accountLabel: "Sam", invoiceCreatedMs: Date.parse("2026-10-10") }) }),
  ];
  assert.deepEqual(filterPayments(rows).map((p) => p.id), ["b", "c", "a"]);
  assert.deepEqual(filterPayments(rows, { status: "paid", accountType: "seller" }).map((p) => p.id), ["c"]);
  assert.deepEqual(filterPayments(rows, { q: "mint" }).map((p) => p.id), ["a"]);
  assert.deepEqual(filterPayments(rows, { from: "2026-10-05", to: "2026-10-10" }).map((p) => p.id), ["c"]);
});
