// Append-only activity log shared by admins, users, dealers and the billing webhook.
// Entries are never updated or deleted by the API; recording never breaks the request being logged.
const COLLECTION = "auditLog";
const SENSITIVE_KEY = /token|secret|password|authorization|apikey|api_key|card|cvc/i;
const SCAN_WINDOW = 400;

const CATEGORIES = ["account", "listing", "dealer", "subscription", "payment", "moderation", "content", "team", "complaint", "export", "settings", "enquiry"];

function clip(value, max = 300) {
  return typeof value === "string" && value.length > max ? `${value.slice(0, max)}…` : value;
}

// Keeps small, readable before/after details and drops anything secret-looking.
function sanitizeDetails(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return clip(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return depth > 1 ? undefined : value.slice(0, 20).map((item) => sanitizeDetails(item, depth + 1));
  if (typeof value === "object") {
    if (depth > 1) return undefined;
    const result = {};
    for (const [key, inner] of Object.entries(value).slice(0, 25)) {
      if (SENSITIVE_KEY.test(key)) continue;
      const cleaned = sanitizeDetails(inner, depth + 1);
      if (cleaned !== undefined) result[key] = cleaned;
    }
    return result;
  }
  return undefined;
}

function serializeAudit(snapshot) {
  const data = typeof snapshot.data === "function" ? snapshot.data() : snapshot;
  return {
    id: snapshot.id,
    action: data.action || "",
    category: data.category || "",
    actor: data.actor || { type: "system" },
    target: data.target || null,
    summary: data.summary || "",
    details: data.details || null,
    createdAt: data.createdAtMs ? new Date(data.createdAtMs).toISOString() : null,
  };
}

function matches(entry, { category, action, actorUid, targetId, targetType, q }) {
  if (category && entry.category !== category) return false;
  if (action && entry.action !== action) return false;
  if (actorUid && entry.actor?.uid !== actorUid) return false;
  if (targetId && entry.target?.id !== targetId) return false;
  if (targetType && entry.target?.type !== targetType) return false;
  if (q) {
    const haystack = [entry.summary, entry.action, entry.actor?.email, entry.actor?.uid, entry.target?.label, entry.target?.id].join(" ").toLowerCase();
    if (!haystack.includes(String(q).toLowerCase())) return false;
  }
  return true;
}

function createAuditLog({ database, FieldValue, logger = console, now = () => Date.now() }) {
  async function record({ action, category, actor, target = null, summary = "", details = null }) {
    try {
      if (!action || !CATEGORIES.includes(category)) throw new Error(`Invalid audit entry: ${action}/${category}`);
      const createdAtMs = now();
      const ref = database.collection(COLLECTION).doc();
      await ref.set({
        action, category,
        actor: { type: actor?.type || "system", uid: actor?.uid || "", email: actor?.email || "", name: actor?.name || "", role: actor?.role || "" },
        target: target ? { type: target.type, id: String(target.id || ""), label: clip(target.label || "", 160) } : null,
        summary: clip(summary, 400),
        details: sanitizeDetails(details),
        createdAt: FieldValue.serverTimestamp(),
        createdAtMs,
      });
      return ref.id;
    } catch (error) {
      logger.error("Audit entry could not be recorded", { action, error: error?.message });
      return null;
    }
  }

  // Newest first. Filters run in memory over a bounded recent window so no composite indexes are needed.
  async function list({ before, limit = 50, ...filters } = {}) {
    const wanted = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const entries = [];
    let cursor = Number(before) || null;
    let exhausted = false;
    for (let pass = 0; pass < 5 && entries.length <= wanted && !exhausted; pass++) {
      let query = database.collection(COLLECTION);
      if (cursor) query = query.where("createdAtMs", "<", cursor);
      const page = await query.orderBy("createdAtMs", "desc").limit(SCAN_WINDOW).get();
      const rows = page.docs.map(serializeAudit);
      for (const row of rows) if (matches(row, filters)) entries.push(row);
      exhausted = rows.length < SCAN_WINDOW;
      if (rows.length) cursor = Date.parse(rows[rows.length - 1].createdAt);
    }
    const shown = entries.slice(0, wanted);
    const more = entries.length > wanted || !exhausted;
    return { entries: shown, nextBefore: more && shown.length ? Date.parse(shown[shown.length - 1].createdAt) : null };
  }

  // Everything done to, or by, one record (a listing, user or dealer).
  async function timeline(id, { limit = 100 } = {}) {
    const [about, by, owned] = await Promise.all([
      database.collection(COLLECTION).where("target.id", "==", id).get(),
      database.collection(COLLECTION).where("actor.uid", "==", id).get(),
      // Listing events carry their owner, so a person's timeline includes what happened to their cars.
      database.collection(COLLECTION).where("details.ownerId", "==", id).get(),
    ]);
    const seen = new Map();
    for (const doc of [...about.docs, ...by.docs, ...owned.docs]) seen.set(doc.id, serializeAudit(doc));
    return [...seen.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, limit);
  }

  return { record, list, timeline };
}

// The acting person for an entry, taken from the verified request.
function actorFromRequest(req) {
  const user = req.user || {};
  if (req.adminRole) return { type: "admin", uid: user.uid, email: user.email || "", role: req.adminRole };
  if (req.dealer) return { type: "dealer", uid: req.dealer.id || user.uid, email: req.dealer.email || user.email || "", name: req.dealer.businessName || "" };
  return { type: "user", uid: user.uid || "", email: user.email || "" };
}

module.exports = { CATEGORIES, createAuditLog, actorFromRequest, sanitizeDetails, serializeAudit };
