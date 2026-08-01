# MintMotor Demo Vehicle Check Design

## Purpose

Create a self-contained MintMotor vehicle-history experience that demonstrates a £5 per-car full report without taking payment or calling a live provider. It is a customer-facing product preview that follows the report-first information hierarchy selected during design review.

## Scope

The feature provides:

- a public vehicle-check landing page at `/vehicle-check`;
- UK-style registration entry and normalisation;
- a vehicle preview followed by a clearly labelled £5 demo checkout;
- an immediately unlocked full report after the user confirms the demo purchase;
- browser-saved previous checks that survive page refreshes;
- a full report containing demo data for every requested Vehicle Data Global category.

The feature does not:

- charge a card, create a Stripe checkout, or connect a payment provider;
- require sign-in or call MintMotor's backend;
- claim that the report data is live, independently verified, or a guarantee;
- alter current listing lookup, seller history, or public vehicle-detail functionality.

## User Journey

1. A buyer opens `/vehicle-check` and enters a registration.
2. The page normalises the entry (for example, `ab12 cde` becomes `AB12 CDE`) and rejects empty or invalid UK-style registrations with an actionable error.
3. A preview identifies the report as demonstration data, shows a consistent demo vehicle, and presents the fixed £5 price.
4. The buyer selects **Pay £5**. The confirmation screen states that this is a demo and no payment is collected.
5. The app creates a report record in browser storage and navigates to `/vehicle-check/report/:id`.
6. The buyer can revisit reports from **Previous checks**, ordered newest first.

## Pages and Components

### Vehicle Check Landing Page

The landing page uses the existing MintMotor header and footer. Its primary content is a registration input, a single **Start a check** action, and concise explanation of the report. The price is always shown as **£5 per vehicle check**.

After a valid registration is submitted, the page renders an in-place preview rather than navigating away. The preview shows the normalised registration, demo vehicle make/model/year, report price, and the demo-payment disclosure. It has a back action and the **Pay £5** demo action.

### Previous Checks Page

The previous-checks view presents saved reports as a simple list: registration, vehicle identity, overall status, created timestamp, and a **View report** link. It has an empty state explaining that the first check starts on the vehicle-check page.

### Full Report Page

The report is structured for linear reading and print-style trust rather than a dashboard. It starts with the MintMotor report reference, generation time, registration, vehicle name, and a prominent status summary. The summary uses text and icons, never colour alone.

The report sections are:

1. **Vehicle details** — make, model, body type, colour, fuel, transmission, engine, first-registration date, and vehicle specifications.
2. **Report summary** — a compact all-clear or attention-needed overview of the provenance checks.
3. **Keeper information** — number of previous keepers and last keeper change.
4. **Status and provenance** — scrapped, imported/exported, colour changes, registration changes, outstanding finance, police stolen, and insurance write-off statuses.
5. **MOT and mileage** — current MOT status, tax status, MOT history entries, and a mileage timeline visual/table that exposes any anomaly.
6. **Value and equipment** — estimated valuation range and demo vehicle features.
7. **Before you buy** — guidance that the data is demonstrative, buyers should inspect the car and documents, and no payment was taken.

## Demo Data and Storage

`vehicleCheckDemo.ts` supplies a deterministic report factory. A registration selects one of several seeded demo profiles by a stable registration hash, keeping repeat checks recognisable while avoiding a live data claim. Every report profile includes values for every requested category.

Reports are stored under one namespaced `localStorage` key as a bounded newest-first list of 20 records. Each record contains only the report fields displayed in the browser: generated ID, registration, generated timestamp, summary status, and report data. Invalid or unreadable storage is discarded safely. The app creates a fresh report record after each demo checkout confirmation; it does not overwrite an existing report.

## Routing and Navigation

Add routes for:

- `/vehicle-check`
- `/vehicle-check/report/:reportId`
- `/vehicle-check/previous`

The header adds a discoverable **Vehicle check** entry. Contextual **Previous checks** links appear on the landing page and after report completion. Unknown report IDs show the existing not-found treatment with a route back to start a check.

## Visual Direction and Accessibility

The chosen report-first direction uses MintMotor's existing neutral surface and primary-accent tokens. The report header is information-dense but calm; individual check rows have a label, explicit outcome text, and a short supporting explanation. No Auto Trader branding, wording, or proprietary score is copied.

The flow is keyboard usable: input labels are visible, validation is announced, controls retain focus states, and report tables have semantic headers. Status does not rely on colour. The report remains one-column on mobile and converts multi-column facts into readable rows.

## Error Handling

- Empty or invalid registration: keep the input value and explain the expected format.
- Unavailable browser storage: still show the current report; explain that it cannot be saved for later.
- Missing/invalid saved report: show the not-found state rather than failing the route.
- Demo checkout: always makes the no-charge status clear before and after unlock.

## Testing and Verification

Add focused frontend tests for:

- registration normalisation and validation;
- demo checkout unlocking a report without a payment request;
- report creation and bounded browser persistence;
- report view rendering all requested check categories;
- previous-check list ordering and empty state;
- missing report route handling.

Run the focused Vitest tests, the full frontend test suite, TypeScript checking, linting, and a production build. Manually inspect desktop and narrow mobile report layouts.

## Acceptance Criteria

- A buyer can start a check with a valid UK-style registration and unlock a demo £5 report without submitting payment details.
- The report visibly covers specifications, keepers, scrapped, import/export, colour and registration changes, MOT, mileage, tax, valuation, features, finance, stolen, and insurance write-off checks.
- Reports are clearly identified as demo data and never represented as live provider data.
- A completed demo report can be reopened from previous checks after a browser refresh when storage is available.
- Existing seller vehicle lookup and Stripe subscription code are unaffected.
