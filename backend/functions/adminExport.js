// CSV reports. Cells that a spreadsheet could run as a formula are neutralised.
const pounds = (pence) => (Number.isFinite(pence) ? (pence / 100).toFixed(2) : "");

function csvCell(value) {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(columns, rows) {
  const lines = [columns.map((column) => csvCell(column.label)).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(typeof column.value === "function" ? column.value(row) : row[column.key])).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

const col = (label, key, value) => ({ label, key, value });

const EXPORTS = {
  users: { permission: "export.users", columns: [
    col("User ID", "id"), col("Email", "email"), col("Name", "displayName"), col("Phone", "phone"), col("Role", "role"),
    col("Status", "status"), col("Joined", "createdAt"), col("Listings", "listingCount"), col("Seller subscription", "subscriptionStatus"),
  ] },
  dealers: { permission: "export.dealers", columns: [
    col("Dealer ID", "id"), col("Business", "businessName"), col("Contact", "contactName"), col("Email", "email"), col("Phone", "phone"),
    col("Postcode", "postcode"), col("Status", "dealerStatus"), col("Approved", "approvedAt"), col("Plan", "planName"),
    col("Subscription", "subscriptionStatus"), col("Plan renews or ends", "periodEnd"), col("Live listing limit", "liveLimit"), col("Live listings", "liveCount"), col("Total uploaded", "uploaded"), col("Sold", "sold"),
  ] },
  listings: { permission: "export.listings", columns: [
    col("Listing ID", "id"), col("Type", "kindLabel"), col("Vehicle", "title"), col("Registration", "registrationNumber"), col("Price (GBP)", "price"),
    col("Status", "status"), col("Moderation", "moderationStatus"), col("Owner ID", "ownerId"), col("Owner", "ownerLabel"), col("Created", "createdAt"), col("Updated", "updatedAt"), col("Published", "publishedAt"), col("Featured", "isFeatured"),
  ] },
  subscriptions: { permission: "export.subscriptions", columns: [
    col("Type", "accountType"), col("Account", "label"), col("Email", "email"), col("Plan", "planName"), col("Status", "status"),
    col("Monthly price (GBP)", null, (row) => pounds(row.monthlyPricePence)), col("Renews or ends", "periodEnd"), col("Cancels at period end", "cancelAtPeriodEnd"), col("Live listings", "liveCount"), col("Live limit", "liveLimit"),
  ] },
  payments: { permission: "export.payments", columns: [
    col("Invoice", "invoiceNumber"), col("Date", "createdAt"), col("Account type", "accountType"), col("Account", "accountLabel"), col("Account ID", "accountId"),
    col("Plan", "tierKey"), col("Status", "status"), col("Paid (GBP)", null, (row) => pounds(row.amountPaidPence)), col("Refunded (GBP)", null, (row) => pounds(row.amountRefundedPence)),
    col("Currency", "currency"), col("Period start", "periodStart"), col("Period end", "periodEnd"), col("Failure reason", "failureReason"),
  ] },
  activity: { permission: "export.activity", columns: [
    col("Time", "createdAt"), col("Category", "category"), col("Action", "action"), col("Summary", "summary"),
    col("By type", null, (row) => row.actor?.type), col("By", null, (row) => row.actor?.email || row.actor?.uid), col("Target type", null, (row) => row.target?.type), col("Target", null, (row) => row.target?.label || row.target?.id),
  ] },
};

module.exports = { csvCell, toCsv, EXPORTS, pounds };
