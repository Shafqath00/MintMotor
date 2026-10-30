// Admin team roles and the permission each admin route requires.
const ADMIN_ROLES = ["owner", "support", "content", "finance"];

const PERMISSIONS = [
  "stats.read", "users.read", "users.manage", "dealers.read", "dealers.manage",
  "listings.read", "listings.edit", "listings.delete", "listings.moderate", "listings.feature",
  "enquiries.manage", "subscriptions.read", "plans.manage", "payments.read", "activity.read",
  "complaints.manage", "content.manage", "announcements.manage", "team.manage", "import.run",
  "export.users", "export.dealers", "export.listings", "export.subscriptions", "export.payments", "export.activity",
];

const ROLE_PERMISSIONS = Object.freeze({
  owner: PERMISSIONS,
  support: ["stats.read", "users.read", "users.manage", "dealers.read", "dealers.manage", "listings.read", "listings.edit", "listings.moderate", "enquiries.manage", "complaints.manage", "activity.read", "export.users", "export.dealers", "export.listings"],
  content: ["stats.read", "listings.read", "listings.feature", "content.manage", "announcements.manage"],
  finance: ["stats.read", "users.read", "dealers.read", "subscriptions.read", "payments.read", "export.subscriptions", "export.payments", "export.dealers"],
});

const ROLE_LABELS = Object.freeze({ owner: "Owner", support: "Support", content: "Content editor", finance: "Finance" });

// Admins who predate team roles keep full access, so nothing that works today stops working.
async function resolveAdminAccess({ database, user }) {
  const claimedAdmin = user.admin === true || user.role === "admin";
  let teamRecord = null;
  try {
    const snapshot = await database.collection("adminTeam").doc(user.uid).get();
    teamRecord = snapshot.exists ? snapshot.data() : null;
  } catch { /* A missing team collection means a legacy admin. */ }
  if (teamRecord && teamRecord.active === false) return { allowed: false, reason: "Your admin access has been revoked." };

  let profileAdmin = false;
  if (!claimedAdmin) {
    const profile = await database.collection("users").doc(user.uid).get();
    const data = profile.exists ? profile.data() : {};
    profileAdmin = data?.role === "admin" || data?.isAdmin === true;
  }
  if (!claimedAdmin && !profileAdmin) return { allowed: false, reason: "Admin access is required." };

  const role = ADMIN_ROLES.includes(teamRecord?.role) ? teamRecord.role : ADMIN_ROLES.includes(user.adminRole) ? user.adminRole : "owner";
  return { allowed: true, role, permissions: new Set(ROLE_PERMISSIONS[role]) };
}

function createAdminAuth({ admin, database, logger = console }) {
  async function requireAdmin(req, res, next) {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Authentication is required." });
    try {
      req.user = await admin.auth().verifyIdToken(token);
    } catch (error) {
      logger.warn("Admin verification failed", error);
      return res.status(401).json({ error: "Invalid authentication token." });
    }
    try {
      const access = await resolveAdminAccess({ database, user: req.user });
      if (!access.allowed) return res.status(403).json({ error: access.reason });
      req.adminRole = access.role;
      req.adminPermissions = access.permissions;
      next();
    } catch (error) {
      logger.error("Admin access check failed", error);
      res.status(500).json({ error: "Unable to verify admin access." });
    }
  }

  const requirePermission = (permission) => {
    if (!PERMISSIONS.includes(permission)) throw new Error(`Unknown permission: ${permission}`);
    return [requireAdmin, (req, res, next) => {
      if (req.adminPermissions.has(permission)) return next();
      res.status(403).json({ code: "PERMISSION_DENIED", error: `Your ${ROLE_LABELS[req.adminRole] || "admin"} role can't do this.`, permission });
    }];
  };

  // Critical, hard-to-undo actions must be explicitly confirmed by the caller (the console shows a dialog first).
  function requireConfirmation(req, res, next) {
    if (String(req.get("x-confirm-action") || "").toLowerCase() === "true") return next();
    res.status(428).json({ code: "CONFIRMATION_REQUIRED", error: "Confirm this action to continue." });
  }

  return { requireAdmin, requirePermission, requireConfirmation };
}

module.exports = { ADMIN_ROLES, ROLE_LABELS, ROLE_PERMISSIONS, PERMISSIONS, resolveAdminAccess, createAdminAuth };
