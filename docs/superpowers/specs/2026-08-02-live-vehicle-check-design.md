# Live Vehicle Check Design

## Purpose

Replace MintMotor's browser-only demo report with a saved live report backed by the configured UK Vehicle Data package. The report gives buyers a complete reading experience for the data actually enabled by the account without overstating unavailable checks.

## Included Live Data

The configured package supplies:

- vehicle and model details;
- specification and options;
- MOT history and recorded mileage;
- Police National Computer stolen status;
- MIAFTR insurance/write-off records;
- UK Vehicle Data valuation;
- vehicle-tax status.

The report will explicitly state **Not included in this report** for outstanding finance, keeper history, import/export status, colour changes, and registration changes. It must never present these categories as clear or as a provider result.

## Architecture

A new authenticated Firebase Function endpoint accepts a UK registration after the temporary demo unlock. It uses the existing backend-only `UKVD_API_KEY`, `UKVD_PACKAGE_ID`, and `UKVD_API_BASE_URL` configuration to request the full package, normalizes the response into an application-owned report schema, and stores the snapshot in Firestore under the buyer's user ID.

The browser sends only the registration and Firebase bearer token. It never receives provider credentials or the raw provider payload. The report page reads the saved snapshot through an authenticated endpoint; previous checks list only the signed-in buyer's saved reports.

## Buyer Flow

1. A buyer selects **Check full history** on a car detail page or opens `/vehicle-check`.
2. The registration is prefilled when it came from a listing.
3. The buyer confirms the £5 demo checkout; no charge occurs during this phase.
4. The backend fetches the provider package and creates a dated report reference.
5. MintMotor opens the saved report and exposes it under previous checks.

## Report Content

The report-first page contains:

1. vehicle identity, registration, report reference, timestamp, and source disclosure;
2. vehicle/model details and specification/options;
3. a summary of stolen, write-off, MOT/mileage, tax, and package-limit statuses;
4. detailed PNC stolen and MIAFTR write-off results;
5. tax status, valuation, and full MOT timeline/mileage table;
6. a list of unavailable paid-report categories with the exact package-limit message;
7. buyer guidance reminding users to inspect the VIN, vehicle, and documents.

## Data Handling and Errors

Provider payloads remain private. The normalized snapshot stores the provider name, report timestamp, registration, supported results, and unavailable-category markers. A failed provider call creates no paid report and returns a clear retryable error. Missing data inside a successful provider response is labeled **Not supplied by provider**. Saved reports do not refresh automatically, preserving the data the buyer received at the time of the check.

## Tests and Acceptance Criteria

Backend tests cover authentication, user ownership, successful UKVD mapping, unavailable category labels, provider failure, and raw-payload exclusion. Frontend tests cover prefilled registrations, live-report loading, prior-report ownership, package-limit copy, and failed lookup states.

The feature is complete when a signed-in buyer can create and reopen a live UKVD-backed report; every enabled package category is shown; excluded categories are clearly marked; and backend credentials/raw data never reach the browser.
