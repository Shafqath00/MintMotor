const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { createTestDb } = require("./testDb");
const { ADMIN_ROLES, ROLE_PERMISSIONS, PERMISSIONS, createAdminAuth } = require("./adminRoles");

const tokens = {
  legacy: { uid: "legacy", role: "admin" },
  claimOnly: { uid: "claim", admin: true },
  support: { uid: "sup", role: "admin", adminRole: "support" },
  finance: { uid: "fin", role: "admin" },
  revoked: { uid: "gone", role: "admin" },
  profile: { uid: "profile" },
  nobody: { uid: "nobody", role: "user" },
  dealer: { uid: "d", role: "dealer" },
};
function app(seed = {}) {
  const database = createTestDb({ adminTeam: { fin: { role: "finance", active: true }, gone: { role: "owner", active: false } }, users: { profile: { role: "admin" } }, ...seed });
  const admin = { auth: () => ({ async verifyIdToken(token) { if (!tokens[token]) throw new Error("bad"); return tokens[token]; } }) };
  const auth = createAdminAuth({ admin, database, logger: { warn() {}, error() {} } });
  const server = express();
  server.get("/stats", auth.requirePermission("stats.read"), (req, res) => res.json({ role: req.adminRole }));
  server.get("/payments", auth.requirePermission("payments.read"), (req, res) => res.json({ ok: true }));
  server.delete("/thing", auth.requirePermission("listings.delete"), auth.requireConfirmation, (_req, res) => res.status(204).end());
  return server;
}
const get = (server, path, token) => request(server).get(path).set("Authorization", `Bearer ${token}`);

test("every role only holds permissions that exist, and owners hold all of them", () => {
  for (const role of ADMIN_ROLES) for (const permission of ROLE_PERMISSIONS[role]) assert.ok(PERMISSIONS.includes(permission), `${role}:${permission}`);
  assert.deepEqual([...ROLE_PERMISSIONS.owner].sort(), [...PERMISSIONS].sort());
  assert.ok(!ROLE_PERMISSIONS.support.includes("team.manage"));
  assert.ok(!ROLE_PERMISSIONS.finance.includes("listings.moderate"));
});

test("admins without a team role keep full access (legacy and claim-only admins)", async () => {
  const server = app();
  for (const token of ["legacy", "claimOnly", "profile"]) {
    const res = await get(server, "/stats", token);
    assert.equal(res.status, 200, token);
    assert.equal(res.body.role, "owner");
  }
});

test("rejects missing, invalid, non-admin and dealer tokens", async () => {
  const server = app();
  assert.equal((await request(server).get("/stats")).status, 401);
  assert.equal((await get(server, "/stats", "garbage")).status, 401);
  assert.equal((await get(server, "/stats", "nobody")).status, 403);
  assert.equal((await get(server, "/stats", "dealer")).status, 403);
});

test("team roles limit what an admin can do and say which permission was missing", async () => {
  const server = app({ adminTeam: { sup: { role: "support", active: true }, fin: { role: "finance", active: true } } });
  assert.equal((await get(server, "/stats", "support")).body.role, "support");
  assert.equal((await get(server, "/payments", "support")).status, 403);
  const denied = await get(server, "/payments", "support");
  assert.equal(denied.body.code, "PERMISSION_DENIED");
  assert.equal(denied.body.permission, "payments.read");
  assert.equal((await get(server, "/payments", "finance")).status, 200);
  assert.equal((await request(server).delete("/thing").set("Authorization", "Bearer finance")).status, 403);
});

test("a revoked team member loses access even with a valid admin claim", async () => {
  const res = await get(app(), "/stats", "revoked");
  assert.equal(res.status, 403);
  assert.match(res.body.error, /revoked/i);
});

test("critical actions need explicit confirmation", async () => {
  const server = app();
  const missing = await request(server).delete("/thing").set("Authorization", "Bearer legacy");
  assert.equal(missing.status, 428);
  assert.equal(missing.body.code, "CONFIRMATION_REQUIRED");
  assert.equal((await request(server).delete("/thing").set("Authorization", "Bearer legacy").set("X-Confirm-Action", "true")).status, 204);
});

test("asking for an unknown permission fails at start-up, not at request time", () => {
  const auth = createAdminAuth({ admin: {}, database: {} });
  assert.throws(() => auth.requirePermission("nonsense.read"), /Unknown permission/);
});
