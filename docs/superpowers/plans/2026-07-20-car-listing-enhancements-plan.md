# MintMotor Car Listing Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix vehicle image cropping, add a full-size image viewer, make distance checking city-first, and implement seller/admin sold listings plus broader sell-form vehicle options.

**Architecture:** Keep listing status authoritative in the backend with a dedicated seller status endpoint and the existing admin patch endpoint. Reuse shared frontend types and option constants across cards, detail, search, and selling. Extract the image viewer into a focused component using existing dialog primitives.

**Tech Stack:** React 18, TypeScript, Vite, Tailwind CSS, Framer Motion, TanStack Query, Firebase Functions/Express, Firestore, Node `node:test`.

## Global Constraints

- Status values are exactly `draft`, `published`, and `sold`.
- Sold listings remain public and retain all public vehicle details.
- Sold listings have no call/enquiry actions; the enquiry API rejects them.
- Seller postcode/coordinates remain private.
- Seller transitions require ownership; admin transitions require admin authorization.
- Do not add a third-party model database or rebuild the entire search system.
- Preserve unrelated working-tree changes and stage only feature files.

---

### Task 1: Add shared status and vehicle options

**Files:**
- Modify: `frontend/src/lib/data.ts:1-67`
- Modify: `frontend/src/lib/api.ts:168-170,330-355`

**Interfaces:** Produces `ListingStatus`, `carColors`, `commonFeatures`, and `updateCarStatus(id, status, token)`.

- [ ] **Step 1: Extend the shared type and constants**

In `frontend/src/lib/data.ts`, add the following and change `Car.status` to `status?: ListingStatus`:

```ts
export type ListingStatus = "draft" | "published" | "sold";
export const carColors = ["Black", "Blue", "Brown", "Gold", "Green", "Grey", "Orange", "Purple", "Red", "Silver", "White", "Yellow", "Other"];
export const commonFeatures = ["Air conditioning", "Alloy wheels", "Apple CarPlay", "Android Auto", "Bluetooth", "Cruise control", "Heated seats", "Parking sensors", "Parking camera", "Electric windows", "Keyless entry", "LED headlights", "Panoramic roof", "Privacy glass", "Sat-nav", "Sunroof"];
```

Expand `carMakes` to a deduplicated, alphabetically sorted UK list including the current values plus Abarth, Alfa Romeo, Alpine, Austin, BYD, Cadillac, Citroën, CUPRA, Dacia, DS Automobiles, Fiat, Ford, Genesis, Hyundai, Kia, Mazda, MG, MINI, Mitsubishi, Nissan, OMODA, Peugeot, Polestar, Renault, SEAT, Skoda, Smart, Subaru, Suzuki, Vauxhall, Volvo, and XPENG.

- [ ] **Step 2: Add the seller status client function**

In `frontend/src/lib/api.ts`, import `ListingStatus` and add:

```ts
export function updateCarStatus(id: string, status: Extract<ListingStatus, "published" | "sold">, token: string) {
  return request<ApiCarResponse>(`/cars/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }, token);
}
```

Keep `AdminCarPayload` based on `Pick<Partial<Car>, "status" | "isFeatured">`.

- [ ] **Step 3: Verify and commit**

Run `npm run build` from `frontend`; expected: the baseline build passes. Commit only `data.ts` and `api.ts` with `feat: add listing status and vehicle options`.

### Task 2: Implement backend sold-state rules

**Files:**
- Modify: `backend/functions/validators.js:1-5,62-159,227-251`
- Modify: `backend/functions/index.js:575-755,879-912`
- Test: `backend/functions/validators.test.js`

**Interfaces:** `PATCH /cars/:id/status` accepts `{status: "published" | "sold"}` for the owner; admin patches accept `sold`; sold enquiry attempts return HTTP 409 with `This listing is sold and cannot receive enquiries.`.

- [ ] **Step 1: Write failing validator tests**

Using the existing `node:test` style, test that `validateListingPayload({status: "sold"}, {partial: true})` returns no errors and `listing.status === "sold"`; test that `status: "archived"` returns a status error; and test that `validateAdminCarPayload({status: "sold"})` returns no errors.

- [ ] **Step 2: Run the focused tests**

From `backend/functions`, run `npm test -- --test-name-pattern="status"`. Expected: the new tests fail because status is not yet normalized/accepted.

- [ ] **Step 3: Normalize and validate status**

Add `SOLD: "sold"` to `LISTING_STATUS`. Add `status: asString(payload.status).toLowerCase()` to `validateListingPayload`, validate supplied statuses against `Object.values(LISTING_STATUS)`, and emit `Listing status is not supported.` for invalid values. Extend `validateAdminCarPayload` to use the same enum.

- [ ] **Step 4: Add the seller transition route**

After `PATCH /cars/:id`, add `PATCH /cars/:id/status` with `requireAuth`. Return the existing 404/403 errors for missing/non-owned listings; accept only `published` and `sold`; allow `published -> sold` and `sold -> published`; reject `draft -> sold` with HTTP 400; persist status and `updatedAt`; return `serializeCar(updated)`.

- [ ] **Step 5: Reject sold enquiries**

In `POST /cars/:id/enquiries`, after loading the car and before validation/save, add:

```js
if (carSnapshot.data().status === LISTING_STATUS.SOLD) {
  res.status(409).json({ error: "This listing is sold and cannot receive enquiries." });
  return;
}
```

- [ ] **Step 6: Verify and commit**

Run `npm test` from `backend/functions`; expected: all existing and new tests pass. Commit `validators.js`, `index.js`, and `validators.test.js` with `feat: support sold listing status in the API`.

### Task 3: Add seller and admin sold controls

**Files:**
- Modify: `frontend/src/pages/MyListings.tsx:1-95,257-363,461-474`
- Modify: `frontend/src/pages/Sellpages/CarDetails.tsx:1-18,57-72,214-245,565-700`
- Modify: `frontend/src/pages/AdminDashboard.tsx:28-66,246-266,404-473,648-660`

- [ ] **Step 1: Add seller mutation and row actions**

In `MyListings.tsx`, add a mutation calling `updateCarStatus`, invalidate `me/listings` and `car` queries on success, and display errors. In `ListingRow`, derive `isSold`/`isPublished`, render the actual status badge, and add a confirmed `Mark sold`/`Mark available` button. Keep edit/view links available.

- [ ] **Step 2: Add the edit-page status panel**

In `Sellpages/CarDetails.tsx`, for an existing listing, read `carQuery.data?.car.status`, add the same mutation, and render `Mark as sold` for published cars or `Mark as available` for sold cars. Confirm before the request, invalidate `car` and `me/listings` on success, and do not offer sold for drafts.

- [ ] **Step 3: Extend admin filters/actions**

Add `{value: "sold", label: "Sold"}` to `statusFilters`. Change the listing table callback type to `draft | published | sold`, add sold styling to `StatusBadge`, and use transitions `sold -> published`, `published -> sold`, and `draft -> published`. Confirm sold transitions before calling `updateAdminCar`.

- [ ] **Step 4: Verify and commit**

Run `npm run build` from `frontend`; expected: compilation passes. Commit the three page files with `feat: add seller and admin sold controls`.

### Task 4: Add the full-size image viewer and fix cropping

**Files:**
- Create: `frontend/src/components/cars/VehicleImageLightbox.tsx`
- Modify: `frontend/src/pages/CarDetail.tsx:1-3,20-25,104-108,212-257`

**Interface:** `VehicleImageLightboxProps` contains `images`, `initialIndex`, `title`, `open`, `onOpenChange`, and `onIndexChange`.

- [ ] **Step 1: Create the lightbox**

Use existing `Dialog`, `DialogContent`, and `DialogTitle`. Render the selected image with `object-contain` and mobile-safe max dimensions; add counter, close, previous/next, and thumbnail buttons. Wrap navigation and label every control. Use Escape to close.

- [ ] **Step 2: Fix the main gallery**

Add `isLightboxOpen` state. Keep the aspect-ratio frame but change the main image to `h-full w-full object-contain` on a neutral background. Wrap it in a focusable button with an accessible open label and set the lightbox open on click.

- [ ] **Step 3: Synchronize indices**

Render the component with `images={images}`, `initialIndex={currentImageIndex}`, the car title, `open={isLightboxOpen}`, `onOpenChange={setIsLightboxOpen}`, and `onIndexChange={setCurrentImageIndex}`. Lightbox arrows/thumbnails must update the parent index.

- [ ] **Step 4: Verify and commit**

Run `npm run build` from `frontend`; expected: no TypeScript errors. Commit the new component and `CarDetail.tsx` with `feat: add full-size vehicle image viewer`.

### Task 5: Update public sold presentation and city-first distance

**Files:**
- Modify: `frontend/src/components/cars/CarCard.tsx:30-63`
- Modify: `frontend/src/pages/CarDetail.tsx:164-200,312-472`

- [ ] **Step 1: Add sold badges**

Render `Sold` beside `New`/`Featured` in `CarCard` and in the detail title group. Keep all public photos, specs, description, features, price, and location visible.

- [ ] **Step 2: Replace sold contact actions**

Derive `const isSold = car.status === "sold"`. In the desktop seller card and mobile sticky bar, replace phone/email/enquiry actions with a `role="status"` notice reading `This car has been sold and is no longer accepting enquiries.` Do not render the enquiry trigger for sold cars.

- [ ] **Step 3: Make distance city-first**

Before the postcode form, render `Seller location: {car.location || "Location not listed"}`. Change the input copy to `Enter your postcode to check the distance`; preserve lookup, normalization, result miles, and private coordinates.

- [ ] **Step 4: Verify and commit**

Run `npm run build` from `frontend`; expected: build passes. Commit `CarCard.tsx` and `CarDetail.tsx` with `feat: show sold listings and seller location`.

### Task 6: Expand structured sell-form options

**Files:**
- Modify: `frontend/src/pages/Sellpages/CarDetails.tsx:1-55,64-72,176-212,476-562`
- Modify: `frontend/src/lib/data.ts:55-67`

- [ ] **Step 1: Add selection state**

Import `carColors` and `commonFeatures`. Add `selectedFeatures: string[]` and `customColor: string`. When loading an existing car, split known common features from custom features and initialize standard/custom colour state.

- [ ] **Step 2: Preserve the payload shape**

Build `features` as `Array.from(new Set([...selectedFeatures, ...customFeatures]))`, where `customFeatures` is the trimmed comma-separated input. Set `color` to the selected colour or trimmed custom colour when the selection is `Other`. Keep all existing numeric conversions and lookup fields.

- [ ] **Step 3: Render colour and feature controls**

Use the existing `Select` with `carColors`; show a custom colour input for `Other`. Render `commonFeatures` as accessible checkbox buttons and retain the comma-separated input labeled `Additional features`.

- [ ] **Step 4: Verify and commit**

Run `npm run build` from `frontend`; expected: the form and vehicle lookup compile. Commit `CarDetails.tsx` and `data.ts` with `feat: expand vehicle selling options`.

### Task 7: Complete verification and browser smoke test

**Files:** Test `backend/functions/validators.test.js` and `backend/functions/vehicleLookup.test.js`; no new file required.

- [ ] **Step 1: Run backend tests**

From `backend/functions`, run `npm test`; expected: all tests pass.

- [ ] **Step 2: Run frontend checks**

From `frontend`, run `npm run lint` and `npm run build`; expected: no new lint errors and a successful Vite build.

- [ ] **Step 3: Smoke-test the flows**

Run `npm run dev` from `frontend`. Verify: full photo visible; lightbox arrows/thumbnails/Escape work; city appears before postcode input; sold cards/details show every detail but no contact actions; seller/admin transitions work; expanded make/colour/features options work; existing vehicle lookup still populates the form.

- [ ] **Step 4: Review the final diff**

Run `git status --short` and inspect only feature files. Do not stage unrelated existing changes. If a feature-only defect is found, fix it, rerun the affected check, and commit only the relevant feature files.
