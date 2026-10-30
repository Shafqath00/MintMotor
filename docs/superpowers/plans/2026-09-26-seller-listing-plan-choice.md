# Seller Listing Plan Choice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow normal sellers to publish either through the existing paid public Mint Motor plan or free to the approved-dealer network.

**Architecture:** Persist a server-validated `listingPlan` beside existing `visibility` on the shared `cars` collection. The public publish route requires a subscription only for `public-subscription`; a new safe dealer-network serializer supports seller-owned trade listings without exposing dealer-only private fields. The existing subscription screen becomes the two-option choice point for a selected draft.

**Tech Stack:** React, TypeScript, React Router, TanStack Query, Express, Firebase Admin/Firestore, Stripe.

**Spec:** `docs/superpowers/specs/2026-09-26-seller-listing-plan-choice-design.md`

## Global Constraints

- Keep the existing `cars` collection and `visibility` field; do not add a second listing collection or Stripe product.
- `public-subscription` requires the existing seller subscription; `dealer-network-free` does not.
- Only the backend accepts plan changes and controls visibility, ownership, and status.
- Public routes must never return `dealer-network` listings.
- Dealer-network routes require an approved dealer and must never return dealer notes or private seller profile data.
- Do not run automated tests, test commands, or builds.
- Keep custom Firebase email-action work paused.

## Review Focus

- A seller changing from free dealer-only to public before publishing is redirected to the existing subscription requirement.
- A seller with no subscription can publish only the dealer-network-free plan.
- Public `GET /cars` and `GET /cars/:id` continue to exclude every dealer-network vehicle.
- A dealer can submit an offer on a seller-owned dealer-network listing but cannot create a dealer enquiry about their own dealer stock.
- Dealer-owned stock retains trade price and internal notes while seller-owned trade listings have neither.

---

### Task 1: Persist and validate seller listing plans

**Files:**
- Modify: `backend/functions/validators.js:287-460`
- Modify: `backend/functions/index.js:773-946`
- Modify: `frontend/src/lib/data.ts:34-93`
- Modify: `frontend/src/lib/api.ts:155,450-480`

**Interfaces:**
- Produces `ListingPlan = "public-subscription" | "dealer-network-free"` and validates it only on private seller drafts.
- Produces `applySellerListingPlan(current, payload)` that returns `{ listingPlan, visibility }`; server fields override browser attempts to set ownership/status.

- [ ] **Step 1: Add listing-plan types and validation**

Add `listingPlan?: "public-subscription" | "dealer-network-free"` to `Car`, allow only those strings in listing validation, and default private seller drafts to `public-subscription`/`public` when no plan is supplied.

- [ ] **Step 2: Apply the plan on create and draft update**

In `POST /cars` and `PATCH /cars/:id`, derive visibility from `listingPlan` instead of trusting a client visibility value:

```js
const plan = req.body.listingPlan === "dealer-network-free"
  ? "dealer-network-free"
  : "public-subscription";
const planPatch = {
  listingPlan: plan,
  visibility: plan === "dealer-network-free" ? "dealer-network" : "public",
};
```

Reject plan changes for dealer-owned records. Keep `ownerId`, `sellerType`, `status`, and `dealerId` server-controlled.

- [ ] **Step 3: Gate publish by plan**

Before `POST /cars/:id/publish` writes status, load the owner profile and require `validateSellerPublishRequirements` only if `car.listingPlan !== "dealer-network-free"`. Dealer-network-free private listings publish with `LISTING_STATUS.PUBLISHED`; public routes already exclude them by visibility.

- [ ] **Step 4: Focused source review and commit**

Inspect plan-to-visibility mapping and confirm public list/detail filters remain in place. Do not run tests or builds.

```bash
git add backend/functions/validators.js backend/functions/index.js frontend/src/lib/data.ts frontend/src/lib/api.ts
git commit -m "feat: add seller listing plan choice"
```

### Task 2: Make dealer network safe for seller-owned trade listings

**Files:**
- Modify: `backend/functions/index.js:1084-1123`
- Modify: `backend/functions/dealers.js`
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/pages/dealer/DealerPortal.tsx`

**Interfaces:**
- Produces `serializeDealerNetworkCar(car, privateData?)`, which returns common vehicle fields for every dealer-network listing and includes `tradePrice` only when the car is dealer-owned.
- Produces a dealer enquiry record with `sellerOwnerId`, optional `sellerDealerId`, and `buyerDealerId`.

- [ ] **Step 1: Expand dealer-network listing query safely**

Change `GET /dealer/network/cars` to return active `visibility: "dealer-network"` cars from approved dealer owners and private seller free-plan owners. For dealer-owned records, load `dealerCarPrivate`; for seller-owned records, omit it and serialize only common vehicle fields.

- [ ] **Step 2: Support seller-owned network detail and offers**

Replace the `dealerId`-only checks in `GET /dealer/network/cars/:id` and its enquiry route with ownership-aware logic. A dealer can enquire on a seller-owned network car; reject only when the target is dealer-owned by the requesting dealer. Store `sellerOwnerId: record.car.ownerId` and `sellerDealerId: record.car.dealerId || null`.

- [ ] **Step 3: Render listing context in dealer UI**

In dealer cards/detail, display `Dealer stock` when `sellerType === "dealer"`, otherwise `Private seller trade listing`. Show trade price only when it is a number. Keep the existing gallery, facts, history and enquiry form; never render `dealerNotes`.

- [ ] **Step 4: Focused source review and commit**

Review that seller-owned records do not require a dealer profile/private record and public API filters remain unchanged. Do not run tests or builds.

```bash
git add backend/functions/index.js backend/functions/dealers.js frontend/src/lib/api.ts frontend/src/pages/dealer/DealerPortal.tsx
git commit -m "feat: show seller trade listings to dealers"
```

### Task 3: Replace the subscription page with a plan-choice step

**Files:**
- Modify: `frontend/src/pages/Sellpages/SellerSubscription.tsx`
- Modify: `frontend/src/pages/Sellpages/CarDetails.tsx:388-419,687-695`
- Modify: `frontend/src/pages/MyListings.tsx:201-225`

**Interfaces:**
- Consumes `updateCar(id, { listingPlan }, token)`, `publishCar(id, token)`, and `createCheckoutSession(token)`.
- Produces a two-card selection screen at `/sell/subscription?id=<draftId>&next=<editorPath>`.

- [ ] **Step 1: Save a selected plan before action**

Add a `selectPlanMutation` that patches the draft then either publishes free dealer-only stock or continues to the existing subscription checkout:

```ts
await updateCar(draftId, { listingPlan: "dealer-network-free" }, token);
await publishCar(draftId, token);
window.location.href = "/dealer/dashboard";
```

For `public-subscription`, patch the plan first; if the subscription is active return to `next`, otherwise create the existing checkout session.

- [ ] **Step 2: Render two explicit plan cards**

Replace temporary-free-publishing copy with two accessible cards: “Mint Motor monthly plan — £10 every four weeks — Public listing” and “Free dealer-only plan — £0 — Approved dealers only”. Explain that dealer-only listings receive trade offers and never appear publicly. Disable actions until draft and token are available; keep errors in an inline status panel.

- [ ] **Step 3: Show plan state in the editor and listings**

In `CarDetails`, derive publish copy/action from `car.listingPlan`; direct a draft with no plan to the choice route. In `MyListings`, show public subscription state for public drafts and a `Dealer-only free listing` badge for the free plan instead of presenting subscription as required.

- [ ] **Step 4: Focused source review and commit**

Review the two actions: only paid public uses checkout, only free dealer-only invokes publication without checkout, and saved plan state survives returning to the editor. Do not run tests or builds.

```bash
git add frontend/src/pages/Sellpages/SellerSubscription.tsx frontend/src/pages/Sellpages/CarDetails.tsx frontend/src/pages/MyListings.tsx
git commit -m "feat: offer public and dealer-only seller plans"
```

### Task 4: Manual release validation

**Files:**
- Review: `backend/functions/index.js`, `backend/functions/validators.js`, `frontend/src/pages/Sellpages/SellerSubscription.tsx`, `frontend/src/pages/dealer/DealerPortal.tsx`

- [ ] **Step 1: Inspect the final diff**

Use `git diff --check` and inspect every visibility, serializer, and enquiry change. Existing unrelated dirty-workspace changes must not be staged. Do not run tests or builds.

- [ ] **Step 2: Exercise the two seller paths after release**

Create one normal seller draft for each plan. Verify the public selection needs subscription and appears publicly only after it is active. Verify the free choice publishes without checkout, remains absent from public search/detail, and appears to an approved dealer.

- [ ] **Step 3: Exercise dealer offer permissions**

As an approved dealer, open the free seller trade listing and send an offer. Confirm a dealer cannot enquire about their own dealer stock and no dealer notes/trade price appear for seller-owned listing data.

- [ ] **Step 4: Deploy only with explicit release approval**

Deploy existing Firebase Functions and Hosting configuration. Do not alter Firebase email-action configuration or Storage Rules beyond separately approved work.
