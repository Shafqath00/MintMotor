# Car Detail, Verified History, and Gallery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete MintMotor vehicle-detail experience with server-verified UK Vehicle Data history, richer seller input, a responsive Auto Trader-inspired information hierarchy, and an accessible full-screen image viewer.

**Architecture:** Extend the existing UKVD mapper and listing validator with a normalized history snapshot, then refresh that snapshot authoritatively on publish. Split the oversized public detail view into focused gallery, history, and contact components while keeping `CarDetail.tsx` as the route-level data coordinator. Add Vitest and Testing Library for frontend interaction tests; retain Node's built-in test runner for backend behavior.

**Tech Stack:** React 18, TypeScript 5.8, Vite 5, Tailwind CSS, Radix Dialog, TanStack Query, Express 5, Firebase Functions/Firestore, Node 22 test runner, Vitest, Testing Library, UK Vehicle Data API.

## Global Constraints

- Preserve MintMotor's white, neutral, near-black, and `#d72d2d` visual language; do not copy Auto Trader branding or proprietary copy.
- Treat a provider field as `clear` only when UKVD explicitly supplies a negative result; missing or unknown values are `unavailable`.
- Keep `UKVD_API_KEY`, `UKVD_PACKAGE_ID`, provider raw payloads, seller postcode, and geolocation out of public responses.
- Public verified history must be refreshed server-side during publishing and must not rely solely on browser-submitted values.
- Respect `showPhone` and `showEmail` for public contact actions.
- Preserve existing listing creation, editing, publishing, subscription checks, distance calculation, and mobile contact behavior.
- Use actual listing/provider data only; omit unsupported finance and insurance quotations.

---

## File Structure

- `backend/functions/vehicleLookup.js`: normalize UKVD vehicle-history/provenance fields.
- `backend/functions/vehicleLookup.test.js`: mapping regression tests for clear, recorded, and unavailable results.
- `backend/functions/validators.js`: sanitize the nested history snapshot accepted on drafts.
- `backend/functions/validators.test.js`: history validation tests.
- `backend/functions/index.js`: strip private/raw fields and refresh history on publish.
- `backend/functions/publicCar.js`: focused public-listing sanitizer that can be tested without booting Firebase.
- `backend/functions/publicCar.test.js`: privacy and contact-visibility tests.
- `frontend/src/lib/data.ts`: shared `VehicleHistoryCheck` and `HistoryCheckItem` types.
- `frontend/src/components/cars/galleryState.ts`: pure wrapped-index helper used by the gallery.
- `frontend/src/components/cars/galleryState.test.ts`: gallery index unit tests.
- `frontend/src/components/cars/CarImageGallery.tsx`: responsive mosaic and full-screen dialog.
- `frontend/src/components/cars/CarImageGallery.test.tsx`: interaction and keyboard tests.
- `frontend/src/components/cars/VehicleHistoryPanel.tsx`: reusable seller/public history presentation.
- `frontend/src/components/cars/VehicleHistoryPanel.test.tsx`: semantic status tests.
- `frontend/src/components/cars/CarContactCard.tsx`: contact permissions, distance, and enquiry form.
- `frontend/src/components/cars/CarContactCard.test.tsx`: channel visibility and enquiry behavior tests.
- `frontend/src/pages/Sellpages/CarDetails.tsx`: retain provider history in form state/payload and show the read-only seller panel.
- `frontend/src/pages/CarDetail.tsx`: route-level layout and complete detail sections.
- `frontend/vitest.config.ts`: jsdom, React, and `@` alias test configuration.
- `frontend/src/test/setup.ts`: jest-dom setup and browser API shims.
- `frontend/package.json` and `frontend/package-lock.json`: test script and dev dependencies.

---

### Task 1: Normalize UKVD verified-history data

**Files:**
- Modify: `backend/functions/vehicleLookup.test.js`
- Modify: `backend/functions/vehicleLookup.js`

**Interfaces:**
- Consumes: existing `mapUkvdResponse(payload, {registrationNumber, mileage})`.
- Produces: `mapVehicleHistory(response, registrationNumber, checkedAt?)` and `vehicleHistory` on mapped lookup results.

- [ ] **Step 1: Write failing mapping tests**

Add a deterministic VDI payload to `vehicleLookup.test.js` and assert all three status modes:

```js
const historyPayload = {
  Response: {
    ...sampleUkvdPayload.Response,
    DataItems: {
      ...sampleUkvdPayload.Response.DataItems,
      VdiCheck: {
        Finance: {RecordCount: 0},
        Stolen: {RecordCount: 1, Message: "Police interest recorded"},
        WrittenOff: {RecordCount: 0},
        Scrapped: {RecordCount: 0},
        Imported: {RecordCount: 0},
        Exported: {RecordCount: 0},
        Mileage: {IsAnomaly: false},
        ColourChanges: {RecordCount: 0},
        PlateChanges: {RecordCount: 2},
      },
      MotHistory: {
        MotDueDate: "2027-03-04",
        LatestMileage: 50120,
        LatestTestDate: "2026-03-04",
        LatestResult: "Pass",
        AdvisoryCount: 2,
        FailureCount: 1,
      },
    },
  },
};

test("mapVehicleHistory distinguishes clear, recorded and unavailable UKVD facts", () => {
  const history = mapVehicleHistory(historyPayload.Response, "AB12CDE", "2026-07-23T10:00:00.000Z");
  assert.equal(history.outstandingFinance.status, "clear");
  assert.equal(history.stolen.status, "recorded");
  assert.equal(history.plateChanges.status, "recorded");
  assert.equal(history.summaryStatus, "attention");
  assert.equal(history.mot.latestMileage, 50120);
});

test("mapVehicleHistory never treats missing provider facts as clear", () => {
  const history = mapVehicleHistory({DataItems: {}}, "AB12CDE", "2026-07-23T10:00:00.000Z");
  assert.equal(history.outstandingFinance.status, "unavailable");
  assert.equal(history.summaryStatus, "unavailable");
});
```

- [ ] **Step 2: Run the mapping tests and confirm RED**

Run: `cd backend/functions && node --test vehicleLookup.test.js`

Expected: FAIL because `mapVehicleHistory` is not exported and lookup results lack `vehicleHistory`.

- [ ] **Step 3: Implement defensive history normalization**

Add helpers that inspect the known UKVD `VdiCheck`, `VDICheck`, and `VehicleHistory` containers without making missing data clear:

```js
function historyItem(label, value, detail = "") {
  if (value === undefined || value === null || value === "") {
    return {status: "unavailable", label, detail: "Not supplied by provider"};
  }
  const count = typeof value === "object" ? firstValue(value.RecordCount, value.Count, value.Total) : undefined;
  const recorded = count !== undefined
    ? asNumber(count, 0) > 0
    : [true, "true", "yes", "recorded", "alert"].includes(String(value.Value ?? value).toLowerCase());
  return {
    status: recorded ? "recorded" : "clear",
    label,
    ...(detail || value?.Message ? {detail: detail || asText(value.Message)} : {}),
  };
}

function mapVehicleHistory(response, registrationNumber, checkedAt = new Date().toISOString()) {
  const dataItems = response?.DataItems || response?.dataItems || {};
  const source = dataItems.VdiCheck || dataItems.VDICheck || dataItems.VehicleHistory || response?.VdiCheck || {};
  const items = {
    outstandingFinance: historyItem("Outstanding finance", source.Finance ?? source.OutstandingFinance),
    stolen: historyItem("Stolen vehicle", source.Stolen),
    writtenOff: historyItem("Insurance write-off", source.WrittenOff ?? source.WriteOff),
    scrapped: historyItem("Scrapped", source.Scrapped),
    imported: historyItem("Imported", source.Imported),
    exported: historyItem("Exported", source.Exported),
    mileageAnomaly: historyItem("Mileage anomaly", source.Mileage?.IsAnomaly ?? source.MileageAnomaly),
    colourChanges: historyItem("Colour changes", source.ColourChanges),
    plateChanges: historyItem("Registration plate changes", source.PlateChanges),
  };
  const statuses = Object.values(items).map((item) => item.status);
  const mot = dataItems.MotHistory || response?.MotHistory || {};
  return {
    provider: "ukvehicledata",
    checkedAt,
    registrationNumber: normalizeRegistration(registrationNumber),
    summaryStatus: statuses.includes("recorded") ? "attention" : statuses.every((status) => status === "clear") ? "clear" : "unavailable",
    ...items,
    mot: mapMotSummary(mot),
  };
}
```

Call `mapVehicleHistory(response, registrationNumber)` from `mapUkvdResponse` and export the helper for tests.

- [ ] **Step 4: Run the backend mapping tests and confirm GREEN**

Run: `cd backend/functions && node --test vehicleLookup.test.js`

Expected: all vehicle lookup tests pass.

- [ ] **Step 5: Commit the provider mapper**

```bash
git add backend/functions/vehicleLookup.js backend/functions/vehicleLookup.test.js
git commit -m "feat: normalize UKVD vehicle history"
```

---

### Task 2: Validate history and protect public listing data

**Files:**
- Modify: `backend/functions/validators.test.js`
- Modify: `backend/functions/validators.js`
- Create: `backend/functions/publicCar.js`
- Create: `backend/functions/publicCar.test.js`
- Modify: `backend/functions/index.js`

**Interfaces:**
- Consumes: `VehicleHistoryCheck`-shaped object returned by Task 1.
- Produces: `sanitizeVehicleHistory(value)` and `publicCar(car)`.

- [ ] **Step 1: Write failing validator and privacy tests**

Add a validator case that accepts only allowed statuses and strips unknown nested keys. Add `publicCar.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");
const {publicCar} = require("./publicCar");

test("publicCar removes provider raw data and private seller location", () => {
  const result = publicCar({
    id: "car-1",
    lookupRaw: {secret: "provider-payload"},
    sellerPostcode: "M1 1AE",
    sellerGeo: {lat: 53.4, lng: -2.2},
    showEmail: false,
    showPhone: false,
    contactEmail: "seller@example.com",
    contactPhone: "+447700900000",
  });
  assert.equal(result.lookupRaw, undefined);
  assert.equal(result.sellerPostcode, undefined);
  assert.equal(result.sellerGeo, undefined);
  assert.equal(result.contactEmail, "");
  assert.equal(result.contactPhone, "");
});
```

- [ ] **Step 2: Run privacy tests and confirm RED**

Run: `cd backend/functions && node --test validators.test.js publicCar.test.js`

Expected: FAIL because `publicCar.js` and history sanitation do not exist.

- [ ] **Step 3: Implement nested history sanitation**

Add allowlists for item and MOT statuses and return a normalized object only when `provider === "ukvehicledata"`. Unknown properties are discarded; invalid states add a validation error rather than being stored.

```js
const HISTORY_ITEM_STATUS = new Set(["clear", "recorded", "unavailable"]);
const HISTORY_SUMMARY_STATUS = new Set(["clear", "attention", "unavailable"]);
const MOT_STATUS = new Set(["valid", "expired", "not-found", "unavailable"]);

function sanitizeHistoryItem(value = {}) {
  return {
    status: HISTORY_ITEM_STATUS.has(value.status) ? value.status : "unavailable",
    label: asString(value.label).slice(0, 80),
    detail: asString(value.detail).slice(0, 300),
  };
}
```

Wire `vehicleHistory: sanitizeVehicleHistory(payload.vehicleHistory)` into `validateListingPayload` only when supplied.

- [ ] **Step 4: Extract and use the public sanitizer**

Create `publicCar.js` with the existing contact visibility behavior plus deletion of `lookupRaw`, `sellerPostcode`, and `sellerGeo`. Import it into `index.js` and remove the inline duplicate.

- [ ] **Step 5: Remove raw UKVD data from the lookup response**

In the existing vehicle-lookup route, destructure the mapper result before responding so `lookupRaw` never leaves the backend:

```js
const {lookupRaw, ...safeLookup} = lookup;
res.json({vehicle: safeLookup});
```

Remove `lookupRaw` from the frontend `Car` interface and listing payload. Do not persist raw provider payloads in Firestore.

- [ ] **Step 6: Refresh trusted history during publish**

In `POST /cars/:id/publish`, call the existing provider lookup before the Firestore publish update:

```js
const verifiedLookup = await lookupVehicle({
  registrationNumber: car.registrationNumber,
  mileage: car.mileage,
});
const verifiedHistory = verifiedLookup.lookupProvider === "ukvehicledata"
  ? verifiedLookup.vehicleHistory
  : car.vehicleHistory;
```

Write `vehicleHistory: verifiedHistory` with the publish update. If UKVD temporarily fails and a prior UKVD snapshot exists, retain it; otherwise store the unavailable snapshot and avoid false clear indicators.

- [ ] **Step 7: Run the complete backend suite**

Run: `cd backend/functions && npm test`

Expected: all Node tests pass with no failures.

- [ ] **Step 8: Commit backend persistence and privacy**

```bash
git add backend/functions/index.js backend/functions/publicCar.js backend/functions/publicCar.test.js backend/functions/validators.js backend/functions/validators.test.js
git commit -m "feat: secure verified listing history"
```

---

### Task 3: Add frontend test infrastructure and shared history types

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Create: `frontend/vitest.config.ts`
- Create: `frontend/src/test/setup.ts`
- Modify: `frontend/src/lib/data.ts`
- Create: `frontend/src/components/cars/galleryState.ts`
- Create: `frontend/src/components/cars/galleryState.test.ts`

**Interfaces:**
- Produces: `VehicleHistoryCheck`, `HistoryCheckItem`, and `wrapGalleryIndex(index, length)`.

- [ ] **Step 1: Install and configure the test runner**

Run:

```bash
cd frontend
npm install --save-dev vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
```

Add `"test": "vitest run"` to scripts and create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {alias: {"@": path.resolve(__dirname, "./src")}},
  test: {environment: "jsdom", setupFiles: ["./src/test/setup.ts"], css: true},
});
```

- [ ] **Step 2: Write a failing wrapped-index test**

```ts
import {describe, expect, it} from "vitest";
import {wrapGalleryIndex} from "./galleryState";

describe("wrapGalleryIndex", () => {
  it("wraps both ends of a gallery", () => {
    expect(wrapGalleryIndex(-1, 4)).toBe(3);
    expect(wrapGalleryIndex(4, 4)).toBe(0);
  });
  it("returns zero for an empty gallery", () => {
    expect(wrapGalleryIndex(3, 0)).toBe(0);
  });
});
```

- [ ] **Step 3: Run the unit test and confirm RED**

Run: `cd frontend && npm test -- galleryState.test.ts`

Expected: FAIL because `galleryState.ts` does not exist.

- [ ] **Step 4: Add types and minimal index implementation**

Add the approved interfaces to `data.ts`, make `Car.vehicleHistory?: VehicleHistoryCheck`, and implement:

```ts
export function wrapGalleryIndex(index: number, length: number) {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}
```

- [ ] **Step 5: Run the frontend unit test and confirm GREEN**

Run: `cd frontend && npm test -- galleryState.test.ts`

Expected: both tests pass.

- [ ] **Step 6: Commit test infrastructure and types**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vitest.config.ts frontend/src/test/setup.ts frontend/src/lib/data.ts frontend/src/components/cars/galleryState.ts frontend/src/components/cars/galleryState.test.ts
git commit -m "test: add frontend interaction harness"
```

---

### Task 4: Build the accessible image mosaic and full-screen viewer

**Files:**
- Create: `frontend/src/components/cars/CarImageGallery.test.tsx`
- Create: `frontend/src/components/cars/CarImageGallery.tsx`

**Interfaces:**
- Consumes: `{images: string[]; title: string}` and `wrapGalleryIndex`.
- Produces: `CarImageGallery` with mosaic, selected index, and Radix full-screen dialog.

- [ ] **Step 1: Write failing gallery interaction tests**

Render three labelled images, click the second thumbnail, assert the dialog begins at `2 of 3`, press ArrowRight and assert `3 of 3`, press ArrowRight again and assert `1 of 3`, then press Escape and assert the dialog closes. Add a zero-image test that renders the placeholder and no gallery-open button.

```tsx
it("opens the selected image and supports wrapped keyboard navigation", async () => {
  const user = userEvent.setup();
  render(<CarImageGallery images={["/one.jpg", "/two.jpg", "/three.jpg"]} title="2019 Volkswagen Polo" />);
  await user.click(screen.getByRole("button", {name: "Open image 2 of 3"}));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByText("2 of 3")).toBeInTheDocument();
  await user.keyboard("{ArrowRight}{ArrowRight}");
  expect(screen.getByText("1 of 3")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the gallery tests and confirm RED**

Run: `cd frontend && npm test -- CarImageGallery.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the MintMotor gallery**

Use a two-thirds main image and one-third supporting grid on desktop, a single main image plus horizontal thumbnails on mobile, and `Dialog`/`DialogContent` for focus trapping, Escape handling, and focus restoration. Add a document keydown effect only while open for ArrowLeft/ArrowRight. Every image-opening control must include its `n of total` accessible name.

- [ ] **Step 4: Run gallery tests and confirm GREEN**

Run: `cd frontend && npm test -- CarImageGallery.test.tsx`

Expected: all gallery tests pass.

- [ ] **Step 5: Commit the gallery**

```bash
git add frontend/src/components/cars/CarImageGallery.tsx frontend/src/components/cars/CarImageGallery.test.tsx
git commit -m "feat: add full-screen vehicle gallery"
```

---

### Task 5: Present verified history in seller and buyer contexts

**Files:**
- Create: `frontend/src/components/cars/VehicleHistoryPanel.test.tsx`
- Create: `frontend/src/components/cars/VehicleHistoryPanel.tsx`
- Modify: `frontend/src/pages/Sellpages/CarDetails.tsx`

**Interfaces:**
- Consumes: `{history?: VehicleHistoryCheck; mode: "seller" | "public"}`.
- Produces: reusable `VehicleHistoryPanel` with honest clear/attention/unavailable status semantics.

- [ ] **Step 1: Write failing status-semantics tests**

Assert that `clear` produces “No record found,” `recorded` produces “Record found,” and `unavailable` produces “Not supplied by provider” with no green check icon or “clear” wording.

- [ ] **Step 2: Run panel tests and confirm RED**

Run: `cd frontend && npm test -- VehicleHistoryPanel.test.tsx`

Expected: FAIL because the panel does not exist.

- [ ] **Step 3: Implement the reusable panel**

Use a white card, neutral rules, `#d72d2d` for attention, green only for explicit clear, and grey for unavailable. Render the provider timestamp, nine provenance checks, and MOT summary. In seller mode add “Verified by UK Vehicle Data — these facts cannot be edited.”

- [ ] **Step 4: Persist and render seller history**

Add `vehicleHistory` to `emptyForm`, hydrate it from `car.vehicleHistory`, include it in `payload`, and render the panel immediately after the existing History and running costs panel. Remove the development `console.log(car)` while editing this section.

- [ ] **Step 5: Run seller/history tests and type checking**

Run:

```bash
cd frontend
npm test -- VehicleHistoryPanel.test.tsx
npx tsc --noEmit
```

Expected: panel tests pass and TypeScript reports no diagnostics.

- [ ] **Step 6: Commit history UI**

```bash
git add frontend/src/components/cars/VehicleHistoryPanel.tsx frontend/src/components/cars/VehicleHistoryPanel.test.tsx frontend/src/pages/Sellpages/CarDetails.tsx
git commit -m "feat: show verified vehicle history"
```

---

### Task 6: Build the functional contact card

**Files:**
- Create: `frontend/src/components/cars/CarContactCard.test.tsx`
- Create: `frontend/src/components/cars/CarContactCard.tsx`
- Modify: `frontend/src/lib/api.ts`

**Interfaces:**
- Consumes: `car`, `buyerPostcode`, distance mutation state, and `sendEnquiry(carId, payload)`.
- Produces: permission-aware phone/email actions and a working enquiry form.

- [ ] **Step 1: Write failing permission and enquiry tests**

Assert phone/email links are absent when visibility flags are false, present with correct `tel:`/`mailto:` URLs when true, and a valid message submission calls `sendEnquiry` then announces “Enquiry sent.” Mock only the network API boundary.

- [ ] **Step 2: Run contact-card tests and confirm RED**

Run: `cd frontend && npm test -- CarContactCard.test.tsx`

Expected: FAIL because `CarContactCard` does not exist.

- [ ] **Step 3: Implement contact, distance, and enquiry behavior**

Move the current seller identity and postcode distance UI into the card. Use controlled name/email/phone/message fields, `useMutation` for `sendEnquiry`, accessible success/error regions, and conditional direct contact links. Keep the desktop card sticky through a wrapper class supplied by the route.

- [ ] **Step 4: Run contact-card tests and confirm GREEN**

Run: `cd frontend && npm test -- CarContactCard.test.tsx`

Expected: all contact-card tests pass.

- [ ] **Step 5: Commit the contact card**

```bash
git add frontend/src/components/cars/CarContactCard.tsx frontend/src/components/cars/CarContactCard.test.tsx frontend/src/lib/api.ts
git commit -m "feat: add buyer contact experience"
```

---

### Task 7: Recompose the complete public car-detail page

**Files:**
- Modify: `frontend/src/pages/CarDetail.tsx`

**Interfaces:**
- Consumes: `CarImageGallery`, `VehicleHistoryPanel`, `CarContactCard`, and existing `getCar` query.
- Produces: final responsive `/car/:id` route.

- [ ] **Step 1: Replace the route layout with the approved hierarchy**

Keep fetching/loading/not-found behavior in `CarDetail.tsx`. Compose:

```tsx
<CarImageGallery images={car.images ?? []} title={vehicleTitle} />
<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
  <main className="space-y-5">
    <VehicleIdentity car={car} />
    <OverviewGrid car={car} />
    <DescriptionSection car={car} />
    <FeaturesSection features={car.features ?? []} />
    <RunningCosts car={car} />
    <VehicleHistoryPanel history={car.vehicleHistory} mode="public" />
    <BuyerGuidance />
  </main>
  <aside className="lg:sticky lg:top-24">
    <CarContactCard car={car} />
  </aside>
</div>
```

Implement the small presentational sections in the same route file because they are route-specific and stateless. Filter ordinary spec items whose values are empty, null, or zero; never filter verification items.

- [ ] **Step 2: Preserve mobile contact actions**

Render the fixed mobile action bar only for permitted actions, with the enquiry button always available. Ensure page bottom padding prevents the bar covering the final content.

- [ ] **Step 3: Run all frontend tests and type checking**

Run:

```bash
cd frontend
npm test
npx tsc --noEmit
```

Expected: all Vitest tests pass and TypeScript reports no diagnostics.

- [ ] **Step 4: Run lint and production build**

Run:

```bash
cd frontend
npm run lint
npm run build
```

Expected: no new lint errors attributable to changed files and Vite completes the production build. Existing unrelated lint findings, if any, must be reported separately with file paths.

- [ ] **Step 5: Commit the public detail page**

```bash
git add frontend/src/pages/CarDetail.tsx
git commit -m "feat: redesign vehicle detail page"
```

---

### Task 8: End-to-end verification and visual QA

**Files:**
- Modify only files from Tasks 1–7 if verification reveals a scoped defect.

**Interfaces:**
- Consumes: complete backend and frontend implementation.
- Produces: verified desktop/mobile behavior and final evidence.

- [ ] **Step 1: Run the complete automated verification suite**

Run:

```bash
cd backend/functions
npm test
cd ../../frontend
npm test
npx tsc --noEmit
npm run build
```

Expected: every command exits zero.

- [ ] **Step 2: Start the local frontend and inspect a populated listing**

Run: `cd frontend && npm run dev`

Open a known mock or published `/car/:id` route at desktop width. Verify gallery mosaic, title/price, overview, description, features, running costs, verified history, sticky contact card, and buyer guidance.

- [ ] **Step 3: Verify full-screen gallery interaction**

Open a supporting image, confirm the viewer begins at that image, navigate with buttons and keyboard arrows, wrap both ends, close with Escape, and confirm focus returns to the opener.

- [ ] **Step 4: Verify mobile behavior**

At a 390×844 viewport, confirm the single-column gallery, readable cards, touch-sized viewer controls, horizontally scrollable thumbnails, and unobscured fixed contact bar.

- [ ] **Step 5: Verify honest provider states**

Inspect one clear fixture, one recorded fixture, and one unavailable fixture. Confirm only explicit clear items are green and unavailable items say “Not supplied by provider.”

- [ ] **Step 6: Review the final diff for scope and privacy**

Run:

```bash
git diff --check
git status --short
rg -n "lookupRaw|UKVD_API_KEY|sellerPostcode|sellerGeo" frontend/src backend/functions/publicCar.js
```

Expected: no whitespace errors, no secrets in frontend code, and public sanitizer coverage for private fields.

- [ ] **Step 7: Commit any scoped verification corrections**

If verification required changes, stage only the files actually corrected. For example, when the corrections are limited to the provider mapper and detail route:

```bash
git add backend/functions/vehicleLookup.js frontend/src/pages/CarDetail.tsx
git commit -m "fix: polish verified car detail experience"
```

If no changes were required, do not create an empty commit.
