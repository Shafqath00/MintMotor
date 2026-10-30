const test = require("node:test");
const assert = require("node:assert/strict");
const { DEALER_APPLICATION_STATUS, DEALER_STATUS } = require("./dealers");
const { approveDealer, createRequireDealer } = require("./dealerLifecycle");

function fakeDatabase(initial = {}) {
  const data = new Map(Object.entries(initial).map(([collection, documents]) => [collection, new Map(Object.entries(documents))]));
  function collection(name) {
    if (!data.has(name)) data.set(name, new Map());
    const records = data.get(name);
    return {
      doc(id) {
        return {
          id,
          async get() { const value = records.get(id); return { id, exists: Boolean(value), data: () => value }; },
          async set(value, options = {}) { records.set(id, options.merge ? { ...(records.get(id) || {}), ...value } : value); },
          async update(value) { records.set(id, { ...(records.get(id) || {}), ...value }); },
        };
      },
    };
  }
  return {
    collection,
    async runTransaction(callback) {
      return callback({
        get: (ref) => ref.get(),
        set: (ref, value, options) => ref.set(value, options),
        update: (ref, value) => ref.update(value),
      });
    },
    data,
  };
}

function setup({ mailFails = false, existingClaims = { existing: true, role: "dealer" } } = {}) {
  const database = fakeDatabase({ dealerApplications: { "app-1": {
    businessName: "Mint Cars", contactName: "Ava Smith", email: "ava@mint.test", phone: "07700",
    postcode: "SW1A 1AA", address: "1 Dealer Way", companyNumber: "", vatNumber: "", website: "",
    dealerType: "independent", status: DEALER_APPLICATION_STATUS.UNDER_REVIEW,
  } } });
  const storageStatusDatabase = fakeDatabase();
  const users = new Map();
  const createUserCalls = [];
  const auth = {
    async getUserByEmail(email) { const user = [...users.values()].find((item) => item.email === email); if (!user) throw Object.assign(new Error("missing"), { code: "auth/user-not-found" }); return user; },
    async createUser(user) { createUserCalls.push(user); const created = { uid: "dealer-1", ...user, customClaims: {} }; users.set(created.uid, created); return created; },
    async setCustomUserClaims(uid, claims) { users.get(uid).customClaims = claims; },
    async generatePasswordResetLink(email) { return `https://auth.test/setup?email=${email}`; },
    async generateEmailVerificationLink(email) { return `https://auth.test/verify?email=${email}`; },
    async verifyIdToken() { return { uid: "dealer-1", role: "dealer", email_verified: true }; },
  };
  if (existingClaims) users.set("dealer-1", { uid: "dealer-1", email: "ava@mint.test", emailVerified: false, customClaims: existingClaims });
  const mail = [];
  const dependencies = {
    admin: { auth: () => auth }, database, storageStatusDatabase,
    FieldValue: { serverTimestamp: () => "server-time" },
    async sendActivationEmail(message) { mail.push(message); if (mailFails) throw new Error("Resend offline"); },
    frontendUrl: "https://mintmotor.test/dealer/login",
  };
  return { database, auth, users, mail, dependencies, storageStatusDatabase, createUserCalls };
}

test("approval preserves existing claims and creates linked approved records", async () => {
  const state = setup();
  const dealer = await approveDealer({ applicationId: "app-1", adminUid: "admin-1" }, state.dependencies);
  assert.deepEqual(state.users.get("dealer-1").customClaims, { existing: true, role: "dealer" });
  assert.equal(dealer.dealerStatus, DEALER_STATUS.APPROVED);
  assert.equal(state.database.data.get("dealerApplications").get("app-1").dealerId, "dealer-1");
  assert.equal(state.storageStatusDatabase.data.get("storageDealerStatus").get("dealer-1").dealerStatus, DEALER_STATUS.APPROVED);
  assert.equal(state.mail.length, 1);
  assert.match(state.mail[0].setupLink, /dealer@|ava@mint\.test/);
});

test("approval refuses to promote a main-site buyer or seller account", async () => {
  const state = setup({ existingClaims: { existing: true } });
  await assert.rejects(approveDealer({ applicationId: "app-1", adminUid: "admin-1" }, state.dependencies), (error) => error.statusCode === 409 && error.code === "EMAIL_IN_USE_MAIN");
  assert.deepEqual(state.users.get("dealer-1").customClaims, { existing: true });
  assert.equal(state.mail.length, 0);
});

test("new Auth users are created without a staff-chosen password", async () => {
  const state = setup({ existingClaims: null });
  await approveDealer({ applicationId: "app-1", adminUid: "admin-1" }, state.dependencies);
  assert.deepEqual(state.createUserCalls, [{ email: "ava@mint.test", emailVerified: false }]);
});

test("approval email failure keeps dealer approved and an approved retry does not resend", async () => {
  const state = setup({ mailFails: true });
  const first = await approveDealer({ applicationId: "app-1", adminUid: "admin-1" }, state.dependencies);
  const second = await approveDealer({ applicationId: "app-1", adminUid: "admin-1" }, state.dependencies);
  assert.equal(first.dealerStatus, DEALER_STATUS.APPROVED);
  assert.match(first.activationEmailLastError, /Resend offline/);
  assert.equal(second.dealerStatus, DEALER_STATUS.APPROVED);
  assert.equal(state.mail.length, 1);
});

test("dealer middleware reads live Firestore status on every request", async () => {
  const state = setup();
  await state.database.collection("dealers").doc("dealer-1").set({ dealerStatus: DEALER_STATUS.APPROVED });
  await state.storageStatusDatabase.collection("storageDealerStatus").doc("dealer-1").set({ dealerStatus: DEALER_STATUS.APPROVED });
  const middleware = createRequireDealer({ admin: { auth: () => state.auth }, database: state.database, storageStatusDatabase: state.storageStatusDatabase, USER_ROLES: { DEALER: "dealer" }, DEALER_STATUS });
  const invoke = async () => {
    let status = 200; let payload; let nextCalled = false;
    await middleware({ get: () => "Bearer token" }, { status(value) { status = value; return this; }, json(value) { payload = value; } }, () => { nextCalled = true; });
    return { status, payload, nextCalled };
  };
  assert.equal((await invoke()).nextCalled, true);
  await state.database.collection("dealers").doc("dealer-1").set({ dealerStatus: DEALER_STATUS.SUSPENDED }, { merge: true });
  await state.storageStatusDatabase.collection("storageDealerStatus").doc("dealer-1").set({ dealerStatus: DEALER_STATUS.SUSPENDED }, { merge: true });
  const suspended = await invoke();
  assert.equal(suspended.status, 403);
  assert.equal(suspended.payload.code, "dealer_inactive");
  assert.equal(suspended.nextCalled, false);
  await state.database.collection("dealers").doc("dealer-1").set({ dealerStatus: DEALER_STATUS.APPROVED }, { merge: true });
  await state.storageStatusDatabase.collection("storageDealerStatus").doc("dealer-1").set({ dealerStatus: DEALER_STATUS.SUSPENDED }, { merge: true });
  const staleStorageApproval = await invoke();
  assert.equal(staleStorageApproval.status, 403);
  assert.equal(staleStorageApproval.nextCalled, false);
  await state.database.collection("dealers").doc("dealer-1").set({ dealerStatus: DEALER_STATUS.APPROVED }, { merge: true });
  await state.storageStatusDatabase.collection("storageDealerStatus").doc("dealer-1").set({ dealerStatus: DEALER_STATUS.APPROVED }, { merge: true });
  state.auth.verifyIdToken = async () => ({ uid: "dealer-1", role: "dealer", email_verified: false });
  const unverified = await invoke();
  assert.equal(unverified.status, 403);
  assert.equal(unverified.payload.code, "email_unverified");
  assert.equal(unverified.nextCalled, false);
});
