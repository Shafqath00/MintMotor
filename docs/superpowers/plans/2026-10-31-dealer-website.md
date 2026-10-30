# Mint Motor Dealers: standalone marketplace website

**Goal:** Replace the sidebar dashboard on `dealer.mintmotor.co.uk` with a complete automotive marketplace website: public homepage, top navigation, browse and detail pages, plans, listing management, profile, and a distinct login and onboarding. Same brand colours as the main site, different layout and surfaces.

**Builds on:** `2026-10-31-main-dealer-separation.md` (accounts, visibility, bulk upload). No change to those rules.

## Decisions (approved 2026-10-31)
- **Dealer cars go live on the main site immediately** when published (no staff approval queue).
- **Signed-out visitors see marketing pages only:** home, plans, how it works, login, apply. No seller listing, photo, price or count is shown. Browse, details, enquiries, listing management and profile require an approved dealer login.
- **Mobile app = responsive, installable web app** (home-screen install, own dealer login). There is no native app in this repo.

## Constraints
- Backend stays authoritative. Seller contact details are still never shown to dealers; they send offers to the seller's inbox.
- Wrong-account sign-in already signs out with a pointer to the right site (`AuthContext`).
- Existing `/dealer/*` URLs, Stripe return URLs and activation-email links must keep working (redirect to the new paths).
- Free dealer-only listings stay hidden from the main site.

## Site map (dealer host)

| Path | Page | Access |
|---|---|---|
| `/` | Home: hero, search, services, how it works, plan teaser; for signed-in dealers also the newest dealer-only cars | Public (marketing) |
| `/plans` | Plans, prices, limits, FAQ; checkout button needs login | Public view |
| `/login`, `/apply` | Dealer sign-in; onboarding in steps with a "what happens next" status panel | Public |
| `/browse` | Dealer-only cars with search, filters and sort | Dealer |
| `/browse/:id` | Car details, gallery, specs, offer form | Dealer |
| `/list` | Add one car, or bulk upload (CSV, registrations) | Dealer, plan needed to publish |
| `/my-listings` | Own stock, statuses, publish/withdraw, plan usage | Dealer |
| `/enquiries` | Offers sent and replies | Dealer |
| `/profile` | Business details, account settings, billing, delete account | Dealer |

Old paths (`/dealer/login`, `/dealer/dashboard`, `/dealer/inventory`, `/dealer/plan?checkout=…`, …) redirect to the new ones.

## Design
- Scope the theme with a `theme-dealer` class on `<html>` when `isDealerPortal()`. Keep `--primary` (brand blue); change surfaces: deep navy hero and footer, warm accent for the "dealer exclusive" badge, tighter trade-style cards.
- Header: "Mint Motor Dealers" wordmark, top nav, account menu. Mobile: menu sheet plus a bottom tab bar (Browse, List, My listings, Profile).
- Login and apply: split layout with imagery and a dealer-benefits panel.

## Tasks
1. **Dealer shell and theme.** `DealerSiteLayout` (header, footer, mobile tab bar), `theme-dealer` tokens, route table with the new paths and legacy redirects, dealer-only `index.html` title, description and theme colour at runtime. Tests: nav shows signed-in/out items, legacy redirects, gated routes send to `/login?next=`.
2. **Public homepage, plans, how it works.** Backend: public `GET /dealer-plans` (tier names, prices, limits only) so signed-out visitors can see plans. Home shows no listing data when signed out. Tests: backend returns no secrets and no listing data; page renders without auth.
3. **Browse and details.** Rebuild `/browse` with search, make/model/price/year/mileage filters, sort, and a card grid. Rebuild `/browse/:id` as a full detail page (gallery, spec table, history, offer form). Check the `applyCarFilters` query params the dealer endpoint supports; add any missing ones with backend tests.
4. **List cars and My listings.** `/list` combines the single-car form and the bulk upload as tabs; `/my-listings` becomes a card-based manager with status filters, plan usage meter, publish and withdraw. Reuse the existing form and bulk components.
5. **Profile and enquiries.** Merge business profile, settings, billing and account deletion into `/profile`; keep `/enquiries`.
6. **Login and onboarding.** New split-layout login; multi-step apply form (business, contact and stock, review) with the existing validators and the `EMAIL_IN_USE_MAIN` message; activation page copy.
7. **Installable web app.** `manifest.webmanifest` for the dealer host (name, icons, theme colour, `start_url=/`), safe-area padding, touch targets, and a bottom tab bar. Selected at runtime by host so the main site is unchanged.
8. **Integration.** Full backend and frontend tests, build, a mobile and desktop browser pass of every page, update `docs/platform-split-rollout.md`.

## Out of scope / notes
- Dealers browsing the public (non-exclusive) listings from this site is not included; the main site serves those.
- A native iOS/Android app would be a separate project; this plan only makes the web app install well.
- No deploy, push or live billing change as part of the build.
