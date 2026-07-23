# MintMotor Car Detail, Verified History, and Gallery Design

## Purpose

Upgrade the seller listing flow and public car-detail page so buyers can review a complete, trustworthy vehicle advert without leaving MintMotor. The experience takes inspiration from Auto Trader's information hierarchy while retaining MintMotor's own red, white, and neutral visual identity.

The implementation will use the project's existing UK Vehicle Data subscription. Verified provider facts will remain distinct from seller-authored information and will never be represented as a successful check when the provider did not supply a result.

## Scope

This work covers:

- requesting the configured UK Vehicle Data package during vehicle lookup;
- normalizing provenance and MOT information into a stable application-owned model;
- validating and storing the normalized verification snapshot with the listing;
- showing read-only verified results in the seller advert workspace;
- redesigning the public car-detail page around a richer information hierarchy;
- adding an accessible full-screen image viewer;
- preserving existing price, distance, seller-contact, and responsive mobile behavior;
- adding regression tests for provider mapping, validation, serialization, and gallery state.

This work does not reproduce Auto Trader branding, copy, proprietary scoring, finance products, insurance quotations, seller inventory recommendations, or paid history reports. MintMotor will only show fields supplied by its own listing data and UK Vehicle Data response.

## Data Model

Add an optional `vehicleHistory` object to the shared `Car` interface and accepted listing payload. The normalized model is:

```ts
interface VehicleHistoryCheck {
  provider: "ukvehicledata";
  checkedAt: string;
  registrationNumber: string;
  summaryStatus: "clear" | "attention" | "unavailable";
  outstandingFinance: HistoryCheckItem;
  stolen: HistoryCheckItem;
  writtenOff: HistoryCheckItem;
  scrapped: HistoryCheckItem;
  imported: HistoryCheckItem;
  exported: HistoryCheckItem;
  mileageAnomaly: HistoryCheckItem;
  colourChanges: HistoryCheckItem;
  plateChanges: HistoryCheckItem;
  mot: {
    status: "valid" | "expired" | "not-found" | "unavailable";
    expiryDate?: string;
    latestMileage?: number;
    latestTestDate?: string;
    latestResult?: "passed" | "failed";
    advisoryCount?: number;
    failureCount?: number;
  };
}

interface HistoryCheckItem {
  status: "clear" | "recorded" | "unavailable";
  label: string;
  detail?: string;
}
```

`clear` is used only when the provider explicitly reports a negative result. Missing, unrecognized, failed, or absent provider data maps to `unavailable`. Any positive record maps to `recorded`, and the overall summary becomes `attention` if at least one item is recorded.

The original `lookupRaw` provider response remains server-side/private and must not be included in public car responses. Public responses expose only normalized vehicle facts and `vehicleHistory`.

## Provider Integration

Extend `backend/functions/vehicleLookup.js` rather than adding a second provider client. The existing `UKVD_API_KEY`, `UKVD_PACKAGE_ID`, and `UKVD_API_BASE_URL` configuration remains the single integration point.

The mapper will accept common UKVD response shapes defensively because package response casing and nesting can vary. Mapping helpers will normalize boolean, status-string, and record-object variants for each provenance field. Tests will cover explicit clear results, recorded results, and missing results.

During the existing registration lookup:

1. The backend requests the configured UKVD package.
2. It maps vehicle specification, valuation, features, and history in one response.
3. It stamps `checkedAt` on the server when verified history is present.
4. It returns the normalized lookup result to the seller flow.
5. Saving the draft stores the normalized history snapshot with the listing.

If UKVD is unavailable, the seller may continue creating a draft. The listing receives an unavailable verification state and must not display green history checks. Publishing remains governed by the existing subscription, email, phone, photo, description, and postcode requirements; provider downtime does not silently fabricate verification.

## Seller Advert Workspace

In `frontend/src/pages/Sellpages/CarDetails.tsx`, add a read-only panel titled **Verified vehicle history** after **History and running costs**.

The panel will:

- show the provider name and verification timestamp;
- summarize the overall result as Clear, Attention needed, or Unavailable;
- display finance, stolen, write-off, scrapped, import/export, mileage, colour-change, and plate-change results;
- show the latest MOT result, expiry, recorded mileage, and advisory/failure counts when supplied;
- explain that these facts came from UK Vehicle Data and cannot be edited manually;
- retain the existing seller-editable service-history, owner, key, and advert-description inputs as seller-provided information.

Verified facts and seller claims must use different labels and visual treatments. Provider results use a shield/check treatment; seller fields retain standard form styling.

## Public Car-Detail Information Architecture

Redesign `frontend/src/pages/CarDetail.tsx` as a responsive marketplace detail view using MintMotor tokens: white surfaces, neutral borders and backgrounds, near-black headings, and `#d72d2d` for primary actions and focus accents.

Desktop structure:

```text
Breadcrumbs                                              Save  Share

┌──────────────────────────── image mosaic ────────────────────────────┐
│                         main + supporting images                      │
└───────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────┐  ┌───────────────────────────────────┐
│ Vehicle title and highlights │  │ Sticky price/contact card         │
│ Overview specifications      │  │ Price, location, call, message    │
│ Description                  │  │ Distance calculator               │
│ Features and equipment       │  │ Seller identity                   │
│ Running costs                │  └───────────────────────────────────┘
│ Verified vehicle history     │
│ Buyer guidance               │
└──────────────────────────────┘
```

Mobile uses a single column with a swipeable main gallery and keeps the existing fixed call/message action bar. The sticky desktop contact card becomes a normal in-flow card on smaller screens.

### Page sections

1. **Gallery:** main image, supporting-image mosaic when enough photos exist, image count, save/share controls, and an obvious “View all photos” action.
2. **Vehicle identity:** year, make, model, variant, attention grabber, location, and asking price.
3. **Overview:** registration, mileage, fuel, transmission, body type, engine, colour, doors, seats, and first-registration/year data when present.
4. **Description:** seller-authored description with readable line length and preserved paragraph breaks.
5. **Features and equipment:** responsive checklist using actual listing features only.
6. **Running costs:** CO2 emissions, insurance group, urban/extra-urban/combined consumption, MOT date, and seller-provided service history.
7. **Verified vehicle history:** provider timestamp, overall status, provenance checklist, and latest MOT facts. Unavailable values are shown explicitly and never treated as clear.
8. **Seller card:** seller name, verification indicator, location, permitted contact channels, distance calculator, and enquiry form.
9. **Buyer guidance:** concise safety guidance and a reminder to inspect the vehicle and documentation before purchase.

Empty optional fields are omitted from ordinary specification grids. Verification fields are not omitted; they show “Not supplied by provider” so the absence cannot be mistaken for a clear check.

## Full-Screen Image Viewer

Clicking the main image, any mosaic image, any thumbnail, or “View all photos” opens a full-screen dialog focused on the selected image.

The viewer provides:

- a near-black backdrop and `object-contain` image presentation;
- a close button with an accessible name;
- previous and next buttons when multiple images exist;
- an `n of total` counter;
- a scrollable thumbnail rail with the active thumbnail marked;
- left/right arrow-key navigation;
- Escape-to-close through dialog semantics;
- focus trapping and focus restoration;
- body-scroll locking while open;
- responsive controls with touch-sized targets;
- wrapped navigation from the first image to the last and vice versa.

The page gallery and full-screen viewer share one selected-image index so the thumbnail, main image, and dialog always agree. Zero-image listings render a branded placeholder and do not open the viewer.

## Contact and Enquiry Behavior

Contact actions respect `showPhone` and `showEmail`:

- Call is rendered as a `tel:` link only when a public phone number is allowed.
- Email is rendered only when the seller permits it.
- Send message opens the existing enquiry form and submits through `sendEnquiry` rather than displaying a non-functional form.
- Form fields include name, email, optional phone, and message; success and error states are announced accessibly.
- If no direct channel is enabled, the enquiry form remains the buyer contact route.

The current postcode distance check remains available and retains its loading, success, and error states.

## Error and Privacy Handling

- UKVD credentials remain backend-only.
- Provider raw payloads and seller postcode coordinates never appear in public API responses.
- A provider timeout or mapping failure produces an unavailable verification state, not a clear result.
- A failed history lookup does not erase a previously saved verified snapshot during an unrelated listing edit.
- Image load failures show the neutral vehicle placeholder without breaking navigation.
- Public contact details are rendered only according to seller visibility flags.
- History timestamps are formatted for display but stored as ISO 8601 strings.

## Testing and Verification

Backend tests will verify:

- clear, recorded, and unavailable UKVD history mappings;
- overall history summary calculation;
- validation and sanitization of the normalized history object;
- preservation of existing listing validation behavior;
- exclusion of `lookupRaw`, seller postcode, and geolocation from public responses.

Frontend tests will verify:

- gallery opening at the selected image;
- previous/next wrapping and keyboard navigation;
- close behavior and accessible dialog controls;
- unavailable history values are not rendered as clear;
- conditional phone/email actions;
- successful enquiry submission state.

Completion also requires TypeScript compilation, backend test execution, a production frontend build, and browser checks at desktop and mobile widths for the public detail page and seller verification panel.

## Acceptance Criteria

- A UKVD lookup can populate a normalized verified-history snapshot on a draft.
- The seller sees provider facts as read-only and visually distinct from seller claims.
- A published detail page shows all available vehicle, running-cost, seller, and verified-history information without fabricated values.
- Selecting any car image opens a full-screen viewer at that image.
- The viewer works with mouse, keyboard, and touch-sized controls and restores focus on close.
- The public page remains usable on mobile and desktop.
- Existing listing creation, editing, publishing, distance calculation, and contact permissions continue to work.
- Automated tests, type checking, and the production build pass.
