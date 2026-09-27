# Mint Motor account cancellation and deletion

## Status

Approved design for implementation planning. This specification describes the
product and engineering behavior; it is not legal advice. A UK solicitor must
review the customer-facing wording and retention schedule before production.

## Goal

Give private sellers and approved dealers an obvious, reliable way to cancel
their recurring subscription and request deletion of their Mint Motor account.
The flows must work with Stripe billing, hide listings when access ends, and
avoid deleting records needed to complete billing or resolve a dispute.

## Account settings

- The existing `/profile` page gains an Account and billing section for private
  sellers, with a subscription-management action and a separate Delete account
  action.
- Dealer settings gain the equivalent actions and are reachable from the
  dealer workspace. The dealer cancellation action manages the dealer's
  subscription, while account deletion applies to the shared Mint Motor login.
- Each cancellation action opens the existing account-bound Stripe Customer
  Portal session. The portal must allow cancellation at the end of the paid
  period; Mint Motor must not cancel another account's Stripe customer.
- Show the subscription status and effective date where available. Explain
  that cancelling stops renewal, while current paid access normally continues
  through the paid-through date, subject to any statutory rights and
  solicitor-approved terms.

## Cancellation and listing access

- Cancellation is not deletion. The customer remains able to sign in and
  manage the account until they separately request deletion.
- A cancellation requested through Stripe keeps the corresponding service
  available until Stripe confirms that paid access has ended.
- When seller public-listing access ends, move its published
  `public-subscription` listings to drafts. Do not affect the seller's
  `dealer-network-free` listings.
- When dealer subscription access ends, hide the dealer's active Dealer
  Network stock by moving it to drafts. Preserve the listing data for the
  dealer to review; a later subscription does not republish it automatically.
- Stripe webhooks remain the source of truth for cancellation and entitlement
  changes. The account UI must not infer cancellation completion solely from a
  browser redirect.

## Account deletion

- Require a deliberate confirmation, including reauthentication when Firebase
  reports that the sign-in is not recent enough. Explain that deletion covers
  the shared login, seller and dealer profiles, listings, and stored listing
  photos.
- If no seller or dealer subscription is active, process deletion immediately
  after confirmation.
- If either or both subscriptions are active or trialing, immediately hide
  all public and Dealer Network listings, prevent new listings and edits, and
  request cancellation at period end for every active subscription. Keep a
  restricted pending-deletion state so the user can see the request and
  effective date. Complete deletion after the latest paid-through date
  confirmed by Stripe.
- The final deletion operation must be idempotent and retryable. It removes
  Firebase Authentication access, seller/dealer profile documents, owned
  listing documents and private listing data, user-scoped vehicle-check data,
  and associated seller/dealer listing images. It also disables dealer
  approval/storage access and removes any application lock or approval state
  that is safe to delete.
- Remove or anonymize personal references in enquiry and application records
  where appropriate, while preserving only records and fields the business
  must retain for billing, security, legal claims, or dispute handling. Define
  the exact retention periods and exceptions in solicitor-reviewed privacy
  wording; do not claim that every trace is erased when legally required
  records remain.
- Do not delete Stripe invoices or payment records as part of the app's
  deletion request. Remove Mint Motor's customer/subscription identifiers
  after billing and deletion finalization where they are no longer required;
  retention and any Stripe Customer deletion must follow the approved
  retention schedule.
- If a user has both seller and dealer subscriptions, schedule both for
  cancellation and complete deletion only after the later confirmed paid
  period ends.

## Security and reliability

- Deletion endpoints derive the UID only from verified authentication; the
  client cannot submit a target UID or account role to delete.
- Verify account ownership for every Firestore and Storage cleanup query.
- Require recent authentication for deletion, use an explicit confirmation
  step, and make repeated requests safe.
- Persist a deletion-request state and effective timestamp before returning
  success. Final cleanup must be driven by trusted backend lifecycle events
  with retry/reconciliation support, not by a client remaining online.
- Stripe subscription updates and deleted events must update cancellation and
  deletion state idempotently. Failed cleanup must be observable and safely
  retryable rather than leaving a silently half-deleted account.
- Never mark deletion complete until the required account and content cleanup
  has succeeded. Retain a minimal non-sensitive operational audit of request
  and completion for support/security, subject to the approved retention
  schedule.

## User-facing behavior

- Use clear labels: “Manage / cancel subscription” and “Delete account”. Do
  not combine cancellation with account deletion or imply that a portal visit
  deleted the account.
- Before deletion, summarize which listings will be hidden, the subscription
  end date when known, the completion date, and the limited records that may
  need to be retained.
- After a pending deletion request, show its status and date, block account
  activity that would create or change listings, and provide the support
  contact configured in the approved legal content.
- Do not show a “deleted” success message until server-side deletion is
  confirmed.

## Validation

- Verify seller and dealer settings each expose the right subscription portal
  and deletion actions, including mobile layouts.
- Verify cancellation opens the correct Stripe customer portal for each role
  and the relevant listings remain visible until Stripe ends paid access.
- Verify seller public listings and dealer stock are drafted when their
  respective access ends, while free dealer-network seller listings remain
  unaffected by seller cancellation.
- Verify deletion without an active subscription removes the account and
  associated content, and deletion with active seller/dealer subscriptions
  hides listings immediately, schedules all subscriptions, and finalizes only
  after the latest paid-through date.
- Verify recent-authentication checks, authorization boundaries, duplicate
  requests, webhook retries, partial storage failures, and no automatic
  republishing after resubscription.
- Run focused frontend/backend tests and the production build. Review the
  legal copy and retention schedule with a UK solicitor before production.

## Out of scope

- Changing subscription prices or products.
- Refund decisions, bespoke cancellation entitlements, or legal interpretation
  beyond implementing the reviewed policy.
- Deleting Stripe-held invoices/payment records from the Mint Motor account
  deletion endpoint.
- Deploying the changes or changing Stripe live-mode settings.
