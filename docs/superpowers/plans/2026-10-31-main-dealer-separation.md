# Mint Motor Main Platform and Dealer Portal Separation Plan

**Goal:** Private sellers list on the main site and pick either a paid public advert or a free dealer-only advert. Dealers use only the dealer portal, can bulk-upload cars, and their subscribed stock appears on the main site.

**Supersedes:** the private-seller parts of `2026-10-30-platform-split.md` and `docs/platform-split-rollout.md`. The seller-plan retirement migration (`backend/scripts/retire-seller-plans.js --apply`) must **not** be run.

**Decisions (approved 2026-10-31):**
- Public private-seller adverts keep the existing monthly seller Stripe subscription. Free stays dealer-only.
- Accounts are role-locked in one Firebase Auth pool: an account is either a buyer/seller or a dealer, never both, and cannot sign in to the other portal.
- Dealers bulk-upload by CSV and by a list of registrations.

## Visibility rules (backend is authoritative)

| Listing | Main site | Dealer portal |
|---|---|---|
| Private `public-subscription`, published, seller subscription active | Visible | Not shown |
| Dealer stock, `active`, dealer subscription active | Visible | Owning dealer only |
| Private `dealer-network-free`, published | Hidden (404 on all public routes) | All approved dealers |

## What we keep from the split
- Dealer-only projection (`dealerSubmission`) that hides seller contact and account fields.
- Identity check (verified email and phone) before publishing.
- Private photo storage and authenticated image delivery. All seller photos stay under `private-sellers/…`. `GET /cars/:id/images/:index` serves public adverts to anyone, and dealer-only adverts to their owner and to approved dealers.
- Dealer tiers, quotas, approval and billing, and the dealer enquiry/offer inbox.

## Tasks

1. **Backend: seller plan choice (TDD).** Remove the global `SELLER_PLATFORM_SPLIT_ENABLED` gating. `POST/PATCH /cars` accept `listingPlan` (`public-subscription` | `dealer-network-free`) and set `visibility` on the server; the plan can change only while the listing is a draft. Reinstate `/billing/checkout-session` and `/billing/customer-portal` for public drafts. `isPublicMarketplaceCar` drops `legacyPublicUntil` and relies on `unpublishPublicListingsAfterAccessEnds` when the subscription lapses. Webhooks stop applying retirement logic. Tests: forged visibility, plan switch after publishing, free listing never public, lapsed subscription unpublishes.
2. **Backend: role lock (TDD).** Main-site seller and buyer write routes (`/cars*`, `/billing/*`, `/me/*`, `/vehicle-checks`, `/cars/:id/enquiries` when signed in) reject `role == dealer` with `403 DEALER_ACCOUNT`. `requireDealer` already rejects non-dealers. `POST /dealer-applications` rejects an email that already has a main-site account (`409 EMAIL_IN_USE_MAIN`), and approval refuses to promote an account that owns private listings. Add a read-only audit script that lists accounts with both a dealer role and private listings.
3. **Backend: bulk upload (TDD).** `POST /dealer/cars/bulk` takes up to 100 rows and returns per-row results; rows are validated with the existing listing validators and saved as drafts. `POST /dealer/cars/lookup` takes up to 25 registrations, runs the existing vehicle lookup in parallel with a cap, and returns prefilled drafts or per-reg errors. Publishing stays per car or as a selection through the existing quota check. Tests: row limits, partial failure, quota enforced on bulk publish, lookup error isolation.
4. **Storage and scheduler.** Storage rules: drop `legacyPublicUntil` from `legacyPublicImage`; keep the dealer-only rules. Change the hourly `sellerRetirementReconciliation` job to keep only the photo-protection sweep for dealer-only and unpublished adverts (no expiry by frozen date). Update the storage mirror on plan change and on unpublish.
5. **Frontend: main site seller flow.** Restore `/sell`, `/seller/*` and the listing editor on the main site, with the two-card plan choice (paid public / free dealer-only) and the publish step (checkout or free publish). "My listings" sits on the main dashboard. On the dealer domain, `/seller/*` redirects to the main site; remove the seller shell and the dealer-domain links in `UserProfile`.
6. **Frontend: role-locked sign-in.** Main sign-in or sign-up with a dealer account signs out and shows "This is a dealer account; sign in at the Dealer Portal" with a link. Dealer login with a non-dealer account shows the reverse. Dealer apply surfaces `EMAIL_IN_USE_MAIN`.
7. **Frontend: dealer bulk upload.** `/dealer/inventory/bulk` with two tabs. CSV: template download, client-side parse, preview with per-row errors, submit. Registrations: textarea, lookup, editable price/mileage grid, submit. Both end on the inventory list filtered to the new drafts, with "add photos" and "publish selected" (shows remaining plan slots).
8. **Docs and integration.** Rewrite `docs/platform-split-rollout.md` for this model, mark the retirement script do-not-run, run the full backend, frontend and storage-emulator tests and the build, and review against the visibility table. No deploy, migration or live billing changes.

## Rollout notes
- If the retirement migration has not run (true as of 2026-10-31), existing paid sellers just carry on.
- Before deploy, run the role audit (task 2) and resolve any account that is both dealer and seller by hand.
- UKVD lookups cost per call; the registrations tab is capped at 25 per request.
