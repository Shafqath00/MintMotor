# Live Vehicle Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create authenticated, saved UK Vehicle Data reports using only the data documents enabled in MintMotor's package.

**Architecture:** Extend the existing server-only UKVD client with a report mapper, then add authenticated report-create/read/list endpoints backed by Firestore. Replace browser demo storage with API-backed React queries while retaining the temporary no-charge checkout step.

**Tech Stack:** Firebase Functions, Firestore, Node.js tests, React, TypeScript, React Query, Vitest.

## Global Constraints

- Keep `UKVD_API_KEY`, `UKVD_PACKAGE_ID`, raw provider payloads, and provider URLs server-only.
- Display only enabled package results: vehicle/model/specification, MOT/mileage, PNC stolen, MIAFTR write-off, valuation, and tax.
- Finance, keepers, import/export, colour changes, and registration changes display `Not included in this report`.
- Require Firebase authentication and scope every stored report to its creator.
- A report is a dated immutable snapshot; provider errors never create a report.

---

### Task 1: Map the enabled UKVD package into a report snapshot

**Files:**
- Modify: `backend/functions/vehicleLookup.js`
- Test: `backend/functions/vehicleLookup.test.js`

**Interfaces:** Produces `mapVehicleCheckReport(payload, registrationNumber, checkedAt)` returning `{ reference, registrationNumber, checkedAt, vehicle, mot, tax, valuation, specification, checks, excludedChecks }`.

- [ ] Write a failing test with a complete UKVD fixture asserting MOT timeline, PNC, MIAFTR, tax, valuation, and five `excludedChecks` entries.
- [ ] Run `npm test -- vehicleLookup.test.js` from `backend/functions`; verify the missing mapper failure.
- [ ] Implement defensive UKVD document readers. Missing enabled fields map to `Not supplied by provider`; excluded checks always map to `Not included in this report`.
- [ ] Run `npm test -- vehicleLookup.test.js`; verify PASS.
- [ ] Commit mapper and tests with `feat: map live vehicle check reports`.

### Task 2: Create secure report storage endpoints

**Files:**
- Modify: `backend/functions/index.js`
- Test: `backend/functions/liveVehicleCheck.test.js`

**Interfaces:** Adds `POST /vehicle-checks`, `GET /vehicle-checks`, and `GET /vehicle-checks/:reportId`, all behind `requireAuth`.

- [ ] Write failing route tests: an authenticated create stores a normalized report under `users/{uid}/vehicleChecks/{id}`; a second user receives 404 for that ID; a UKVD failure returns 502 and stores nothing.
- [ ] Run `npm test -- liveVehicleCheck.test.js`; verify failures before route implementation.
- [ ] Implement request validation, UKVD call, Firestore save, list ordered by `checkedAt desc`, ownership lookup, and a serializer that excludes raw payloads.
- [ ] Run `npm test`; verify backend suite PASS.
- [ ] Commit endpoint and tests with `feat: store live vehicle check reports`.

### Task 3: Replace demo client storage with live report API calls

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/pages/VehicleCheck.tsx`
- Modify: `frontend/src/pages/VehicleCheckReport.tsx`
- Modify: `frontend/src/pages/VehicleCheckPrevious.tsx`
- Test: `frontend/src/pages/VehicleCheck.test.tsx`
- Test: `frontend/src/pages/VehicleCheckReport.test.tsx`
- Test: `frontend/src/pages/VehicleCheckPrevious.test.tsx`

**Interfaces:** Adds `createVehicleCheck(registrationNumber, token)`, `getVehicleChecks(token)`, and `getVehicleCheck(reportId, token)`.

- [ ] Write failing tests that submit the prefilled listing registration, show a loading state, render a server report, show exact package-limit copy, list only API reports, and show provider errors.
- [ ] Run the three focused Vitest files and confirm expected failures.
- [ ] Use `useAuth().getToken()` and React Query mutations/queries; remove local demo persistence from these pages but retain the no-charge confirmation copy.
- [ ] Render every live section from the normalized report; preserve the clear distinction between provider missing data and package-excluded checks.
- [ ] Run focused frontend tests; verify PASS.
- [ ] Commit client changes with `feat: show live vehicle check reports`.

### Task 4: Integration verification

**Files:**
- Modify only files required by test fixes discovered in Tasks 1–3.

- [ ] Run `npm test` in `backend/functions`.
- [ ] Run focused live-report frontend tests, `npx tsc --noEmit`, and `npm run build` in `frontend`.
- [ ] Start Firebase emulator and frontend dev server with valid non-production UKVD credentials; create a report for a known registration, reopen it, and confirm another signed-in user cannot retrieve it.
- [ ] Confirm provider keys and raw response fields do not appear in network responses, Firestore report documents, or page source.
- [ ] Commit integration adjustments with `test: verify live vehicle checks`.

## Plan Self-Review

- The plan maps every enabled provider document and labels the five excluded categories honestly.
- Server-side auth, ownership, snapshot persistence, raw-payload exclusion, frontend loading/error states, and end-to-end validation all have explicit tasks.
- Function names and route paths are defined before their consumers.
