# Dealer Tier Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bill dealers monthly through Stripe and enforce their active/featured Dealer Network inventory allowances.

**Architecture:** A server-owned tier catalogue maps trusted tier keys to Stripe Price IDs and allowances. Stripe webhooks persist subscription entitlement on each dealer document. Dealer publish and feature changes query current dealer usage before writing, while the portal uses dealer subscription APIs to present plan selection and usage.

**Tech Stack:** Express, Firebase Admin/Firestore, Stripe Billing Checkout and Billing Portal, React, TypeScript, TanStack Query.

**Spec:** `docs/superpowers/specs/2026-09-26-dealer-tier-subscriptions-design.md`

## Global Constraints

- Browser sends only a tier key; price IDs and allowances are server configuration.
- Webhooks are authoritative for subscription state; checkout success is informational.
- Block new publish/feature actions beyond allowance without deleting existing inventory.
- Use restricted Stripe server credentials and verified webhook signatures.
- Do not enable automatic VAT/tax collection without a confirmed VAT registration.
- Do not run automated tests, test commands, or builds.

## Review Focus

- Invalid tier keys and client-supplied price IDs cannot create a Stripe session.
- Cancellation/downgrade preserves existing stock but blocks new publication above allowance.
- A dealer cannot exceed active allowance through a race between two publish requests.
- Featured allowance counts only active featured cars.
- The sales-led 500+ tier cannot enter self-service checkout.

---

### Task 1: Define trusted dealer-tier configuration and entitlement serialization

**Files:**
- Create: `backend/functions/dealerTiers.js`
- Modify: `backend/functions/index.js`
- Modify: `frontend/src/lib/api.ts`

**Interfaces:**
- Produces `DEALER_TIERS[tierKey] = { name, monthlyPricePence, activeLimit, featuredLimit, priceEnvKey, selfService }`.
- Produces `serializeDealerSubscription(dealer)` and `GET /dealer/subscription`.

- [ ] **Step 1: Add catalogue**

Create `dealerTiers.js` with fixed entries from Starter through 400 plus a `custom-500-plus` non-self-service entry. Read price IDs only via environment names such as `STRIPE_DEALER_STARTER_PRICE_ID`; never put IDs in React.

- [ ] **Step 2: Add subscription API**

Expose the logged-in dealer’s tier key, status, limits, usage, and renewal date through `GET /dealer/subscription` under `requireDealer`.

- [ ] **Step 3: Review and commit**

Review that custom tier and missing price ID return a readable server error. Do not run tests/builds.

### Task 2: Create dealer Checkout, Billing Portal, and webhook sync

**Files:**
- Modify: `backend/functions/index.js:billing webhook and checkout routes`
- Modify: `backend/functions/.env.example`

**Interfaces:**
- Produces `POST /dealer/billing/checkout-session { tierKey }` and `POST /dealer/billing/portal-session`.
- Produces dealer profile fields: `dealerSubscriptionStatus`, `dealerTierKey`, `dealerActiveListingLimit`, `dealerFeaturedListingLimit`, `dealerSubscriptionCurrentPeriodEnd`, `stripeDealerCustomerId`, `stripeDealerSubscriptionId`.

- [ ] **Step 1: Checkout route**

Validate `tierKey`, reject `custom-500-plus`, map it to the server price ID, and create a Stripe Checkout subscription with `metadata: { firebaseUid, dealerTierKey }`. Use a dealer success URL and cancellation URL.

- [ ] **Step 2: Webhook entitlement sync**

Extend verified subscription webhook handling to branch on `metadata.dealerTierKey`, map the tier, and merge entitlement fields into `dealers/{uid}`. Process checkout completion, created/updated/deleted subscription events idempotently.

- [ ] **Step 3: Billing portal route**

Create a portal session only for a dealer with `stripeDealerCustomerId`; return its URL. Keep customer identity server-side.

- [ ] **Step 4: Review and commit**

Inspect webhook signature verification and ensure success-page navigation does not grant access. Do not run tests/builds.

### Task 3: Enforce active and featured allowances

**Files:**
- Modify: `backend/functions/index.js: dealer create/update/publish routes`
- Modify: `backend/functions/dealers.js`

**Interfaces:**
- Produces `getDealerInventoryUsage(dealerId)` returning active and active-featured counts.
- Produces `validateDealerEntitlement(dealer, usage, requestedFeatured)` returning a specific publish/feature limit error.

- [ ] **Step 1: Count active and featured inventory**

Count dealer-owned `status: active` cars and active cars with `isFeatured: true` directly before publish/change. Treat draft edits as non-consuming.

- [ ] **Step 2: Gate publish and feature state**

Require active/trialing entitlement before `/dealer/cars/:id/publish`; reject when the active count already equals the tier limit. In dealer PATCH, reject setting `isFeatured: true` if the car is not already active-featured and the featured limit is exhausted.

- [ ] **Step 3: Review and commit**

Confirm delete/sold/archive free an active slot without destructive changes to existing cars. Do not run tests/builds.

### Task 4: Build dealer plan and inventory-usage UI

**Files:**
- Create: `frontend/src/pages/dealer/DealerPlan.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/pages/dealer/DealerPortal.tsx`
- Modify: `frontend/src/lib/api.ts`

**Interfaces:**
- Consumes `getDealerSubscription`, `createDealerCheckoutSession(tierKey)`, and `createDealerBillingPortalSession`.
- Produces `/dealer/plan` with usage/allowance, plan cards, Checkout CTA, and portal CTA.

- [ ] **Step 1: Add API clients and route**

Add typed client functions and protect `/dealer/plan` with `DealerRoute`.

- [ ] **Step 2: Add plan page**

Show current tier/status, active and featured usage, renewal date, cards for every self-service tier, custom-tier contact-sales CTA, and a Billing Portal action for subscribed dealers.

- [ ] **Step 3: Add portal publish guidance**

On dashboard/editor, show usage and link to `/dealer/plan`; show the backend limit message on blocked publish rather than assuming entitlement in React.

- [ ] **Step 4: Review and commit**

Inspect no price IDs, allowance values, or entitlement mutations originate in the browser. Do not run tests/builds.

### Task 5: Stripe sandbox/manual release validation

**Files:**
- Review: dealer tier config, billing routes, webhook handler, dealer publish route, DealerPlan UI.

- [ ] **Step 1: Source review**

Use `git diff --check`; do not stage unrelated workspace changes or run tests/builds.

- [ ] **Step 2: Manual sandbox flow**

Use Stripe sandbox Checkout for a Starter tier, confirm webhook data grants 10 active/2 featured, publish up to the limit, verify the next publish is blocked, then use Billing Portal cancellation/downgrade and verify only new publish is blocked.

- [ ] **Step 3: Deploy with explicit approval**

Deploy Functions and Hosting only after the Stripe price IDs, webhook secret, and sandbox/live environment are explicitly configured and release approval is given.
