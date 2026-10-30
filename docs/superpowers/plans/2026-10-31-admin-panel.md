# Mint Motor admin panel: complete management system

**Goal:** Turn the existing tabbed admin page into a full admin console covering both websites: live dashboard, users, dealers, listings, subscriptions and payments, activity log, reports with export, moderation, content, and admin roles. Everything reads and writes real data.

## What exists today
- One page, `/admin`, with tabs: Overview, Applications, Dealers, Listings, Enquiries, Users, Settings (homepage content). Plus user and dealer detail pages.
- API: `/admin/summary`, `/admin/cars`, `/admin/users`, `/admin/enquiries`, dealer applications and dealer suspend/reactivate, SCS import, homepage settings.
- Admin = a single `admin` claim. No per-person roles.

## Gaps against the brief
| Brief | Today | Needed |
|---|---|---|
| Audit log, activity history, listing history | None | New `auditLog` collection written by every admin action and key user/dealer/billing events; searchable viewer; per-user, per-dealer and per-listing timelines |
| Payments and revenue | Only subscription status on profiles | Record Stripe invoices and failures from webhooks into `payments`; revenue, failed payments, expiring subscriptions |
| Plan management | Plans hard-coded in `dealerTiers.js` | Editable limits and visibility stored in Firestore, falling back to the code defaults. Changing a **price** still needs a new Stripe price, so the panel records the Stripe price ID and checks it |
| Reports and export | None | CSV downloads for users, dealers, listings, subscriptions, payments and activity |
| Reported listings and complaints | None | "Report this listing" on the main site and dealer site, plus an admin queue |
| Admin team roles | One admin flag | Roles: owner, support, content, finance, with per-route permissions |
| Listing moderation | Edit/delete only | Hide, reject with a reason, feature; hidden and rejected cars disappear from both sites |
| Notifications / announcements | None | Announcement banner shown on the main site and/or dealer site |
| Dashboard charts | Counts only | Real charts from live data: signups, listings, revenue over time, with date filters |

## Decisions I'll assume unless you change them
- **Payments come from Stripe**, recorded by the existing webhook (plus a one-off backfill from Stripe), not typed in by hand.
- **Plan prices stay in Stripe.** The admin edits limits, names and whether a plan is offered; a price change means creating a new Stripe price and pasting its ID.
- **Moderation happens after publishing.** Dealer cars still go live immediately; admins can hide or reject them afterwards.
- **Activity before this release can't be recovered.** The log starts when it ships. Existing createdAt/updatedAt dates are used for listing history until then.

## Admin console structure (left sidebar on desktop, drawer on mobile)
Overview · Moderation queue · Users · Dealers · Listings · Subscriptions and plans · Payments · Activity log · Reports · Reports and complaints · Content and announcements · Team and permissions · Settings.

Premium look: Mint Motor blue and neutral surfaces, translucent sticky header, status pills (active, pending, rejected, expired), skeleton loading, empty states, keyboard-friendly tables with sorting and pagination, instant press feedback, reduced-motion support. Same Apple-style motion rules used elsewhere in the site.

## Tasks
1. **Audit log foundation (backend, TDD).** `auditLog` writer used by every admin route and by listing, subscription and account events; `GET /admin/activity` with filters and pagination; per-entity timelines. Tests: every admin mutation writes an entry; entries are append-only; non-admins get 403.
2. **Roles and permissions (backend, TDD).** Admin roles stored as custom claims; middleware `requirePermission("listings.moderate")`; team management endpoints; owner-only role changes; confirmation required on critical actions. Tests per route.
3. **Payments and plans (backend, TDD).** Webhook writes `payments`; backfill script; `GET /admin/payments`, `/admin/subscriptions`, revenue summary; editable plan config with validation. Tests with fake Stripe events.
4. **Moderation and reports (backend, TDD).** Listing hide/reject/feature with reason; public "report" endpoint with rate limiting; admin queue; hidden listings excluded from public and dealer endpoints.
5. **Stats and exports (backend, TDD).** `GET /admin/stats` (time series, counts, alerts) computed from real data; CSV export endpoints with the same filters as the lists.
6. **Console shell and overview (frontend).** Sidebar layout, routing per section, permission-aware navigation, overview with charts, alerts and recent activity.
7. **Users, dealers, listings sections (frontend).** Tables with search, filters, sorting, pagination; detail drawers with timelines; actions with confirmation dialogs.
8. **Subscriptions, payments, plans, reports, activity, content, team (frontend).** Remaining sections wired to the new APIs, CSV download buttons.
9. **Public hooks.** Report button and announcement banner on both sites; hidden/rejected listings respected everywhere.
10. **Integration.** Full backend and frontend tests, build, browser pass at desktop, tablet and phone widths, rollout notes. No deploy or live billing change.

## Notes
- This is large; I'd build it in the order above and commit after each task so you can review progress.
- Real-data requirement: no sample data. Empty states appear where the platform has no activity yet (for example, payments before the backfill runs).
