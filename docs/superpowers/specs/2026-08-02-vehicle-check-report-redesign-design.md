# Vehicle Check Report Redesign

## Goal

Restyle `VehicleCheckReport.tsx` as a trustworthy, document-like MintMotor vehicle history report. Use the supplied AutoTrader sample only for information hierarchy and report density; retain MintMotor's existing theme tokens, typography, components, and brand identity.

## Visual Direction

- Use the existing `primary`, neutral, charcoal, border, background, and foreground theme tokens. Do not introduce a competing colour system or copy AutoTrader branding.
- Use MintMotor's configured Outfit display type and DM Sans body type through the existing font utilities.
- Present the report in a narrow, centred reading column on a quiet neutral background.
- Keep surfaces white, borders precise, shadows restrained, and corner radii consistent with the current MintMotor component system.
- Use colour semantically: primary for actions and identity, green for clear results, amber for cautions or unavailable provider data, and red only for recorded warnings.

## Page Structure

1. A compact action row provides “Previous checks” and “Print report”.
2. The report header shows the report label, registration, full vehicle identity, checked timestamp, and a clear/attention status badge.
3. Vehicle details appear as a dense two-column definition grid that becomes one column on small screens.
4. Report summary renders each supplied check as a semantic status row with an icon, plain-language label, status, and provider detail when present.
5. MOT and tax information begins with four summary facts, followed by a mileage line chart and a chronological MOT table.
6. Valuation uses two visually prominent but restrained figures for private sale and retail estimates.
7. Equipment is deduplicated before rendering. Show the first 12 items initially and provide a “Show all equipment” / “Show fewer” control.
8. Package exclusions appear in a neutral information section labelled “Not included in this report”; excluded items must never resemble failed checks.
9. A final buyer guidance note explains that the report is a dated snapshot and should be compared with the vehicle, VIN, and documents.

## Component Boundaries

Keep data fetching and authentication in `VehicleCheckReport`. Extract small local presentation components in the same file for report sections, fact cells, status rows, the MOT chart/table, valuation figures, and equipment disclosure. These components consume the existing normalized `VehicleCheckReport` API type and do not know about UKVD's raw payload.

## Data Presentation Rules

- Format dates for UK readers while preserving “Not supplied by provider” for absent values.
- Format status labels as human-readable title case rather than raw lowercase API values.
- Deduplicate equipment case-insensitively while preserving first-seen display text.
- Sort MOT entries newest first for the table and oldest first for the chart.
- Generate the mileage chart locally from the saved snapshot; do not add a chart dependency.
- Do not display raw provider fields, credentials, full VIN data, or unsupported check categories.

## Responsive and Accessible Behaviour

- All sections remain readable at mobile widths without horizontal page scrolling.
- The MOT table may scroll within its own container on narrow screens.
- Status is communicated by icon and text, not colour alone.
- Equipment controls expose `aria-expanded` and use clear action labels.
- Keyboard focus remains visible through existing theme focus styles.
- Print output hides navigation/actions, removes decorative shadows, and keeps report sections legible.

## Loading and Error States

Retain the authenticated loading and error flow, but place both states inside a centred MintMotor report shell. Errors include a route back to start another check. No provider or internal diagnostic detail is exposed.

## Testing

- Update the report page test to mock an authenticated saved live report rather than browser demo storage.
- Assert vehicle details, semantic check states, MOT history, valuation, exclusions, and equipment expansion.
- Run the focused page test, TypeScript, and production build.

## Out of Scope

- Changing the live report API, Firestore storage, payment flow, or selected UKVD data package.
- Adding unsupported finance, keeper, import/export, colour-change, or registration-change results.
- Copying AutoTrader logos, colours, wording, or proprietary presentation assets.
