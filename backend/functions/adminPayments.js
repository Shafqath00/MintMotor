// Records Stripe invoice outcomes so the admin can see real payments, failures and revenue.
const COLLECTION = "payments";

const subscriptionMetadata = (invoice) =>
  invoice.subscription_details?.metadata || invoice.parent?.subscription_details?.metadata || invoice.lines?.data?.[0]?.metadata || {};
const subscriptionId = (invoice) => {
  const raw = invoice.subscription || invoice.parent?.subscription_details?.subscription || "";
  return typeof raw === "string" ? raw : raw?.id || "";
};
const customerId = (invoice) => (typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id || "");
const seconds = (value) => (Number.isFinite(value) && value > 0 ? value * 1000 : null);

// resolveCustomer(customerId) -> { accountType, accountId, label } | null, used when metadata is missing.
async function invoiceToPayment(invoice, eventType, resolveCustomer = async () => null) {
  const meta = subscriptionMetadata(invoice);
  let accountType = meta.dealerTierKey ? "dealer" : meta.firebaseUid ? "seller" : "";
  let accountId = meta.firebaseUid || "";
  let label = "";
  if (!accountId && customerId(invoice) && resolveCustomer) {
    const found = await resolveCustomer(customerId(invoice));
    if (found) ({ accountType, accountId, label } = found);
  }
  const failed = eventType === "invoice.payment_failed" || invoice.status === "uncollectible";
  const paid = !failed && (eventType === "invoice.paid" || invoice.status === "paid");
  const line = invoice.lines?.data?.[0];
  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.number || "",
    subscriptionId: subscriptionId(invoice),
    customerId: customerId(invoice),
    accountType: accountType || "unknown",
    accountId,
    accountLabel: label,
    tierKey: meta.dealerTierKey || "",
    status: paid ? "paid" : failed ? "failed" : invoice.status === "void" ? "void" : "open",
    amountPaidPence: invoice.amount_paid || 0,
    amountDuePence: invoice.amount_due || 0,
    currency: String(invoice.currency || "gbp").toLowerCase(),
    description: line?.description || "",
    periodStartMs: seconds(line?.period?.start),
    periodEndMs: seconds(line?.period?.end),
    invoiceCreatedMs: seconds(invoice.created) || Date.now(),
    attemptCount: invoice.attempt_count || 0,
    failureReason: failed ? String(invoice.last_finalization_error?.message || (invoice.status === "uncollectible" ? "Stripe marked this invoice uncollectible." : "Payment failed.")).slice(0, 200) : "",
    hostedInvoiceUrl: invoice.hosted_invoice_url || "",
  };
}

async function recordInvoiceEvent({ database, FieldValue, invoice, eventType, resolveCustomer, now = () => Date.now() }) {
  if (!invoice?.id) return null;
  const payment = await invoiceToPayment(invoice, eventType, resolveCustomer);
  const ref = database.collection(COLLECTION).doc(invoice.id);
  const existing = await ref.get();
  const current = existing.exists ? existing.data() : null;
  // Stripe can deliver events out of order; a payment that was collected is never downgraded to failed.
  if (current?.status === "paid" && payment.status !== "paid") return current;
  if (current?.status === "refunded") payment.status = "refunded";
  await ref.set({ ...payment, recordedAtMs: now(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return payment;
}

async function recordRefund({ database, FieldValue, charge, now = () => Date.now() }) {
  const invoiceId = typeof charge.invoice === "string" ? charge.invoice : charge.invoice?.id;
  if (!invoiceId) return null;
  const ref = database.collection(COLLECTION).doc(invoiceId);
  const existing = await ref.get();
  if (!existing.exists) return null;
  await ref.set({ status: charge.amount_refunded >= charge.amount ? "refunded" : existing.data().status, amountRefundedPence: charge.amount_refunded || 0, recordedAtMs: now(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return invoiceId;
}

function serializePayment(snapshot) {
  const data = typeof snapshot.data === "function" ? snapshot.data() : snapshot;
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  return {
    id: snapshot.id || data.invoiceId,
    invoiceNumber: data.invoiceNumber || "",
    accountType: data.accountType || "unknown",
    accountId: data.accountId || "",
    accountLabel: data.accountLabel || "",
    tierKey: data.tierKey || "",
    status: data.status || "open",
    amountPaidPence: data.amountPaidPence || 0,
    amountDuePence: data.amountDuePence || 0,
    amountRefundedPence: data.amountRefundedPence || 0,
    currency: data.currency || "gbp",
    description: data.description || "",
    periodStart: iso(data.periodStartMs),
    periodEnd: iso(data.periodEndMs),
    createdAt: iso(data.invoiceCreatedMs),
    attemptCount: data.attemptCount || 0,
    failureReason: data.failureReason || "",
    hostedInvoiceUrl: data.hostedInvoiceUrl || "",
  };
}

function filterPayments(payments, { status, accountType, q, from, to } = {}) {
  const fromMs = from ? Date.parse(from) : null;
  const toMs = to ? Date.parse(to) + 86_399_999 : null;
  const text = String(q || "").trim().toLowerCase();
  return payments.filter((payment) => {
    const at = Date.parse(payment.createdAt || 0);
    if (status && payment.status !== status) return false;
    if (accountType && payment.accountType !== accountType) return false;
    if (fromMs && at < fromMs) return false;
    if (toMs && at > toMs) return false;
    if (text && ![payment.accountLabel, payment.accountId, payment.invoiceNumber, payment.description, payment.tierKey].join(" ").toLowerCase().includes(text)) return false;
    return true;
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

// Net of refunds, in pence, for the revenue figures on the dashboard and reports.
const netPence = (payment) => (payment.status === "paid" || payment.status === "refunded" ? payment.amountPaidPence - payment.amountRefundedPence : 0);

module.exports = { COLLECTION, invoiceToPayment, recordInvoiceEvent, recordRefund, serializePayment, filterPayments, netPence };
