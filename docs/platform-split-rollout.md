# Main platform and dealer portal rollout

Mint Motor runs as two sites on one shared vehicle listing system:

- **Main site** (`mintmotor.co.uk`): buyers browse and contact sellers. Private sellers list cars and choose, per car, between a **paid public advert** (existing £10 a month seller subscription) and a **free dealer-only listing**.
- **Dealer portal** (`dealer.mintmotor.co.uk`): approved dealers subscribe, add stock one by one or in bulk, and see free dealer-only listings from private sellers.

This replaces the 2026-10-30 plan to retire paid seller adverts. **Do not run the seller plan retirement migration.** `backend/scripts/retire-seller-plans.js --apply` now refuses to run.

## Visibility rules

The backend decides visibility; clients cannot set `visibility`, `sellerType` or `isFeatured`.

| Listing | Main site | Dealer portal |
|---|---|---|
| Private `public-subscription`, published or sold | Visible | Not shown |
| Dealer stock, `active` | Visible | Owning dealer only |
| Private `dealer-network-free`, published | Hidden (404 on every public route) | All approved dealers |

- Paid public adverts return to drafts when the seller's subscription lapses (billing webhook). Dealer stock does the same when the dealer subscription lapses.
- A listing's plan can change only while it is a draft.
- Dealer-only listings need a verified email and phone. Paid public adverts also need an active seller subscription.
- Dealers never see a private seller's contact details; they send offers to the seller's inbox.

## Accounts are role-locked

There is one Firebase Auth pool, but each account is either a buyer/seller or a dealer:

- Main-site buyer and seller API routes reject dealer accounts with `403 DEALER_ACCOUNT`.
- Dealer routes already require an approved dealer.
- Signing in to the wrong site signs the account out with a message pointing to the right site.
- A dealer application is refused (`409 EMAIL_IN_USE_MAIN`) when the email already has a main-site account, and approval never promotes a main-site account to a dealer. Dealers apply with a separate business email.

## Photos

- New seller photos are uploaded to `private-sellers/{ownerId}/cars/{carId}/…` and served by `GET /cars/:id/images/:index`. Anyone can load photos of a public advert; only the owner and approved dealers can load photos of a dealer-only listing.
- Older paid adverts may still use public `users/…` photo links. Storage rules allow those only while the advert is published or sold.
- The hourly `sellerRetirementReconciliation` job (name kept so the deployed function is updated, not replaced) moves photos of every non-public private advert to private storage and revokes old links. It raises an error when any move needs a retry.

## Dealer bulk upload

- `POST /dealer/cars/bulk`: up to 100 rows, saved as drafts. Each row is validated on its own; duplicate or already-listed registrations are rejected.
- `POST /dealer/cars/lookup`: up to 25 registrations, 5 at a time. Each lookup is a paid vehicle-data call.
- Publishing goes through the normal per-car publish, so plan limits still apply.

## Before deploying

1. Back up the named `mintmotor` Firestore database and the bucket.
2. Run `node backend/scripts/audit-role-overlap.js` (read-only) and resolve every account it lists that is both a dealer and a seller before the role lock goes live.
3. Deploy the functions, Firestore rules and Storage rules together, then both hosting targets (`main` and `dealer`). Point `dealer.mintmotor.co.uk` at the `dealer` target.
4. Check on the live sites:
   - a dealer-only listing 404s on the main site;
   - an approved dealer sees it in the portal;
   - a paid public advert shows on the main site;
   - a dealer can't sign in on the main site;
   - a seller can't sign in on the dealer portal.

## Tests

- Backend: `npm test` in `backend/functions`.
- Storage rules: `firebase emulators:exec --config sellerMedia.emulators.json --project demo-seller-media --only firestore,storage "node --test backend/functions/sellerMedia.rules.test.js"` from the repo root.
- Frontend: `npx vitest run` and `npx vite build` in `frontend`.
