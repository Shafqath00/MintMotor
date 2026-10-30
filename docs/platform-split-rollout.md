# Main platform and dealer portal rollout

Mint Motor runs as two sites on one shared vehicle listing system:

- **Main site** (`mintmotor.co.uk`): buyers browse and contact sellers. Private sellers list cars and choose, per car, between a **paid public advert** (existing £10 a month seller subscription) and a **free dealer-only listing**.
- **Dealer portal** (`dealer.mintmotor.co.uk`): approved dealers subscribe, add stock one by one or in bulk, and see free dealer-only listings from private sellers.

This replaces the 2026-10-30 plan to retire paid seller adverts. **Do not run the seller plan retirement migration.** `backend/scripts/retire-seller-plans.js --apply` now refuses to run.

## The Dealer website

`dealer.mintmotor.co.uk` is a complete marketplace website branded **Mint Motor Dealers**, not a dashboard. It uses the main site's brand blue with a navy and amber dealer theme (the `theme-dealer` class, set from the hostname).

| Path | Page | Access |
|---|---|---|
| `/` | Home: hero search, services, how it works, plan teaser (newest exclusive cars once signed in) | Public marketing, no listing data |
| `/plans`, `/how-it-works` | Plans from the public `GET /dealer-plans`; FAQ | Public |
| `/login`, `/apply` | Split-screen sign in; three-step onboarding | Public |
| `/browse`, `/browse/:id` | Dealer-only private-seller cars: search, filters, sort; full detail page and offer form | Approved dealer |
| `/list`, `/list/:id/edit` | Add one car or bulk upload; edit a listing | Approved dealer |
| `/my-listings` | Stock with plan usage, publish, mark sold, withdraw | Approved dealer |
| `/enquiries`, `/profile` | Offers; business profile, billing, security, delete account | Approved dealer |

- Old `/dealer/...` links, Stripe returns and activation emails redirect to these paths. The API now builds new links to `/plans` and `/login` on the dealer site.
- Dealer cars still go live on the main site as soon as they are published (no staff approval step).
- The site is an installable web app (`dealer.webmanifest`, icons in `public/dealer-icons`), linked only on the dealer host. There is no native app in this repository.
- New API: `GET /dealer-plans` (public, plan names, prices and limits only), `POST /dealer/cars/:id/status` (withdraw to draft or mark sold), and `/dealer/network/cars` now also filters by `model`, `minYear`, `maxYear`, `maxMileage` and sorts by `year-desc`.

## Admin console

`/admin` on the main site is a full console: Dashboard, Users, Dealers, Listings, Complaints, Enquiries, Subscriptions and plans, Payments, Activity log, Reports, Content, and Team. Every figure and action uses the live API.

- **Roles:** Owner (everything), Support (users, dealers, listings, complaints, activity), Content editor (announcements, homepage, featuring cars), Finance (subscriptions, payments, revenue reports). Admins set up before roles existed keep full Owner access; add people under **Team** to give them a role. The API enforces permissions on every route; the console only hides what a role can't use.
- **Critical actions** (delete a listing, suspend a dealer or user, hide or reject, change plans or team roles) need an explicit confirmation, which the console collects in a dialog. Hide, reject and suspend also need a written reason.
- **Activity log:** every admin action, listing change by sellers and dealers, registration, dealer application, subscription change and payment is recorded in `auditLog` and is append-only. It starts when this ships; earlier history can't be recovered, so older listings show only their created, published and updated dates.
- **Moderation:** hiding or rejecting a listing removes it from the main site, the dealer site and image delivery. Rejected listings can't be republished by their owner. Suspending a user or dealer blocks changes and hides their cars; reactivating restores only the cars that suspension hid.
- **Payments:** Stripe invoices are recorded from webhook events into `payments`. In the Stripe dashboard, add **`invoice.paid`**, **`invoice.payment_failed`** and **`charge.refunded`** to the existing webhook endpoint. To load past invoices, run `node backend/scripts/backfill-payments.js` (preview) then `--apply`.
- **Plans:** limits, names and whether a plan is offered are editable and apply to checkout and existing subscribers at once. Prices stay in Stripe: create a new monthly GBP price there and paste its ID; it is verified with Stripe before saving.
- **Complaints:** "Report this listing" appears on car pages on both sites. Reports queue in **Complaints** (one open report per person per car, five per hour).
- **Announcements:** an optional banner for the main site, the dealer site or both, with scheduling.
- **Reports:** CSV downloads for users, dealers, listings, subscriptions, payments and activity, filtered like the lists, with formula-injection protection. Each download is itself logged.
- **Removed:** the old "local admin" mock mode (demo data and a hard-coded login) has been deleted from the frontend.

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
4. Set `DEALER_FRONTEND_URL` for the functions (default `https://dealer.mintmotor.co.uk`) so activation emails and Stripe returns land on the dealer site.
5. Check on the live sites:
   - a dealer-only listing 404s on the main site;
   - an approved dealer sees it in the portal;
   - a paid public advert shows on the main site;
   - a dealer can't sign in on the main site;
   - a seller can't sign in on the dealer portal;
   - a signed-out visitor to `/browse` is sent to `/login`, and the home and plans pages show no listings;
   - the dealer site can be installed to a phone home screen.

## Tests

- Backend: `npm test` in `backend/functions`.
- Storage rules: `firebase emulators:exec --config sellerMedia.emulators.json --project demo-seller-media --only firestore,storage "node --test backend/functions/sellerMedia.rules.test.js"` from the repo root.
- Frontend: `npx vitest run` and `npx vite build` in `frontend`.
