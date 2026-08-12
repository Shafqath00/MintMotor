# Seller listings page and header search links

## Goal

Let buyers open a seller’s public listing page from a car-detail contact card, and make the header’s Used cars and New cars links open every matching marketplace listing.

## Scope

- Change header navigation links to the existing condition-filtered search URLs.
- Add a public seller route at `/seller/:ownerId`.
- Make the seller identity area in the contact card link to that route when a listing has an owner ID.
- Fetch only published seller listings, excluding drafts and sold vehicles.
- Exclude the currently viewed vehicle from the seller page’s “other listings” grid.
- Add an empty state when the seller has no other available cars.

## Design

The contact card keeps its existing identity layout and gains a keyboard-accessible link around the seller avatar/name area. The seller page uses the site’s standard `Layout` and `CarCard` grid. It identifies the seller from the public listings and does not expose private contact data beyond data that is already visible on individual public listings.

The existing `/search` page remains the single marketplace results experience. Header links will point directly to `/search?condition=used` and `/search?condition=new`, so their results use the currently implemented condition filter instead of navigating to explainer content.

## Data flow

`CarContactCard` → `/seller/:ownerId?exclude=<carId>` → seller page → `getCars({ ownerId, status: "published" })` → public API filter → public listings → `CarCard` grid.

The mock filter mirrors the server filter so local development returns the same seller-specific result set.

## Error handling and testing

- A seller page loading failure presents a retry state.
- An unknown seller or seller with no other public listings presents an empty state with a link to browse all cars.
- Tests cover header destinations, owner filtering in mock/server filtering, seller-card navigation, and excluding the current car.

## Non-goals

- No public seller account settings page.
- No display of drafts, sold listings, private phone/email, or postcode.
- No redesign of the existing search results page or contact card.
