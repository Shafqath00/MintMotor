# MintMotor mobile app shell design

## Goal

Make the home and car-detail experiences feel deliberate and comfortable on phone screens while preserving the existing desktop layout, routes, data, and visual identity.

## Design

- Home hero uses reduced mobile whitespace, a taller image crop, and an edge-to-edge feel within the page shell.
- Hero search becomes a vertical touch-first sheet on small screens. Inputs and actions use comfortable heights, while the existing multi-column layout returns at the large breakpoint.
- Car detail uses compact page gutters, an edge-to-edge gallery treatment on phones, smaller overlays, and a horizontally scrollable thumbnail rail.
- Vehicle detail content stacks naturally on small screens. The price/contact card is no longer sticky on phones, preventing it from competing with the gallery and content.
- Call Seller and Send Message remain visible as a compact mobile-only bottom action bar; the desktop card retains the existing actions.
- Mobile spacing accounts for safe-area insets and preserves keyboard focus visibility and minimum touch targets.

## Scope and behavior

Only responsive classes and small presentation wrappers are changed in `Index.tsx`, `Hero.tsx`, `HeroSearch.tsx`, and `CarDetail.tsx`. No API, routing, or listing data behavior changes are required.

## Verification

Run the frontend production build and inspect the changed source for small-screen overflow, duplicated controls, and desktop breakpoint regressions.
