# Marketplace Legal and Billing Go-Live Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a UK marketplace legal-information surface and a reliable Stripe subscription lifecycle for Mintmotor's private-seller and dealer plans.

**Architecture:** The frontend owns readable, versioned legal content, consent UI, footer links, and account entry points. Firebase Functions owns consent persistence, Stripe Checkout/Customer Portal creation, signed-event processing, and moderation records; Firestore stores auditable acceptance, subscription, and report data.

**Tech Stack:** React 18, TypeScript, React Router, Vitest, Firebase Functions v2, Express, Firebase Admin/Firestore, Stripe Node SDK, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-27-marketplace-legal-billing-go-live-design.md`

## Global Constraints

- MINTMOTOR LTD is company number 14142260, registered at 122/6 Wicker, Sheffield, England, S3 8JD; public support contact is `worldcomponents.it@gmail.com`.
- Mintmotor is a marketplace only, not the seller or payment processor for listed vehicles.
- The public seller plan is £10 per calendar month, auto-renews, and begins immediately after explicit acknowledgement.
- Stripe Tax and `automatic_tax` remain disabled; do not describe prices as VAT-inclusive.
- Each paid dealer tier has a separate Stripe Product and a calendar-month Price in the deployed key's Stripe account and mode.
- Use Stripe Checkout in subscription mode; do not pass `payment_method_types`.
- Never grant, retain, or revoke paid access solely from a browser success page; use verified Stripe state.
- Legal-policy copy must receive UK solicitor approval before production publication.

## Review Focus

- A user without the immediate-service acknowledgement must not be able to create a Checkout Session; Task 2 owns this test.
- A user must never receive a Customer Portal session for another account; Task 3 owns this test.
- A duplicate Stripe event must not duplicate acceptance/audit effects or regress the current subscription state; Task 4 owns this test.
- A missing, inactive, wrong-account, or wrong-mode Price must fail safely without exposing a secret; Task 4 owns this test.
- A rejected-cookie choice must prevent non-essential scripts from loading and remain respected after navigation; Task 6 owns this test.

---

## File structure

- `frontend/src/lib/legal.ts` — canonical company details, legal page metadata, effective policy version, and approved policy copy.
- `frontend/src/pages/Legal.tsx` — route-driven accessible rendering of legal pages.
- `frontend/src/components/layout/Footer.tsx` — permanent legal navigation and corrected Mintmotor contact details.
- `frontend/src/pages/Sellpages/SellerSubscription.tsx` and `frontend/src/pages/dealer/DealerPlan.tsx` — price/cadence disclosure, policy acknowledgement, and billing-management entry points.
- `frontend/src/lib/api.ts` — typed checkout, portal, and listing-report client functions.
- `frontend/src/components/CookieConsent.tsx` — consent collection, persistence, and non-essential-script gate.
- `frontend/src/pages/CarDetail.tsx` — listing report affordance.
- `backend/functions/index.js` — Checkout, Customer Portal, signed Stripe-event, acceptance, and listing-report routes.
- `backend/functions/legal.js` — backend legal constants and request validation kept separate from the large route module.
- `backend/functions/billing.js` — Stripe Price validation, portal-session, event-idempotency, subscription-state, and acceptance helpers.
- `backend/functions/legal.test.js`, `backend/functions/billing.test.js`, and `backend/functions/reporting.test.js` — isolated Node tests for the new backend units.

### Task 1: Publish versioned legal pages and correct marketplace identity

**Files:**
- Create: `frontend/src/lib/legal.ts`
- Create: `frontend/src/pages/Legal.tsx`
- Create: `frontend/src/pages/Legal.test.tsx`
- Create: `frontend/src/components/layout/Footer.test.tsx`
- Modify: `frontend/src/App.tsx:55-103`
- Modify: `frontend/src/components/layout/Footer.tsx:4-44`

**Interfaces:**
- Produces: `LEGAL_POLICY_VERSION: string`, `LEGAL_PAGES: Record<LegalPageSlug, LegalPageDefinition>`, and `LegalPage` route component.
- Consumes: React Router `useParams`, `Link`, and the existing `Layout` component.

- [ ] **Step 1: Write failing legal-page and footer tests**

```tsx
it("renders the privacy notice with Mintmotor's legal identity", () => {
  render(<MemoryRouter initialEntries={["/legal/privacy"]}><LegalPage /></MemoryRouter>);
  expect(screen.getByText(/MINTMOTOR LTD/i)).toBeInTheDocument();
  expect(screen.getByText(/14142260/)).toBeInTheDocument();
});

it("links every required policy from the footer", () => {
  render(<MemoryRouter><Footer /></MemoryRouter>);
  expect(screen.getByRole("link", { name: /privacy/i })).toHaveAttribute("href", "/legal/privacy");
  expect(screen.getByRole("link", { name: /refunds and cancellation/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the new frontend tests and verify they fail because the routes/content do not exist**

Run: `npm --prefix frontend test -- --run src/pages/Legal.test.tsx src/components/layout/Footer.test.tsx`

Expected: FAIL because `LegalPage` and legal footer links are absent.

- [ ] **Step 3: Implement `LEGAL_PAGES` and `LegalPage`**

Create pages for Terms of Use, Marketplace Rules, Seller and Dealer Subscription Terms, Privacy, Cookies, Refunds and Cancellation, and Complaints. Render clear headings, effective date/version, Mintmotor's legal identity and support address; make the marketplace-only role explicit. Keep policy sections in `legal.ts` rather than duplicating business identity across components. Add `/legal/:slug` routes and footer links, replacing the placeholder email, phone, and London address.

- [ ] **Step 4: Run the focused frontend tests and verify they pass**

Run: `npm --prefix frontend test -- --run src/pages/Legal.test.tsx src/components/layout/Footer.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the legal-content surface**

```bash
git add frontend/src/lib/legal.ts frontend/src/pages/Legal.tsx frontend/src/pages/Legal.test.tsx frontend/src/components/layout/Footer.tsx frontend/src/components/layout/Footer.test.tsx frontend/src/App.tsx
git commit -m "feat: add marketplace legal pages"
```

### Task 2: Require and record informed immediate-service acknowledgement

**Files:**
- Create: `backend/functions/legal.js`
- Create: `backend/functions/legal.test.js`
- Modify: `backend/functions/index.js:628-662`
- Modify: `backend/functions/index.js:794-820`
- Modify: `frontend/src/lib/api.ts:271,484-486`
- Modify: `frontend/src/pages/Sellpages/SellerSubscription.tsx:61-142`
- Modify: `frontend/src/pages/dealer/DealerPlan.tsx:45-87`
- Create: `frontend/src/pages/Sellpages/SellerSubscription.test.tsx`

**Interfaces:**
- Produces: `validateSubscriptionAcknowledgement(input): { policyVersion: string, immediateServiceAcknowledged: true } | { errors: string[] }`.
- Produces: `recordSubscriptionAcceptance({ userId, customerType, policyVersion, checkoutSessionId, immediateServiceAcknowledged }, dependencies): Promise<void>`.
- Consumes: Checkout request body `{ policyVersion: string; immediateServiceAcknowledged: boolean }` for seller and dealer endpoints.

- [ ] **Step 1: Write failing acknowledgement validation and UI tests**

```js
test("rejects checkout when immediate service is not acknowledged", () => {
  assert.deepEqual(validateSubscriptionAcknowledgement({ policyVersion: "2026-09-27", immediateServiceAcknowledged: false }).errors,
    ["You must request immediate subscription access before continuing."]);
});
```

```tsx
it("keeps Continue to subscription disabled until acknowledgement is checked", () => {
  render(<SellerSubscription />);
  expect(screen.getByRole("button", { name: /continue to subscription/i })).toBeDisabled();
});
```

- [ ] **Step 2: Run the focused tests and verify they fail for the missing acknowledgement contract**

Run: `npm --prefix backend/functions test -- legal.test.js && npm --prefix frontend test -- --run src/pages/Sellpages/SellerSubscription.test.tsx`

Expected: FAIL because checkout has no acknowledgement input or validator.

- [ ] **Step 3: Implement the acknowledgement contract and Firestore audit record**

Use one current `LEGAL_POLICY_VERSION` shared with the frontend request. Persist acceptance in `subscriptionAcceptances` with user/dealer ID, customer type, version, acknowledgement boolean, created timestamp, and Checkout Session ID after creation. Reject missing/stale version and false acknowledgement with HTTP 400. Make seller and dealer plan screens show the £10/month or tier price, calendar-month renewal, immediate-service wording, and policy links beside an initially unchecked control.

- [ ] **Step 4: Run focused tests and verify they pass**

Run: `npm --prefix backend/functions test -- legal.test.js && npm --prefix frontend test -- --run src/pages/Sellpages/SellerSubscription.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit acknowledgement and audit support**

```bash
git add backend/functions/legal.js backend/functions/legal.test.js backend/functions/index.js frontend/src/lib/api.ts frontend/src/pages/Sellpages/SellerSubscription.tsx frontend/src/pages/Sellpages/SellerSubscription.test.tsx frontend/src/pages/dealer/DealerPlan.tsx
git commit -m "feat: record subscription acceptance"
```

### Task 3: Add owner-safe Stripe Customer Portal access

**Files:**
- Create: `backend/functions/billing.js`
- Create: `backend/functions/billing.test.js`
- Modify: `backend/functions/index.js:454-531`
- Modify: `backend/functions/index.js:607-662`
- Modify: `backend/functions/index.js:781-820`
- Modify: `frontend/src/lib/api.ts:270-271,480-486`
- Modify: `frontend/src/pages/MyListings.tsx:190-230`
- Modify: `frontend/src/pages/dealer/DealerPlan.tsx:69-87`

**Interfaces:**
- Produces: `createCustomerPortalSession({ stripe, customerId, returnUrl }): Promise<{ url: string }>`.
- Produces: authenticated `POST /billing/customer-portal` and `POST /dealer/billing/customer-portal` returning `{ url: string }`.
- Consumes: the caller's own `stripeCustomerId` or `stripeDealerCustomerId` stored in Firestore.

- [ ] **Step 1: Write failing portal ownership and unavailable-customer tests**

```js
test("creates a portal session only for the authenticated user's customer ID", async () => {
  const result = await createPortalForUser({ uid: "user-a" }, dependencies);
  assert.equal(stripe.billingPortal.sessions.create.mock.calls[0][0].customer, "cus-user-a");
});

test("returns 409 when the caller has no Stripe customer", async () => {
  const response = await invokePortalRoute({ uid: "user-without-customer" });
  assert.equal(response.status, 409);
});
```

- [ ] **Step 2: Run billing tests and verify the portal behaviours fail**

Run: `npm --prefix backend/functions test -- billing.test.js`

Expected: FAIL because no portal helper or route exists.

- [ ] **Step 3: Implement the portal routes and account controls**

Create portal sessions with the stored caller-owned customer ID and a trusted frontend return URL. Do not accept a customer ID from the client. Add a “Manage subscription” button in seller and dealer account screens, handle the no-customer status with useful copy, and redirect only to the returned Stripe URL.

- [ ] **Step 4: Run billing and relevant frontend tests and verify they pass**

Run: `npm --prefix backend/functions test -- billing.test.js && npm --prefix frontend test -- --run src/lib/api.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Customer Portal support**

```bash
git add backend/functions/billing.js backend/functions/billing.test.js backend/functions/index.js frontend/src/lib/api.ts frontend/src/pages/MyListings.tsx frontend/src/pages/dealer/DealerPlan.tsx
git commit -m "feat: add subscription management portal"
```

### Task 4: Make Stripe billing state idempotent and production-safe

**Files:**
- Modify: `backend/functions/billing.js`
- Modify: `backend/functions/billing.test.js`
- Modify: `backend/functions/index.js:77-101,472-531,628-662,794-820`
- Modify: `backend/functions/.env.example:1-15`
- Modify: `backend/README.md:20-48`

**Interfaces:**
- Produces: `validateRecurringPrice({ stripe, priceId, expectedAmount, expectedCurrency }): Promise<{ id: string }>`.
- Produces: `processStripeEventOnce(event, dependencies): Promise<{ processed: boolean }>`.
- Consumes: `stripeEventReceipts/{event.id}` Firestore records and Stripe webhook events.

- [ ] **Step 1: Write failing Price-validation, duplicate-event, and failed-payment tests**

```js
test("returns a configuration error when the Price does not belong to the current Stripe account", async () => {
  await assert.rejects(() => validateRecurringPrice({ stripe, priceId: "price_missing", expectedAmount: 1000, expectedCurrency: "gbp" }), /not configured/i);
});

test("does not process the same Stripe event twice", async () => {
  await processStripeEventOnce(event, dependencies);
  const duplicate = await processStripeEventOnce(event, dependencies);
  assert.equal(duplicate.processed, false);
});
```

- [ ] **Step 2: Run billing tests and verify they fail with the current direct event flow**

Run: `npm --prefix backend/functions test -- billing.test.js`

Expected: FAIL because Price validation and event receipts are absent.

- [ ] **Step 3: Implement verified Price and event processing**

Validate the configured recurring GBP Price before creating seller/dealer Checkout Sessions; validate a calendar-month interval and the configured amount where the tier defines one. Map Stripe `resource_missing`, inactive, currency, interval, or amount failures to a safe 503 configuration message. Persist event receipts transactionally before applying state. Process `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed`; update stored status and current-period data from Stripe's subscription object. Failed-payment state must prevent new paid publishing once Stripe marks the subscription non-active.

- [ ] **Step 4: Document live configuration without committing secrets**

List every required live environment variable, require live `price_...` IDs for the same Stripe account as the live key, and state that the seller Price is £10/GBP/calendar-month. Keep all secret values out of `.env.example` and documentation.

- [ ] **Step 5: Run backend tests and verify they pass**

Run: `npm --prefix backend/functions test`

Expected: PASS, including existing tests.

- [ ] **Step 6: Commit resilient billing lifecycle handling**

```bash
git add backend/functions/billing.js backend/functions/billing.test.js backend/functions/index.js backend/functions/.env.example backend/README.md
git commit -m "feat: harden Stripe subscription lifecycle"
```

### Task 5: Add authenticated listing reports and a complaint audit trail

**Files:**
- Create: `backend/functions/reporting.js`
- Create: `backend/functions/reporting.test.js`
- Modify: `backend/functions/index.js:822-825`
- Modify: `frontend/src/lib/api.ts:469-474`
- Modify: `frontend/src/pages/CarDetail.tsx`
- Create: `frontend/src/pages/CarDetail.report.test.tsx`

**Interfaces:**
- Produces: `validateListingReport(payload): { category: string, description: string, errors: string[] }`.
- Produces: authenticated `POST /cars/:id/reports` returning `{ report: { id, status } }`.
- Consumes: `{ category: "misleading" | "fraud" | "illegal" | "other"; description: string }`.

- [ ] **Step 1: Write failing report validation and UI tests**

```js
test("rejects an unauthenticated or empty listing report", async () => {
  const response = await invokeReportRoute({ user: null, body: { category: "fraud", description: "" } });
  assert.equal(response.status, 401);
});

test("stores a valid report with submitted status", async () => {
  const report = await createListingReport({ reporterId: "user-1", carId: "car-1", category: "misleading", description: "Registration does not match the photos." }, dependencies);
  assert.equal(report.status, "submitted");
});
```

- [ ] **Step 2: Run report tests and verify they fail because no report route exists**

Run: `npm --prefix backend/functions test -- reporting.test.js`

Expected: FAIL because the report helper and route are absent.

- [ ] **Step 3: Implement report storage and the car-detail action**

Store reporter ID, listing ID, category, description, `submitted` status, created/updated timestamps, and no public reporter identity. Add an authenticated car-detail action with clear marketplace/complaints context and a success/error state. Link the formal complaints page for non-listing concerns.

- [ ] **Step 4: Run focused tests and verify they pass**

Run: `npm --prefix backend/functions test -- reporting.test.js && npm --prefix frontend test -- --run src/pages/CarDetail.report.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit reporting support**

```bash
git add backend/functions/reporting.js backend/functions/reporting.test.js backend/functions/index.js frontend/src/lib/api.ts frontend/src/pages/CarDetail.tsx frontend/src/pages/CarDetail.report.test.tsx
git commit -m "feat: add marketplace listing reports"
```

### Task 6: Add consent-first cookie controls and complete the release checklist

**Files:**
- Create: `frontend/src/components/CookieConsent.tsx`
- Create: `frontend/src/components/CookieConsent.test.tsx`
- Modify: `frontend/src/App.tsx:53-104`
- Modify: `frontend/src/lib/legal.ts`
- Modify: `backend/README.md:20-48`

**Interfaces:**
- Produces: `CookieConsent` using `localStorage` key `mintmotor.cookie-consent.v1` with values `accepted` or `rejected`.
- Consumes: optional `loadNonEssentialServices(): void` injection for testable post-consent activation.

- [ ] **Step 1: Write failing consent tests**

```tsx
it("does not load non-essential services before consent or after rejection", async () => {
  const loadNonEssentialServices = vi.fn();
  render(<CookieConsent loadNonEssentialServices={loadNonEssentialServices} />);
  expect(loadNonEssentialServices).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: /reject non-essential/i }));
  expect(loadNonEssentialServices).not.toHaveBeenCalled();
});

it("loads non-essential services only after acceptance", async () => {
  const loadNonEssentialServices = vi.fn();
  render(<CookieConsent loadNonEssentialServices={loadNonEssentialServices} />);
  await userEvent.click(screen.getByRole("button", { name: /accept non-essential/i }));
  expect(loadNonEssentialServices).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run consent tests and verify they fail because no consent component exists**

Run: `npm --prefix frontend test -- --run src/components/CookieConsent.test.tsx`

Expected: FAIL because `CookieConsent` is absent.

- [ ] **Step 3: Implement visible cookie choices and preference management**

Render equally clear accept/reject choices and a link to the Cookies page. Persist the choice, gate every non-essential integration behind acceptance, and provide a persistent way to reopen preferences from the Cookies legal page/footer. Do not block essential authentication, security, or session behaviour.

- [ ] **Step 4: Add the production release checklist**

Document live Price/account verification, live Checkout, signed webhook, cancellation, failed-payment, cookie, accessibility, policy-link, and solicitor-review checks. Explicitly mark final solicitor approval and VAT assessment as external release gates.

- [ ] **Step 5: Run the complete frontend and backend test suites**

Run: `npm --prefix frontend test && npm --prefix backend/functions test`

Expected: PASS.

- [ ] **Step 6: Commit consent controls and launch documentation**

```bash
git add frontend/src/components/CookieConsent.tsx frontend/src/components/CookieConsent.test.tsx frontend/src/App.tsx frontend/src/lib/legal.ts backend/README.md
git commit -m "feat: add cookie consent controls"
```

## Final verification

- [ ] Run `npm test` in `frontend`.
- [ ] Run `npm run build` in `frontend`.
- [ ] Run `npm test` in `backend/functions`.
- [ ] Review the staged/branch diff for accidental secret values and all policy links.
- [ ] Perform the live-mode manual checklist in the spec before deployment.
- [ ] Obtain UK solicitor review of all final legal content and an accounting/tax review of the VAT position before making the paid service public.
