# Dealer Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an approved-dealer activation flow and a securely private Dealer Network marketplace with dealer-only trade prices.

**Architecture:** Extend the Firebase/Express backend with dealer domain helpers, admin lifecycle endpoints, dealer authorization middleware, and private-listing endpoints. Extend the React app through typed API methods and isolated `/dealer/*` routes; browser guards are for experience only, while Firebase token verification plus live Firestore dealer status guard every protected response.

**Tech Stack:** React 18, TypeScript, React Router 6, TanStack Query, Tailwind/shadcn UI, Firebase Authentication/Admin/Firestore/Storage, Firebase Cloud Functions v2, Express 5, Node 22, Resend HTTP API, Vitest, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-25-dealer-foundation-design.md`

## Global Constraints

- Preserve the existing React/Firebase/Firestore/Express architecture and `/api` endpoint convention.
- Store and return all monetary values in GBP; never expose `tradePrice` through a public endpoint or public car mapper.
- Do not create, store, expose, or email dealer passwords; use a Firebase-generated, expiring password-reset/setup link.
- Keep Firebase `role: "dealer"` custom claims separate from Firestore `dealerStatus: "pending" | "approved" | "suspended"`.
- A Dealer Network listing is visible immediately after its approved owner publishes it; no listing moderation is introduced.
- Server authorization, not React route protection, is the security boundary; every private request must check token, dealer role, live approved status, verified email, and ownership where applicable.
- Do not implement subscriptions, billing, public dealer packages, individual-listing payment, quick sale, partners, leasing, EV filtering, or PostHog in this plan.

## Review Focus

- A dealer custom claim that remains after suspension must still produce a 403 from every dealer endpoint; test it in Task 2.
- A public caller who guesses a Dealer Network car ID must receive 404 and no `tradePrice`; test it in Task 3.
- A second approved dealer must never update, publish, delete, or read another dealer's editable inventory; test it in Task 3.
- A Resend failure after successful approval must preserve approved access, record a safe email error, and permit an explicit resend; test it in Task 2.
- A dealer who has set a password but has not verified their email must be shown the verification state and denied backend access; test it in Tasks 2 and 5.

---

## File Structure

- Create `backend/functions/dealers.js`: dealer domain constants, application normalization/validation, safe serializers, and lifecycle helpers that can be unit tested without Express.
- Create `backend/functions/dealers.test.js`: unit coverage for normalization, validation, public-safe serialization, and state transitions.
- Create `backend/functions/dealerEmail.js`: branded activation-email composition and Resend delivery adapter.
- Create `backend/functions/dealerEmail.test.js`: activation email escaping and delivery error coverage.
- Modify `backend/functions/validators.js`: add `DEALER_STATUS`, `DEALER_APPLICATION_STATUS`, `USER_ROLES.DEALER`, and application/listing validation exports.
- Modify `backend/functions/index.js`: add dealer middleware, lifecycle/public/admin/dealer endpoints, and public visibility filtering without changing existing customer behavior.
- Create `backend/functions/dealerRoutes.test.js`: endpoint-facing handler tests using injected Auth, Firestore, and mail dependencies.
- Modify `frontend/src/lib/data.ts`: add dealer and visibility fields to `Car` plus shared dealer types.
- Modify `frontend/src/lib/api.ts`: typed public, admin, and dealer API methods; no mock fallback for private requests.
- Create `frontend/src/lib/dealerAccess.ts`: pure `deriveDealerAccess` helper for route-state decisions.
- Create `frontend/src/lib/dealerAccess.test.ts`: state-mapping tests.
- Create `frontend/src/components/dealer/DealerRoute.tsx`: React guard that redirects anonymous callers and renders the correct non-approved state.
- Create `frontend/src/pages/dealer/DealerApply.tsx`, `DealerLogin.tsx`, `DealerDashboard.tsx`, `DealerNetwork.tsx`, `DealerNetworkDetail.tsx`, and `DealerListingForm.tsx`: dealer application, activation-aware login, dashboard, network, detail, and inventory form surfaces.
- Create companion `*.test.tsx` files for each dealer page/guard.
- Modify `frontend/src/App.tsx`: register all `/dealer/*` routes.
- Modify `frontend/src/pages/AdminDashboard.tsx`: add a dealer applications/dealers workspace and mutations backed by the new endpoints.
- Modify `frontend/src/pages/AdminDashboard.test.tsx` or create it if absent: test the admin dealer controls and error states.

### Task 1: Define Dealer Domain Primitives and Activation Email

**Files:**
- Create: `backend/functions/dealers.js`
- Create: `backend/functions/dealers.test.js`
- Create: `backend/functions/dealerEmail.js`
- Create: `backend/functions/dealerEmail.test.js`
- Modify: `backend/functions/validators.js`

**Interfaces:**
- Consumes: `normalizeUkPostcode`, `isValidUkPostcode`, and `asString`-style validation conventions from `validators.js`.
- Produces: `validateDealerApplication(payload)`, `normalizeDealerApplication(payload)`, `canTransitionApplication(from, to)`, `publicDealerCar(car)`, `buildDealerActivationEmail(input)`, and `sendDealerActivationEmail(input, config)`.

- [ ] **Step 1: Write failing unit tests for application validation and safe field selection**

```js
const { validateDealerApplication, publicDealerCar } = require("./dealers");

test("validateDealerApplication normalizes a valid UK business application", () => {
  const { application, errors } = validateDealerApplication({
    tradingName: "Mint Cars Ltd", contactName: "Ava Smith", email: "AVA@MINT.TEST ",
    telephone: "07700 900123", postcode: "sw1a1aa", addressLine1: "1 Dealer Way",
    dealerType: "independent", estimatedVehicleCount: 12,
  });
  assert.deepEqual(errors, []);
  assert.equal(application.email, "ava@mint.test");
  assert.equal(application.postcode, "SW1A 1AA");
});

test("publicDealerCar removes private trade fields", () => {
  const result = publicDealerCar({ id: "car-1", visibility: "dealer-network", tradePrice: 22500, ownerDealerId: "dealer-1" });
  assert.equal(result.tradePrice, undefined);
  assert.equal(result.ownerDealerId, undefined);
});
```

- [ ] **Step 2: Run the domain test to verify it fails**

Run: `npm test -- dealers.test.js`

Working directory: `backend/functions`

Expected: FAIL because `./dealers` does not exist.

- [ ] **Step 3: Implement constants, validation, state transitions, and safe serialization**

```js
const DEALER_STATUS = Object.freeze({ PENDING: "pending", APPROVED: "approved", SUSPENDED: "suspended" });
const DEALER_APPLICATION_STATUS = Object.freeze({ SUBMITTED: "submitted", UNDER_REVIEW: "under_review", APPROVED: "approved", REJECTED: "rejected" });

function publicDealerCar(car) {
  const { tradePrice, ownerDealerId, dealerContactEmail, dealerContactPhone, ...safe } = car;
  return safe;
}

function canTransitionApplication(from, to) {
  return new Set(["submitted:under_review", "submitted:rejected", "under_review:approved", "under_review:rejected"])
    .has(`${from}:${to}`);
}
```

Add `USER_ROLES.DEALER = "dealer"` and export validators that require trading name, contact name, normalized email, telephone, valid UK postcode, address line one, supported dealer type, and a non-negative integer estimated count. Keep optional company number, website, VAT number, and address line two bounded strings.

- [ ] **Step 4: Write failing unit tests for the branded activation email and Resend failure**

```js
const { buildDealerActivationEmail, sendDealerActivationEmail, DealerEmailDeliveryError } = require("./dealerEmail");

test("activation email uses the generated setup link without injecting business markup", () => {
  const email = buildDealerActivationEmail({ tradingName: "Cars < Ltd", setupLink: "https://auth.example/reset" });
  assert.match(email.html, /Cars &lt; Ltd/);
  assert.match(email.html, /https:\/\/auth\.example\/reset/);
});

test("Resend failure is represented as a retryable delivery error", async () => {
  await assert.rejects(() => sendDealerActivationEmail({}, { apiKey: "key", from: "Mint <noreply@mint.test>", fetchImplementation: async () => ({ ok: false }) }), DealerEmailDeliveryError);
});
```

- [ ] **Step 5: Implement activation email composition and delivery**

```js
async function sendDealerActivationEmail(input, { apiKey, from, fetchImplementation = fetch }) {
  if (!apiKey || !from) throw new DealerEmailDeliveryError("Resend is not configured.");
  const response = await fetchImplementation("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [input.to], ...buildDealerActivationEmail(input) }),
  });
  if (!response.ok) throw new DealerEmailDeliveryError("Resend rejected the dealer activation email.");
}
```

Use the escaping convention in `enquiryEmail.js`. The email must say that the recipient chooses their own password, should verify their email, and may request a new link if it expires.

- [ ] **Step 6: Run all new backend unit tests**

Run: `npm test -- dealers.test.js dealerEmail.test.js`

Working directory: `backend/functions`

Expected: PASS.

- [ ] **Step 7: Commit the domain primitives**

```bash
git add backend/functions/dealers.js backend/functions/dealers.test.js backend/functions/dealerEmail.js backend/functions/dealerEmail.test.js backend/functions/validators.js
git commit -m "feat: add dealer domain primitives"
```

### Task 2: Add Secure Dealer Application and Admin Lifecycle APIs

**Files:**
- Modify: `backend/functions/index.js`
- Create: `backend/functions/dealerRoutes.test.js`

**Interfaces:**
- Consumes: Task 1 helpers and existing `requireAdmin`, `admin.auth()`, `database`, `FieldValue`, and API CORS configuration.
- Produces: `requireDealer`, `POST /dealer-applications`, dealer status endpoint, application review/approval, activation resend, suspend, and reactivate admin endpoints.

- [ ] **Step 1: Write failing handler tests for approval, idempotency, email failure, and suspension**

```js
test("approval assigns dealer claim, creates the profile, and sends the setup link", async () => {
  const result = await approveDealer({ applicationId: "app-1", adminUid: "admin-1" }, deps);
  assert.equal(deps.auth.setCustomUserClaims.mock.calls[0].arguments[1].role, "dealer");
  assert.equal(result.dealerStatus, "approved");
});

test("approval retains approved status when activation delivery fails", async () => {
  deps.sendDealerActivationEmail.mock.rejects(new DealerEmailDeliveryError("offline"));
  const result = await approveDealer({ applicationId: "app-1", adminUid: "admin-1" }, deps);
  assert.equal(result.dealerStatus, "approved");
  assert.match(result.activationEmailLastError, /offline/);
});

test("requireDealer denies a suspended dealer even with a dealer claim", async () => {
  await expectMiddleware(requireDealer, { user: { uid: "dealer-1", role: "dealer", email_verified: true } }, 403);
});
```

- [ ] **Step 2: Run the lifecycle tests to verify they fail**

Run: `npm test -- dealerRoutes.test.js`

Working directory: `backend/functions`

Expected: FAIL because `approveDealer` and `requireDealer` are not exported/injectable.

- [ ] **Step 3: Implement explicit lifecycle services and dealer middleware**

```js
async function requireDealer(req, res, next) {
  await requireAuth(req, res, async () => {
    if (req.user.role !== USER_ROLES.DEALER) return res.status(403).json({ error: "Approved dealer access is required." });
    const snapshot = await database.collection("dealers").doc(req.user.uid).get();
    const dealer = snapshot.exists ? snapshot.data() : null;
    if (!dealer || dealer.dealerStatus !== DEALER_STATUS.APPROVED || req.user.email_verified !== true) {
      return res.status(403).json({ error: "Dealer access is not active." });
    }
    req.dealer = { id: req.user.uid, ...dealer };
    next();
  });
}
```

Implement `approveDealer` so it reads one approved/reviewable application, uses `getUserByEmail` then `createUser({ email, emailVerified: false })` only when absent, sets `{ role: "dealer" }`, merges `dealers/{uid}`, links the application, and generates `admin.auth().generatePasswordResetLink(email, { url: `${frontendUrl}/dealer/login` })`. Persist `activationEmailSentAt` on success or bounded `activationEmailLastError` on failure. Do not send a link during retry unless the dedicated resend endpoint is called.

- [ ] **Step 4: Add the public and admin Express routes with exact authorization rules**

```js
app.post("/dealer-applications", async (req, res) => {
  const { application, errors } = validateDealerApplication(req.body);
  if (errors.length) return res.status(400).json({ errors });
  const duplicate = await database.collection("dealerApplications")
    .where("email", "==", application.email).where("status", "in", ["submitted", "under_review"]).limit(1).get();
  if (!duplicate.empty) return res.status(409).json({ error: "An application already exists for this email." });
  const ref = await database.collection("dealerApplications").add({ ...application, status: "submitted", createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  return res.status(201).json({ application: serializeDealerApplication(await ref.get()) });
});
app.post("/admin/dealer-applications/:id/approve", requireAdmin, async (req, res) => {
  const dealer = await approveDealer({ applicationId: req.params.id, adminUid: req.user.uid });
  return res.json({ dealer: serializeDealer(dealer) });
});
app.post("/admin/dealers/:uid/suspend", requireAdmin, async (req, res) => {
  await database.collection("dealers").doc(req.params.uid).set({ dealerStatus: "suspended", suspendedBy: req.user.uid, suspendedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return res.json({ dealer: serializeDealer((await database.collection("dealers").doc(req.params.uid).get()).data()) });
});
app.post("/admin/dealers/:uid/reactivate", requireAdmin, async (req, res) => {
  await database.collection("dealers").doc(req.params.uid).set({ dealerStatus: "approved", reactivatedBy: req.user.uid, reactivatedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return res.json({ dealer: serializeDealer((await database.collection("dealers").doc(req.params.uid).get()).data()) });
});
app.post("/admin/dealers/:uid/resend-activation", requireAdmin, async (req, res) => {
  const dealer = await resendDealerActivation({ uid: req.params.uid, adminUid: req.user.uid });
  return res.json({ dealer: serializeDealer(dealer) });
});
app.get("/dealer/me", requireDealer, async (req, res) => res.json({ dealer: serializeDealer(req.dealer) }));
```

For application patching, accept only state changes allowed by `canTransitionApplication`; a rejection may include a bounded staff-only note. Never return the note to the applicant or dealer route.

- [ ] **Step 5: Run backend lifecycle coverage**

Run: `npm test -- dealerRoutes.test.js validators.test.js`

Working directory: `backend/functions`

Expected: PASS, including approval idempotency, duplicate prevention, email retry behavior, unverified and suspended denial, and admin denial.

- [ ] **Step 6: Commit the application lifecycle APIs**

```bash
git add backend/functions/index.js backend/functions/dealerRoutes.test.js
git commit -m "feat: add dealer approval lifecycle"
```

### Task 3: Implement Private Dealer Network Listing and Enquiry APIs

**Files:**
- Modify: `backend/functions/index.js`
- Modify: `backend/functions/dealers.js`
- Modify: `backend/functions/dealers.test.js`
- Modify: `backend/functions/dealerRoutes.test.js`

**Interfaces:**
- Consumes: `requireDealer`, `publicDealerCar`, existing car validation, `LISTING_STATUS`, and dealer profile IDs from Task 2.
- Produces: dealer-only inventory/network/enquiry routes and public route filtering for `visibility`.

- [ ] **Step 1: Write failing tests for non-leakage, ownership, and immediate publication**

```js
test("public list excludes a published dealer-network vehicle", async () => {
  const response = await request(app).get("/cars");
  assert.deepEqual(response.body.cars.map((car) => car.id), ["public-1"]);
});

test("dealer network detail exposes trade price only to another approved dealer", async () => {
  const response = await dealerRequest("dealer-2").get("/dealer/network/network-1");
  assert.equal(response.body.car.tradePrice, 22500);
});

test("a second dealer cannot publish the first dealer's draft", async () => {
  const response = await dealerRequest("dealer-2").post("/dealer/cars/network-1/publish");
  assert.equal(response.status, 403);
});
```

- [ ] **Step 2: Run private-listing tests to verify they fail**

Run: `npm test -- dealerRoutes.test.js dealers.test.js`

Working directory: `backend/functions`

Expected: FAIL because dealer inventory/network routes and visibility filtering do not exist.

- [ ] **Step 3: Extend the vehicle schema and isolate the private route family**

```js
app.post("/dealer/cars", requireDealer, async (req, res) => {
  const { listing, errors } = validateDealerListingPayload(req.body);
  if (errors.length) return res.status(400).json({ errors });
  const ref = await database.collection("cars").add({
    ...listing, ownerId: req.dealer.id, ownerDealerId: req.dealer.id, ownerType: "dealer",
    visibility: "dealer-network", status: LISTING_STATUS.DRAFT,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  res.status(201).json({ car: serializeDealerCar(await ref.get()) });
});
```

Implement `GET /dealer/cars`, `GET|PATCH|DELETE /dealer/cars/:id`, and `POST /dealer/cars/:id/publish` with `ownerDealerId === req.dealer.id` checks. Reuse the current publish validation and location/history processing, but do not call subscription checks. `GET /dealer/network` and `GET /dealer/network/:id` return only published `visibility === "dealer-network"` records belonging to approved dealers and include `tradePrice`. `POST /dealer/network/:id/enquiries` rejects self-enquiries, validates a 10–2,000 character message, then writes a `dealerEnquiries` document; `GET /dealer/enquiries` returns only buyer/seller records tied to the caller.

Modify public `/cars` and `/cars/:id` so they explicitly require `visibility !== "dealer-network"` for non-owners and pass every response through `publicCar` then `publicDealerCar`.

- [ ] **Step 4: Add a regression test for accidental public serialization**

```js
test("public dealer mapper drops trade price even when a future query returns a private car", () => {
  const safe = publicDealerCar({ id: "private-1", price: 24995, tradePrice: 22500, ownerDealerId: "dealer-1" });
  assert.deepEqual(safe, { id: "private-1", price: 24995 });
});
```

- [ ] **Step 5: Run the complete backend test suite**

Run: `npm test`

Working directory: `backend/functions`

Expected: PASS.

- [ ] **Step 6: Commit private marketplace APIs**

```bash
git add backend/functions/index.js backend/functions/dealers.js backend/functions/dealers.test.js backend/functions/dealerRoutes.test.js
git commit -m "feat: add private dealer network listings"
```

### Task 4: Add Typed Dealer Client APIs and Access-State Guarding

**Files:**
- Modify: `frontend/src/lib/data.ts`
- Modify: `frontend/src/lib/api.ts`
- Create: `frontend/src/lib/dealerAccess.ts`
- Create: `frontend/src/lib/dealerAccess.test.ts`
- Create: `frontend/src/lib/api.dealer.test.ts`
- Create: `frontend/src/components/dealer/DealerRoute.tsx`
- Create: `frontend/src/components/dealer/DealerRoute.test.tsx`

**Interfaces:**
- Consumes: API response shapes from Tasks 2–3 and current `request(path, options, token)` API helper.
- Produces: `Dealer`, `DealerApplication`, `DealerAccess`, `getDealerMe`, `getDealerCars`, `getDealerNetwork`, `getDealerNetworkCar`, `deriveDealerAccess`, and `<DealerRoute>`.

- [ ] **Step 1: Write failing tests for API auth headers and access-state mapping**

```ts
it("uses a bearer token for Dealer Network requests", async () => {
  await getDealerNetwork("dealer-token");
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/dealer/network"), expect.objectContaining({ headers: expect.any(Headers) }));
  expect(new Headers((fetch as Mock).mock.calls[0][1].headers).get("Authorization")).toBe("Bearer dealer-token");
});

it("maps an approved but unverified dealer to the verification state", () => {
  expect(deriveDealerAccess({ dealerStatus: "approved", emailVerified: false })).toBe("verify-email");
});
```

- [ ] **Step 2: Run client helper tests to verify they fail**

Run: `npm test -- src/lib/dealerAccess.test.ts src/lib/api.dealer.test.ts`

Working directory: `frontend`

Expected: FAIL because the new types/functions do not exist.

- [ ] **Step 3: Implement typed request methods and pure route-state mapping**

```ts
export type DealerStatus = "pending" | "approved" | "suspended";
export type DealerAccess = "ready" | "verify-email" | "pending" | "suspended" | "denied";

export function deriveDealerAccess(dealer?: Pick<Dealer, "dealerStatus" | "emailVerified">): DealerAccess {
  if (!dealer) return "denied";
  if (dealer.dealerStatus === "suspended") return "suspended";
  if (dealer.dealerStatus !== "approved") return "pending";
  return dealer.emailVerified ? "ready" : "verify-email";
}

export function getDealerNetwork(token: string) {
  return request<DealerCarsResponse>("/dealer/network", {}, token);
}
```

Extend `Car` with `ownerType?: "individual" | "dealer"`, `ownerDealerId?: string`, `visibility?: "public" | "dealer-network"`, and `tradePrice?: number`. Do not use `getCars` mock fallback for a dealer function. `DealerRoute` obtains a fresh Firebase token, requests `/dealer/me`, renders semantic status copy, and renders children only for `ready`.

- [ ] **Step 4: Write and run guard rendering tests**

```tsx
it("redirects an anonymous visitor to dealer login with the intended next route", async () => {
  render(<DealerRoute><div>Dealer dashboard</div></DealerRoute>, { wrapper: routerAt("/dealer/dashboard") });
  expect(await screen.findByRole("link", { name: /dealer sign in/i })).toHaveAttribute("href", expect.stringContaining("/dealer/login?next="));
});
```

Run: `npm test -- src/lib/dealerAccess.test.ts src/lib/api.dealer.test.ts src/components/dealer/DealerRoute.test.tsx`

Working directory: `frontend`

Expected: PASS.

- [ ] **Step 5: Commit typed dealer client infrastructure**

```bash
git add frontend/src/lib/data.ts frontend/src/lib/api.ts frontend/src/lib/dealerAccess.ts frontend/src/lib/dealerAccess.test.ts frontend/src/lib/api.dealer.test.ts frontend/src/components/dealer/DealerRoute.tsx frontend/src/components/dealer/DealerRoute.test.tsx
git commit -m "feat: add dealer client access controls"
```

### Task 5: Build Dealer Application, Login, Dashboard, and Network Pages

**Files:**
- Create: `frontend/src/pages/dealer/DealerApply.tsx`
- Create: `frontend/src/pages/dealer/DealerApply.test.tsx`
- Create: `frontend/src/pages/dealer/DealerLogin.tsx`
- Create: `frontend/src/pages/dealer/DealerLogin.test.tsx`
- Create: `frontend/src/pages/dealer/DealerDashboard.tsx`
- Create: `frontend/src/pages/dealer/DealerDashboard.test.tsx`
- Create: `frontend/src/pages/dealer/DealerListingForm.tsx`
- Create: `frontend/src/pages/dealer/DealerListingForm.test.tsx`
- Create: `frontend/src/pages/dealer/DealerNetwork.tsx`
- Create: `frontend/src/pages/dealer/DealerNetworkDetail.tsx`
- Create: `frontend/src/pages/dealer/DealerNetwork.test.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: Task 4 API methods/guard, current `Layout`, UI primitives, `useAuth`, and `CarCard` visual conventions.
- Produces: public `/dealer/apply`, `/dealer/login`, protected `/dealer/dashboard`, `/dealer/inventory/new`, `/dealer/network`, and `/dealer/network/:id` routes.

- [ ] **Step 1: Write failing page tests for the public application and dealer activation state**

```tsx
it("submits all required business details and shows a neutral review confirmation", async () => {
  render(<DealerApply />);
  await user.type(screen.getByLabelText(/trading name/i), "Mint Cars Ltd");
  await user.type(screen.getByLabelText(/contact name/i), "Ava Smith");
  await user.type(screen.getByLabelText(/^email/i), "ava@mint.test");
  await user.type(screen.getByLabelText(/telephone/i), "07700 900123");
  await user.type(screen.getByLabelText(/postcode/i), "SW1A 1AA");
  await user.type(screen.getByLabelText(/address line 1/i), "1 Dealer Way");
  await user.selectOptions(screen.getByLabelText(/dealer type/i), "independent");
  await user.type(screen.getByLabelText(/estimated vehicles/i), "12");
  await user.click(screen.getByRole("button", { name: /submit application/i }));
  expect(await screen.findByRole("status")).toHaveTextContent(/review/i);
});

it("tells an unverified approved dealer to verify email instead of rendering inventory", async () => {
  mockDealerMe({ dealerStatus: "approved", emailVerified: false });
  render(<DealerDashboard />);
  expect(await screen.findByText(/verify your email/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run page tests to verify they fail**

Run: `npm test -- src/pages/dealer/DealerApply.test.tsx src/pages/dealer/DealerLogin.test.tsx src/pages/dealer/DealerDashboard.test.tsx src/pages/dealer/DealerNetwork.test.tsx`

Working directory: `frontend`

Expected: FAIL because dealer pages and routes do not exist.

- [ ] **Step 3: Implement application and login experiences**

```tsx
<form onSubmit={form.handleSubmit((payload) => submitDealerApplication(payload))}>
  <Input {...form.register("tradingName")} aria-label="Trading name" />
  <Input {...form.register("postcode")} aria-label="Postcode" />
  <Button type="submit">Submit application</Button>
</form>
```

Use React Hook Form/Zod for the same required fields enforced by the server. Include optional company number, website, VAT number, and address line two. `DealerLogin` uses only `signIn(email, password)`, links to Firebase password recovery, and navigates to `next` only after `/dealer/me` yields `ready`; it must not offer Google sign-in or public sign-up as a dealer-account creation route.

- [ ] **Step 4: Implement dashboard, inventory form, and private discovery pages**

```tsx
<DealerRoute>
  <Layout><DealerDashboard /></Layout>
</DealerRoute>
```

The dashboard uses TanStack Query for inventory/enquiries and contains links to create a listing and browse the network. The inventory form calls only dealer APIs, sets `visibility: "dealer-network"`, requires a GBP `tradePrice`, and presents immediate-publish action after valid draft creation. The network list uses `getDealerNetwork`; the detail page displays `tradePrice` only inside `DealerRoute`, offers a message form, and blocks self-enquiries. Reuse accessible labels, status/alert regions, and loading/error patterns already used in `CarContactCard` and admin pages.

- [ ] **Step 5: Register exact routes and test visibility behavior**

```tsx
<Route path="/dealer/apply" element={<DealerApply />} />
<Route path="/dealer/login" element={<DealerLogin />} />
<Route path="/dealer/dashboard" element={<DealerRoute><DealerDashboard /></DealerRoute>} />
<Route path="/dealer/inventory/new" element={<DealerRoute><DealerListingForm /></DealerRoute>} />
<Route path="/dealer/network" element={<DealerRoute><DealerNetwork /></DealerRoute>} />
<Route path="/dealer/network/:id" element={<DealerRoute><DealerNetworkDetail /></DealerRoute>} />
```

Run: `npm test -- src/pages/dealer/DealerApply.test.tsx src/pages/dealer/DealerLogin.test.tsx src/pages/dealer/DealerDashboard.test.tsx src/pages/dealer/DealerListingForm.test.tsx src/pages/dealer/DealerNetwork.test.tsx`

Working directory: `frontend`

Expected: PASS, including no trade-price copy on any public-page fixture.

- [ ] **Step 6: Commit the dealer experiences**

```bash
git add frontend/src/pages/dealer frontend/src/App.tsx
git commit -m "feat: add dealer portal pages"
```

### Task 6: Extend the Existing Admin Area for Dealer Decisions

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/pages/AdminDashboard.tsx`
- Create: `frontend/src/pages/AdminDashboard.test.tsx`

**Interfaces:**
- Consumes: typed `DealerApplication` and admin lifecycle APIs from Tasks 2 and 4, current admin-token acquisition, tabs, tables, mutations, and query invalidation conventions.
- Produces: a `dealers` admin tab with application review, approve/reject, suspend/reactivate, and activation resend controls.

- [ ] **Step 1: Write failing admin UI tests**

```tsx
it("requires confirmation before approving a dealer application", async () => {
  mockAdminDealerApplications([{ id: "app-1", tradingName: "Mint Cars", status: "under_review" }]);
  render(<AdminDashboard />);
  await user.click(await screen.findByRole("tab", { name: /dealers/i }));
  await user.click(screen.getByRole("button", { name: /approve mint cars/i }));
  expect(screen.getByRole("dialog")).toHaveTextContent(/send an activation email/i);
});

it("shows a resend activation action after an email delivery error", async () => {
  mockAdminDealerApplications([{ id: "app-1", dealerStatus: "approved", activationEmailLastError: "Unable to reach Resend." }]);
  render(<AdminDashboard />);
  expect(await screen.findByRole("button", { name: /resend activation/i })).toBeEnabled();
});
```

- [ ] **Step 2: Run the admin UI test to verify it fails**

Run: `npm test -- src/pages/AdminDashboard.test.tsx`

Working directory: `frontend`

Expected: FAIL because the dealer tab, API methods, and confirmation dialog do not exist.

- [ ] **Step 3: Implement typed admin methods and dealer workspace**

```ts
export function approveDealerApplication(id: string, token: string) {
  return request<{ dealer: Dealer }>(`/admin/dealer-applications/${id}/approve`, { method: "POST" }, token);
}
export function resendDealerActivation(uid: string, token: string) {
  return request<{ dealer: Dealer }>(`/admin/dealers/${uid}/resend-activation`, { method: "POST" }, token);
}
```

Add `dealers` to `AdminTab`; use a dedicated query key `admin-dealer-applications`. Render separate application and active-dealer table sections. Approval uses `AlertDialog` with language that access is created and the activation email will be sent. Rejection exposes a staff-only note field. Suspend/reactivate/resend operations are mutations that invalidate dealer applications and summary queries, expose success status, and preserve a retryable error message.

- [ ] **Step 4: Run the admin UI test and full frontend suite**

Run: `npm test`

Working directory: `frontend`

Expected: PASS.

- [ ] **Step 5: Commit the admin dealer workspace**

```bash
git add frontend/src/lib/api.ts frontend/src/pages/AdminDashboard.tsx frontend/src/pages/AdminDashboard.test.tsx
git commit -m "feat: manage dealer applications in admin"
```

### Task 7: Verify the Integrated Security Boundary and Deployment Configuration

**Files:**
- Modify: `backend/functions/README.md`
- Modify: `frontend/README.md`
- Modify: relevant existing test fixtures only when required by the new `Car` fields

**Interfaces:**
- Consumes: all prior completed interfaces.
- Produces: deployment documentation for required protected configuration and passing full test/build verification.

- [ ] **Step 1: Write a regression test matrix covering cross-role requests**

```js
test("cross-role matrix prevents private-car leakage", async () => {
  await assertStatus(publicRequest().get("/dealer/network/network-1"), 401);
  await assertStatus(customerRequest().get("/dealer/network/network-1"), 403);
  await assertStatus(suspendedDealerRequest().get("/dealer/network/network-1"), 403);
  await assertStatus(approvedDealerRequest().get("/dealer/network/network-1"), 200);
});
```

- [ ] **Step 2: Run the cross-role test before final hardening**

Run: `npm test -- dealerRoutes.test.js`

Working directory: `backend/functions`

Expected: PASS; any route that returns a private record to another role is a release blocker.

- [ ] **Step 3: Document exact runtime configuration and operational steps**

Add these required deployment variables to `backend/functions/README.md` without values:

```text
RESEND_API_KEY
RESEND_FROM_EMAIL
DEALER_ACTIVATION_CONTINUE_URL=https://mintmotor.co.uk/dealer/login
```

Document that the Firebase Authentication authorized domains and reset-email action settings must include `mintmotor.co.uk`, that the Resend sender domain must be verified, and that an administrator must have the existing admin claim/profile before reviewing applications. In `frontend/README.md`, document the dealer route set and the fact that a Firebase email verification refresh is required before dashboard access.

- [ ] **Step 4: Run all production-quality verification commands**

Run: `npm test`

Working directory: `backend/functions`

Expected: PASS.

Run: `npm test`

Working directory: `frontend`

Expected: PASS.

Run: `npm run build`

Working directory: `frontend`

Expected: successful Vite production build with no TypeScript errors.

- [ ] **Step 5: Inspect the final diff for unsafe fields and unrelated changes**

Run: `git diff --check HEAD~7..HEAD && git diff HEAD~7..HEAD -- backend/functions/index.js backend/functions/dealers.js frontend/src/lib/api.ts frontend/src/pages/dealer`

Expected: no whitespace errors; no public serializer includes `tradePrice`; no unrelated pre-existing files are staged.

- [ ] **Step 6: Commit docs and final verification changes**

```bash
git add backend/functions/README.md frontend/README.md backend/functions/dealerRoutes.test.js
git commit -m "docs: document dealer platform setup"
```
