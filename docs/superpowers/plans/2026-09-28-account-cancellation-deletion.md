# Mint Motor account cancellation and deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add working seller/dealer subscription cancellation and safe account deletion, integrated with Stripe lifecycle events and Mint Motor listing visibility.

**Architecture:** Keep Stripe Portal sessions for self-service cancellation and add a shared, authenticated account-deletion API backed by an idempotent lifecycle module. Store deletion requests separately from profiles, hide listings immediately, and finalize due requests using a scheduled backend reconciliation job after Stripe confirms the latest paid-through date. Reuse account settings surfaces and a shared frontend component for the same whole-account deletion flow.

**Tech Stack:** React, TypeScript, React Router, Firebase Authentication/Firestore/Storage, Firebase Cloud Functions v2, Stripe Node SDK, Vitest, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-27-account-cancellation-deletion-design.md`

## Global Constraints

- Existing `/billing/customer-portal` and `/dealer/billing/customer-portal` sessions remain bound to the authenticated user's stored Stripe customer.
- Seller public listings become drafts only after seller paid access ends; free `dealer-network-free` listings are unaffected by seller cancellation.
- Dealer active stock becomes drafts only after dealer paid access ends; resubscription never republishes drafts automatically.
- An account deletion request hides all the account's listings immediately and cancels every active/trialing seller and dealer subscription at period end.
- Complete deletion only after the latest Stripe-confirmed paid-through date; accounts without active subscriptions are deleted after confirmation.
- Deletion applies to the whole Firebase login and must be ownership-checked, recent-authenticated, idempotent, and retryable.
- Retain only minimal records required for billing, security, legal claims, or dispute handling; exact wording and retention periods require solicitor review.
- Do not delete Stripe invoice/payment records or change/deploy Stripe live settings.

## Review Focus

- Seller and dealer subscriptions both exist: confirm both are scheduled for cancellation and deletion waits for the later paid-through date.
- A portal cancellation is scheduled but not effective: paid listings must remain available until Stripe ends access.
- Webhook delivery or Storage cleanup fails during finalization: the request must remain retryable and must not be reported as complete.
- A user with a pending deletion request tries to publish, edit, or create a dealer vehicle: reject the mutation while allowing the request status to be read.
- A stale Firebase sign-in attempts deletion: require recent reauthentication and leave the account unchanged.

---

### Task 1: Implement and test account-deletion lifecycle operations

**Files:**
- Create: `backend/functions/accountLifecycle.js`
- Create: `backend/functions/accountLifecycle.test.js`
- Modify: `backend/functions/billing.js`
- Modify: `backend/functions/billing.test.js`

**Interfaces:**
- `requestAccountDeletion({ uid, database, storageStatusDatabase, stripe, now, timestamp }) -> Promise<{ status: "pending" | "deleted", effectiveAt: Date | null }>`; retrieve and schedule all active/trialing seller/dealer subscriptions at period end, hide all listings, and persist an idempotent request before returning.
- `finalizeAccountDeletion({ uid, database, storageStatusDatabase, storage, admin, timestamp }) -> Promise<void>`; remove account-owned content and identity only after the due date, preserve required audit/financial records, and remain safe to retry.
- `processDueAccountDeletions(dependencies) -> Promise<{ processed: number, failed: number }>`; query due pending requests, re-check recorded subscriptions with Stripe before finalization, and continue after an individual failure.
- Add `unpublishDealerListingsAfterAccessEnds({ database, dealerId, timestamp })`; draft the dealer's active Dealer Network cars without changing seller-owned free listings.
- Add `applyDealerSubscriptionLifecycle({ database, dealerId, subscription, tier, timestamp })`; persist dealer entitlement and draft dealer stock only when Stripe confirms paid access has ended.

- [ ] **Step 1: Write lifecycle tests first**

Add tests named `schedulesSellerAndDealerSubscriptionsAndUsesLatestPeriodEnd`, `hidesSellerAndDealerListingsWhenDeletionIsRequested`, `deletesImmediatelyWhenNoSubscriptionIsActive`, `finalizesOnlyDueRequests`, `retriesPartialStorageFailureWithoutMarkingComplete`, `preservesBillingAuditRecordsAndAnonymizesEnquiries`, `onlyDeletesContentOwnedByAuthenticatedUid`, `draftsDealerStockOnlyAfterStripeConfirmsAccessEnded`, and `keepsDealerStockVisibleWhileScheduledCancellationIsStillPaid`. Assert both account types, all subscription identifiers, max paid-through date, listing statuses, safe retained fields, and that repeated processing is idempotent.

- [ ] **Step 2: Run backend lifecycle tests and confirm they fail**

Run: `npm test -- --test-name-pattern="schedulesSellerAndDealer|hidesSellerAndDealer|deletesImmediately|finalizesOnlyDue|retriesPartialStorage|preservesBilling|onlyDeletesContent|draftsDealerStock|keepsDealerStock"`

Working directory: `backend/functions`.

Expected: FAIL because the lifecycle module and dealer expiry helper do not yet exist.

- [ ] **Step 3: Implement lifecycle helpers and dealer expiry behavior**

Implement injected Firestore/Storage/Auth/Stripe dependencies in `accountLifecycle.js`. Save deletion state in `accountDeletionRequests/{uid}` with `status`, `requestedAt`, and `effectiveAt`; use an in-progress/completed marker so partial cleanup remains retryable. Delete seller and dealer listing photos using their verified per-account Storage prefixes, delete owned car/private data and user-scoped vehicle checks, redact personal enquiry/application fields as specified by the approved retention policy, remove dealer Storage approval, remove Mint Motor's Stripe identifiers after finalization, and delete the Firebase Auth user last. Keep Stripe invoice/payment history untouched. In `billing.js`, draft only dealer-owned active cars for the dealer whose paid access ended.

- [ ] **Step 4: Run backend lifecycle tests and confirm they pass**

Run: `npm test -- --test-name-pattern="schedulesSellerAndDealer|hidesSellerAndDealer|deletesImmediately|finalizesOnlyDue|retriesPartialStorage|preservesBilling|onlyDeletesContent|draftsDealerStock|keepsDealerStock"`

Expected: PASS for all lifecycle and dealer entitlement cases.

- [ ] **Step 5: Run existing billing tests**

Run: `npm test -- billing.test.js`

Expected: PASS, including existing seller cancellation/listing behavior and the new dealer expiry behavior.

- [ ] **Step 6: Commit the tested lifecycle unit**

Stage only `backend/functions/accountLifecycle.js`, `backend/functions/accountLifecycle.test.js`, `backend/functions/billing.js`, and `backend/functions/billing.test.js`, then commit as `feat: add account deletion lifecycle`.

### Task 2: Wire secure API, Stripe events, and due-request reconciliation

**Files:**
- Modify: `backend/functions/index.js`
- Create: `backend/functions/accountRoutes.js`
- Create: `backend/functions/accountRoutes.test.js`

**Interfaces:**
- `createAccountRoutes({ admin, database, storageStatusDatabase, storage, getStripeClient, timestamp, logger })` mounts `GET /me/account-deletion` and `POST /me/account-deletion` handlers.
- The POST handler derives UID from a verified bearer token, checks `auth_time` is within five minutes, and returns `202 { status: "pending", effectiveAt }` or `200 { status: "deleted" }` only after the corresponding operation succeeds.
- Export an hourly Firebase Functions v2 scheduled reconciliation job that calls `processDueAccountDeletions` and attach `STRIPE_SECRET_KEY` so it can re-check recorded subscription state with Stripe.

- [ ] **Step 1: Add failing route/security tests**

Add tests `requiresVerifiedAuthentication`, `rejectsStaleAuthWithoutMutation`, `doesNotAcceptClientSuppliedUid`, `returnsPendingDeletionStatus`, `returnsErrorsWithoutClaimingDeletionComplete`, and `rejectsSellerAndDealerMutationsWhileDeletionPendingButAllowsStatusRead`. Assert unauthenticated requests are 401, stale auth is 401/reauth-required, clients cannot choose a UID, and errors preserve retryable request state.

- [ ] **Step 2: Run route tests and confirm they fail**

Run: `npm test -- accountRoutes.test.js`

Working directory: `backend/functions`.

Expected: FAIL because the account routes do not exist.

- [ ] **Step 3: Implement routes and backend event integration**

Mount the routes after JSON middleware. On every seller/dealer subscription event, update the existing entitlement state and draft that role's listings only when access ends; delegate dealer updates to `applyDealerSubscriptionLifecycle` so a Stripe `customer.subscription.updated` event with `cancel_at_period_end: true` leaves stock active through `current_period_end`. Add an `onSchedule` hourly export with `STRIPE_SECRET_KEY`; it must re-check Stripe state, log per-account failures, and continue through other due requests. Add a pending-deletion guard to seller/dealer listing create, edit, publish, delete, and status-mutation endpoints, while leaving `GET /me/account-deletion` available.

- [ ] **Step 4: Run route tests and relevant backend tests**

Run: `npm test -- accountRoutes.test.js billing.test.js dealerRoutes.test.js`

Expected: PASS; the existing unrelated SCS importer parse-stock test is not part of this focused run.

- [ ] **Step 5: Commit the tested API and lifecycle wiring**

Stage only `backend/functions/index.js`, `backend/functions/accountRoutes.js`, `backend/functions/accountRoutes.test.js`, and any lifecycle files changed by this task, then commit as `feat: wire account deletion endpoints`.

### Task 3: Add typed frontend API methods and tests

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/lib/api.test.ts`

**Interfaces:**
- `getAccountDeletionStatus(token: string) -> Promise<{ request: { status: "pending"; effectiveAt: string | null } | null }>`.
- `requestAccountDeletion(token: string) -> Promise<{ status: "pending" | "deleted"; effectiveAt: string | null }>`.
- Existing `createCustomerPortalSession(token)` and `createDealerCustomerPortalSession(token)` remain the cancellation entry points.

- [ ] **Step 1: Add failing API tests**

Add tests asserting the two new methods call `GET /me/account-deletion` and `POST /me/account-deletion`, include the bearer token, and surface backend errors without converting them to success.

- [ ] **Step 2: Run focused API tests and confirm they fail**

Run: `npm test -- src/lib/api.test.ts`

Working directory: `frontend`.

Expected: FAIL because the methods are not implemented.

- [ ] **Step 3: Implement API methods and run API tests**

Add typed wrappers using the existing `request` helper. Run `npm test -- src/lib/api.test.ts` and expect PASS.

- [ ] **Step 4: Commit the tested frontend API unit**

Stage only `frontend/src/lib/api.ts` and `frontend/src/lib/api.test.ts`, then commit as `feat: add account deletion API client`.

### Task 4: Build shared account and billing controls for seller and dealer settings

**Files:**
- Create: `frontend/src/components/account/AccountBillingActions.tsx`
- Create: `frontend/src/components/account/AccountBillingActions.test.tsx`
- Modify: `frontend/src/pages/UserProfile.tsx`
- Create: `frontend/src/pages/UserProfile.test.tsx`
- Modify: `frontend/src/pages/dealer/DealerPlan.tsx`
- Modify: `frontend/src/contexts/AuthContext.tsx`
- Create: `frontend/src/contexts/AuthContext.test.tsx`
- Existing `/dealer/plan` route is reachable from the dealer workspace's “Manage plan” link; keep that route rather than adding another settings route.

**Interfaces:**
- `AccountBillingActions({ role: "seller" | "dealer", subscriptionStatus })` renders the matching Stripe portal action, shared delete action, and pending-deletion status.
- It uses `useAuth().getToken(true)`, `getAccountDeletionStatus`, and `requestAccountDeletion`; deletion requires a confirm dialog and a fresh sign-in when the server requests it.
- Extend `AuthContext` with `reauthenticate(password?: string)`: use Firebase credential reauthentication for email/password accounts and Google popup reauthentication for Google accounts. If the provider cannot be reauthenticated in place, show the sign-in path rather than retrying deletion with a stale token.

- [ ] **Step 1: Add failing shared-component tests**

Add tests `showsSellerCancellationAndDeletionActions`, `showsDealerCancellationAndDeletionActions`, `confirmsBeforeRequestingDeletion`, `reauthenticatesAfterRecentAuthRequired`, `displaysPendingDeletionDateAndBlocksActions`, and `showsFailureWithoutDeletedSuccess`. Assert the UI never claims completion before the API confirms it.

In `AuthContext.test.tsx`, add `reauthenticatesEmailPasswordUsersWithCredential` and `reauthenticatesGoogleUsersWithPopup`; assert unsupported providers return a clear re-sign-in error.

- [ ] **Step 2: Run component tests and confirm they fail**

Run: `npm test -- src/components/account/AccountBillingActions.test.tsx src/contexts/AuthContext.test.tsx`

Working directory: `frontend`.

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement shared account controls**

Use the existing MintMotor UI components, confirmation dialog pattern, loading states, accessible labels, and responsive layout. Keep cancellation distinct from deletion: cancellation opens the role-specific existing Stripe portal; deletion explains immediate listing hiding, the latest paid-through/effective date, whole-account scope, and retained-record caveat. On the server's recent-auth-required response, call `reauthenticate` and retry only after it succeeds. Show pending/deleted outcomes only from the API response, and show the approved support contact `worldcomponents.it@gmail.com` for pending requests.

- [ ] **Step 4: Add controls to seller and dealer surfaces with page tests**

In `UserProfile`, load the seller subscription status and render the shared control. In `DealerPlan`, render the dealer control beside the current-plan panel and ensure the existing dealer workspace can reach it. Add page tests `sellerProfileShowsAccountBillingControls` and `dealerPlanShowsAccountBillingControls`.

- [ ] **Step 5: Run focused frontend tests**

Run: `npm test -- src/components/account/AccountBillingActions.test.tsx src/pages/UserProfile.test.tsx src/pages/dealer/DealerPlan.test.tsx src/contexts/AuthContext.test.tsx src/lib/api.test.ts`

Working directory: `frontend`.

Expected: PASS, including both roles, confirmation, pending state, errors, and correct Stripe portal dispatch.

- [ ] **Step 6: Commit the tested settings UI**

Stage only the shared account component and tests plus `frontend/src/pages/UserProfile.tsx`, its test, `frontend/src/pages/dealer/DealerPlan.tsx`, its test, and AuthContext reauthentication files; commit as `feat: add billing and deletion settings`.

### Task 5: Verify lifecycle end-to-end and build

**Files:**
- Test: `backend/functions/accountLifecycle.test.js`
- Test: `backend/functions/accountRoutes.test.js`
- Test: `backend/functions/billing.test.js`
- Test: `frontend/src/components/account/AccountBillingActions.test.tsx`
- Test: `frontend/src/pages/UserProfile.test.tsx`
- Test: `frontend/src/pages/dealer/DealerPlan.test.tsx`

- [ ] **Step 1: Run focused backend suite**

Run: `npm test -- accountLifecycle.test.js accountRoutes.test.js billing.test.js dealerRoutes.test.js`

Working directory: `backend/functions`.

Expected: PASS. If the unrelated SCS importer test fails in a broader backend run, record its baseline separately and do not modify it in this task.

- [ ] **Step 2: Run focused frontend suite**

Run: `npm test -- src/components/account/AccountBillingActions.test.tsx src/pages/UserProfile.test.tsx src/pages/dealer/DealerPlan.test.tsx src/contexts/AuthContext.test.tsx src/lib/api.test.ts`

Working directory: `frontend`.

Expected: PASS.

- [ ] **Step 3: Run production build**

Run: `npm run build`

Working directory: `frontend`.

Expected: exit code 0.

- [ ] **Step 4: Review diff and document launch gate**

Confirm no Stripe live settings were changed and no unrelated SCS importer code was edited. Verify in Stripe test mode that Customer Portal cancellation is enabled at period end for both seller and dealer subscriptions; record that the live Portal configuration must be checked separately before rollout. Record that solicitor review of cancellation/deletion copy and retention periods is required before production deployment.
