# MintMotor Car Listing Enhancements Design

**Date:** 2026-07-20

## Goal

Improve the car image experience, make distance checking city-first, add a complete sold-listing workflow for sellers and admins, and broaden the vehicle options available when creating or editing a listing.

## Approved product decisions

- Sellers and admins can mark a listing sold or restore it to available.
- Sold listings remain visible in public search and detail pages.
- Sold detail pages continue to show all public vehicle information.
- Buyers cannot call or send enquiries for sold listings; those controls are replaced with a sold notice.
- The sell form should support a broad UK-market make list and structured vehicle options without adding a third-party model database in this phase.

## Current-state findings

- `frontend/src/pages/CarDetail.tsx` uses `object-cover` for the main image, which crops vehicle photos and makes them appear zoomed.
- The detail gallery has thumbnail and previous/next navigation but no full-size viewer.
- Distance calculation already uses the buyer postcode and private seller coordinates, but the UI does not lead with the seller city/location.
- Listing status currently supports only `draft` and `published`.
- Seller and admin APIs already have authenticated update paths that can be extended for a sold status.
- `frontend/src/pages/Sellpages/CarDetails.tsx` already captures many vehicle fields, but its make list is limited and colour is free text.

## Design

### 1. Listing state and sold behavior

Extend the shared listing state to `draft | published | sold`.

Seller actions will be available in the seller listing row and edit page. Seller requests will continue through the authenticated listing update route, with server-side ownership checks. Admin actions will use the existing admin car update route and validation.

Sold listings remain available through public car list and detail endpoints. Cards, detail pages, seller listings, and admin listings show a consistent `Sold` badge. On the public detail page, the call and enquiry controls are replaced by a non-interactive “This car has been sold” message. The enquiry endpoint also rejects sold listings so the UI rule cannot be bypassed.

Only published listings transition to sold. Restoring a sold listing returns it to published. Draft behavior remains unchanged.

### 2. Gallery and distance experience

The main image uses a contain-style presentation against a neutral background so the full uploaded photo is visible without artificial cropping. The main image is keyboard-accessible and opens a full-screen/lightbox viewer when clicked.

The lightbox includes a larger image, counter, close control, previous/next controls, thumbnail navigation, Escape-to-close, and mobile-safe sizing. Thumbnail selection, gallery navigation, and lightbox navigation share the same image index.

The distance card first presents the car’s public city/location, then asks the buyer for a postcode. Existing postcode normalization, private seller coordinates, and approximate-mileage calculation remain in place. Results show the buyer postcode and seller city/location without exposing the seller’s exact postcode.

### 3. Vehicle options in the sell flow

Expand the make constants to cover a broad UK market, including mainstream, premium, newer EV, performance, and niche manufacturers. Keep model and variant/trim as text inputs to avoid maintaining a large model database.

Add a standard colour selector with an `Other` path for custom colours. Retain and validate the existing fields for fuel type, transmission, body type, year, mileage, engine size, doors, seats, previous owners, keys, service history, MOT due date, CO₂, insurance group, fuel consumption, description, and features.

Add a seller-facing status control for available/published versus sold with confirmation before marking sold. Keep free-text features for uncommon equipment, and use selectable common-equipment options only where they fit the existing form without creating a separate vehicle database.

Reuse shared option constants in the sell form, search filters, validation, and detail display.

### 4. Data flow and compatibility

Existing records with no explicit status remain compatible and continue to behave as published in mock/local flows. Backend serialization continues to expose the status field. Public responses continue to remove private seller postcode and coordinates.

The backend must validate the new status and enforce authorization. The frontend API types and local mock behavior must accept the new status so development and production flows do not diverge.

## Error handling

- Invalid status values return a validation error.
- Seller updates for another owner return the existing authorization error.
- Admin updates continue to require admin authorization.
- Enquiry attempts for sold listings return a clear conflict/business-rule error.
- Invalid buyer postcodes preserve the current distance error behavior.
- Lightbox image failures use the existing image fallback behavior and do not break gallery navigation.

## Verification

Backend tests will cover seller ownership, admin transitions, public sold visibility, invalid status values, and sold-enquiry rejection. Frontend verification will cover image viewer interaction, sold rendering and disabled contact actions, seller/admin controls, city-first distance copy, and expanded sell-form options. The final implementation will run the existing backend tests and frontend TypeScript/build checks.

## Scope boundaries

- Do not add a third-party make/model database in this phase.
- Do not rebuild the entire AutoTrader-style search and filter system.
- Do not expose seller postcode or coordinates publicly.
- Do not remove sold listings from public search or detail pages.
