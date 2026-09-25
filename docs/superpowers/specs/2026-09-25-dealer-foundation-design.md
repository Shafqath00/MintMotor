# Dealer Foundation Design

## Purpose

Establish the first private-business capability for MintMotor: verified dealers can apply for access, activate their own Firebase account after an administrator approves them, publish trade-only stock immediately, and see trade prices that the public marketplace never exposes. This phase deliberately excludes paid public-listing packages, individual listing payments, customer quick-sale, partners, leasing, EV-specific discovery, and PostHog.

## Constraints and Decisions

- The existing React, Firebase Authentication, Firestore, Firebase Storage, Express Cloud Functions, and Mint Motor admin area remain the platform foundation.
- A dealer never becomes active merely by submitting an application.
- Mint Motor staff must never create, receive, or know a dealer password.
- Approval sends an automatic, expiring Firebase password-reset/setup link. The dealer chooses their own password and verifies their email before dashboard access.
- Identity role and operational dealer status remain separate: Firebase uses the custom claim `role: "dealer"`; Firestore uses `dealerStatus: "pending" | "approved" | "suspended"`.
- Dealer Network listings publish immediately when their approved dealer owner publishes them. They do not require per-listing admin moderation.
- All money fields are stored and returned in GBP; `tradePrice` is never returned by a public API.

## Data Model

### Dealer applications

`dealerApplications/{applicationId}` captures an immutable application snapshot and its review history:

- business/trading name, contact name, email, telephone, website, VAT number, dealer type, estimated vehicle count;
- structured address including postcode and address lines;
- `status: "submitted" | "under_review" | "approved" | "rejected"`;
- `reviewedBy`, `reviewedAt`, `decisionNote`, `dealerId`, `createdAt`, and `updatedAt`.

The public submission endpoint accepts only `submitted`; the admin review endpoint owns every later state change. Duplicate active applications for the same normalized email are rejected.

### Dealer profiles

`dealers/{uid}` is keyed by the Firebase Auth user ID and contains the approved business profile:

- application reference and the business/contact/address fields needed by the dashboard;
- `dealerStatus`, `emailVerified`, `activationEmailSentAt`, and `activationEmailLastError`;
- lifecycle audit fields: `approvedBy`, `approvedAt`, `suspendedBy`, `suspendedAt`, `reactivatedBy`, `reactivatedAt`;
- timestamps.

The Firestore status is authoritative for every dealer request. An Auth claim makes the initial role check cheap but does not, by itself, grant access.

### Vehicles and trade enquiries

Existing `cars/{carId}` records gain:

- `ownerType: "individual" | "dealer"`;
- `ownerDealerId` for dealer-owned vehicles;
- `visibility: "public" | "dealer-network"`;
- optional `tradePrice` in GBP;
- existing listing status/timestamps remain the publication controls.

Dealer Network enquiries are stored separately as `dealerEnquiries/{enquiryId}` with the vehicle, buyer dealer, seller dealer, message, `status: "new" | "read" | "closed"`, and timestamps. This keeps trade activity distinguishable from customer enquiries.

## Authentication and Access Control

`requireDealer` is a backend middleware layered on the existing Firebase token verification. It must:

1. require a valid Firebase ID token;
2. require the `role: "dealer"` custom claim;
3. load `dealers/{uid}` and require `dealerStatus === "approved"`;
4. require `emailVerified === true` from a freshly verified token/profile;
5. attach the dealer profile to the request.

Every dealer-only endpoint uses this middleware. Listing updates additionally compare `ownerDealerId` to the authenticated dealer ID. Public routes always filter `visibility === "public"` and serialize through a public-safe mapper that excludes `tradePrice`, dealer-only contact data, and private enquiry details.

React route guards use the token claim plus a dealer-status endpoint for user feedback, but they are not a security boundary. Pending, rejected, and suspended dealers receive a status page rather than dashboard content; a suspended token must still be rejected at the backend.

## Application and Activation Flow

1. A prospective dealer submits `/dealer/apply`; the backend validates required fields and UK postcode format, persists `dealerApplications`, and returns a neutral confirmation.
2. An administrator sees the submitted/under-review applications in the existing `/admin` dashboard and may mark one under review, reject it, approve it, suspend a dealer, or reactivate a suspended dealer.
3. Approval executes a server-side `approveDealer(applicationId)` action. It verifies admin access, loads the application, creates or finds the Firebase Auth user by email, sets the dealer custom claim, creates/updates `dealers/{uid}`, writes approved audit fields, and links the application to the dealer.
4. The action generates a Firebase password-reset link with the dealer login route as the continue URL and sends a branded Mint Motor activation email. The email directs the dealer to select their own password and verify their email.
5. If email delivery fails after the profile has been approved, approval is retained and `activationEmailLastError` is recorded. Admin can send a new setup link through a dedicated resend action; the previous link is treated as superseded. The browser does not reveal delivery-provider detail.
6. At `/dealer/login`, the dealer signs in with Firebase. Until email verification and approved status are both true, they cannot reach private routes. A fresh ID token is obtained after verification so the claim and verification state are current.

The approval operation is idempotent: a retry for an already approved application reuses the Auth user and dealer record, never creates another account, and may resend activation only when the administrator explicitly requests it.

## Dealer Experience

### Public application

`/dealer/apply` is a clear business application form that collects the brief’s business, contact, address, company, website/VAT, dealer-type, and vehicle-volume fields. It states that Mint Motor will review the application before it creates an account.

### Dealer login and status

`/dealer/login` is an email/password Firebase login separate in navigation and copy from normal customer sign-in. It provides password-reset recovery. Post-login status handling distinguishes pending review, approved-but-email-unverified, rejected, and suspended without leaking internal review notes.

### Dashboard and private marketplace

`/dealer/dashboard` contains private inventory, create/edit listing, Dealer Network browse, trade enquiries, dealer profile, and account status. Subscription and billing UI is intentionally deferred to the paid-listings phase.

`/dealer/network` lists only active Dealer Network vehicles owned by approved dealers. `/dealer/network/:id` exposes the trade price and dealer enquiry action only after dealer authorization. A normal public car detail route neither displays nor fetches the trade price.

Dealers create records with `visibility: "dealer-network"` and publish them immediately after validation. They can edit or unpublish only their own vehicles.

## Admin Experience

The existing `/admin` dashboard gains a dealer applications workspace and dealer-management controls. It shows application identity, contact/business details, status, submitted date, and decision actions. Approval asks for confirmation because it creates access and sends an email. Rejection requires no Auth account creation. Existing dealer records have suspend, reactivate, and resend-activation controls, with audit attribution.

## Error Handling

- Invalid or incomplete applications return field-level errors; an invalid UK postcode is rejected before persistence.
- A duplicate active application shows a generic "application already exists" response without disclosing account status.
- Approval failures leave the application reviewable and report a clear, retryable admin error; partial writes are reconciled by application ID and email.
- An email-delivery failure does not revoke valid approval, but is visible to admins with a safe resend action.
- Missing, stale, suspended, or non-dealer tokens receive 401/403 responses with no dealer inventory data.
- A missing/unpublished/private vehicle is presented as unavailable rather than exposing whether a hidden listing exists.
- Dealer creation, update, publication, and enquiries show recoverable client errors and retain unsaved form values.

## APIs and Client Surface

New Cloud Function endpoints follow the existing `/api` Express pattern:

- public: `POST /dealer-applications`;
- admin: `GET /admin/dealer-applications`, `PATCH /admin/dealer-applications/:id`, `POST /admin/dealer-applications/:id/approve`, `POST /admin/dealers/:uid/resend-activation`, `POST /admin/dealers/:uid/suspend`, `POST /admin/dealers/:uid/reactivate`;
- dealer: `GET /dealer/me`, `GET|POST /dealer/cars`, `GET|PATCH|DELETE /dealer/cars/:id`, `POST /dealer/cars/:id/publish`, `GET /dealer/network`, `GET /dealer/network/:id`, `POST /dealer/network/:id/enquiries`, `GET /dealer/enquiries`.

The frontend API client adds strongly typed request/response models. Routes are added to the existing React router and use the current auth context/token retrieval.

## Tests and Acceptance Criteria

Backend unit and endpoint tests cover application validation, duplicate prevention, admin authorization, approve-idempotency, Auth claim assignment, approved profile creation, setup-link email delivery/retry failure, suspension/reactivation, dealer middleware, ownership enforcement, immediate publishing, dealer enquiry authorization, and public-safe car serialization.

Frontend tests cover the application form, submission success/failure, dealer login/status gating, private-network discovery, trade-price concealment from public views, inventory ownership controls, and admin decision/resend/suspension controls.

Phase 1 is complete when a legitimate dealer can apply, be approved by an existing admin, safely set their own password from a branded setup email, verify their email, sign in at `/dealer/login`, immediately publish a Dealer Network vehicle, and have its trade price visible only to other approved dealers. A public visitor, normal user, pending dealer, or suspended dealer must never receive that private listing or trade price from the backend.
