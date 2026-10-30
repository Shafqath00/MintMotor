# Shared Dealer Vehicle Listing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let approved dealers look up, add, publish, browse, and enquire about vehicles through the same trustworthy vehicle-data pipeline and Mint Motor presentation language as private listings.

**Architecture:** Dealer and private listings continue to share the `cars` collection and vehicle schema. A small backend publish helper will refresh vehicle history for both contexts; the dealer route keeps dealer authorization and visibility rules. The dealer frontend adds a lookup gate ahead of its existing draft/publish workflow, then renders inventory and network details with the shared gallery and a reusable vehicle facts grid.

**Tech Stack:** React, TypeScript, React Router, Firebase Auth/Storage, Tailwind/shadcn UI, Express, Firebase Admin/Firestore, UK Vehicle Data lookup.

**Spec:** `docs/superpowers/specs/2026-09-25-shared-dealer-vehicle-listing-design.md`

## Global Constraints

- Keep a single `cars` collection and existing dealer discriminator fields; do not add `carType` or a duplicate lookup endpoint.
- Use authenticated `POST /vehicle-lookup` for dealer registration-and-mileage lookup.
- The backend, not the client, sets `ownerType`, `sellerType`, `dealerId`, and `visibility`.
- Keep `tradePrice` and `dealerNotes` in `dealerCarPrivate`; never expose dealer notes in dealer-network or public views.
- Dealer vehicles must remain `dealer-network` visible and require an approved dealer.
- Do not run automated tests, test commands, or builds for this work. Use focused source review and the manual journey described in this plan instead.
- Leave the custom Firebase email-action handler work paused and untouched.

## Review Focus

- A dealer lookup with a valid registration but no returned optional data still opens a usable, editable dealer draft.
- A lookup failure leaves the dealer on the lookup step with a useful error and does not create a partial car record.
- Uploading dealer photos persists browser-renderable download URLs, not Firebase Storage paths that the gallery cannot display.
- A dealer publish refresh failure preserves any previous verified vehicle history and still follows the existing private-listing fallback.
- A network viewer can see trade price and vehicle details but cannot receive the seller's internal dealer notes.

---

### Task 1: Share publish-time vehicle verification and correct dealer image URLs

**Files:**
- Create: `backend/functions/vehiclePublish.js`
- Modify: `backend/functions/index.js:891-959,1070-1078`
- Modify: `frontend/src/lib/api.ts:633-640`

**Interfaces:**
- Consumes: `lookupVehicle({ registrationNumber, mileage })`, `selectVehicleHistoryForPublish({ lookup, currentHistory, currentHistoryVerified, registrationNumber })`, and a persisted car record.
- Produces: `refreshVehicleDataForPublish(car): Promise<{ vehicleHistory: object | undefined, vehicleHistoryVerified: boolean }>`; both publish routes merge its result before setting their own status.
- Produces: `uploadDealerListingImages(dealerId, carId, files): Promise<string[]>` containing Storage download URLs in the selected main-photo-first order.

- [ ] **Step 1: Add the shared publish helper**

Create `backend/functions/vehiclePublish.js` so the current private publish lookup fallback is performed once:

```js
async function refreshVehicleDataForPublish({ car, lookupVehicle, selectVehicleHistoryForPublish, logger }) {
  let lookup = { lookupProvider: "unavailable" };
  try {
    lookup = await lookupVehicle({ registrationNumber: car.registrationNumber, mileage: car.mileage });
  } catch (error) {
    lookup = { lookupProvider: error?.statusCode === 404 ? "not-found" : "unavailable" };
    logger.warn("Unable to refresh vehicle history before publishing", error);
  }
  return selectVehicleHistoryForPublish({
    lookup,
    currentHistory: car.vehicleHistory,
    currentHistoryVerified: car.vehicleHistoryVerified === true,
    registrationNumber: car.registrationNumber,
  });
}

module.exports = { refreshVehicleDataForPublish };
```

- [ ] **Step 2: Apply the helper to both publish routes**

In `backend/functions/index.js`, import `refreshVehicleDataForPublish`. Replace the duplicate private-route inline lookup/history block with the helper. In `/dealer/cars/:id/publish`, call it after `validatePublishListing(record.car)` and merge the returned `vehicleHistory` and `vehicleHistoryVerified` alongside `DEALER_LISTING_STATUS.ACTIVE`. Preserve each route's existing ownership checks, serializers, status values, timestamps, location logic, and response shape.

- [ ] **Step 3: Store gallery-ready dealer image URLs**

In `frontend/src/lib/api.ts`, change the dealer upload return value from `imageRef.fullPath` to `await getDownloadURL(imageRef)`, matching `uploadListingImages`. Keep the path `dealers/${dealerId}/cars/${carId}/...`, content type, file-name sanitisation, ordering, and `Promise.all` intact.

- [ ] **Step 4: Perform focused source review**

Check that both publish routes call `refreshVehicleDataForPublish`, that their private/dealer response serializers remain unchanged, and that dealer image results are strings suitable for `<img src>`. Do not run tests, builds, or deploy commands.

- [ ] **Step 5: Commit the backend and upload-pipeline change**

```bash
git add backend/functions/vehiclePublish.js backend/functions/index.js frontend/src/lib/api.ts
git commit -m "feat: share dealer vehicle publishing pipeline"
```

### Task 2: Add a shared-API dealer registration lookup and refined listing editor

**Files:**
- Modify: `frontend/src/pages/dealer/DealerPortal.tsx:1-170`
- Reuse: `frontend/src/lib/api.ts:405-410`, `frontend/src/components/ImagesUploads.tsx`

**Interfaces:**
- Consumes: `lookupVehicle({ registrationNumber, mileage }, token): Promise<{ vehicle: Partial<Car> }>`, `createDealerCar(payload, token)`, `uploadDealerListingImages(dealerId, carId, files)`, `updateDealerCar(carId, payload, token)`, `publishDealerCar(carId, token)`.
- Produces: A dealer-only add-vehicle route that creates one dealer draft only after a successful lookup and publishes it with images ordered by the chosen main image.

- [ ] **Step 1: Add lookup-stage state and normalize inputs**

In `DealerListingForm`, add `step: "lookup" | "details"`, `lookupRegistration`, `lookupMileage`, `lookupError`, and `lookupBusy`. Normalize the registration before lookup and require a non-negative mileage. Keep the dealer authentication token as the second `lookupVehicle` argument.

```ts
const result = await lookupVehicle(
  { registrationNumber: lookupRegistration.trim(), mileage: Number(lookupMileage) },
  token,
);
setForm((current) => ({
  ...current,
  ...result.vehicle,
  registrationNumber: result.vehicle.registrationNumber || lookupRegistration.trim().toUpperCase(),
  mileage: String(result.vehicle.mileage ?? lookupMileage),
  year: String(result.vehicle.year ?? ""),
}));
setStep("details");
```

- [ ] **Step 2: Build the Mint Motor dealer lookup screen**

Render the `lookup` step as a narrow, high-confidence Mint Motor screen: dealer-network eyebrow, “Add a dealer vehicle” title, registration and mileage fields, a single “Find vehicle” primary action, clear privacy copy, and an inline error panel. Do not call `createDealerCar` until lookup succeeds. Include a visible return link to `/dealer/dashboard`.

- [ ] **Step 3: Reshape the details editor into grouped cards**

Render the `details` step with compact section cards rather than one long generic form:

```text
Vehicle confirmed     registration, make/model/variant, year, mileage, fuel, gearbox, body, engine, colour
Pricing and visibility asking price, dealer-only trade price, dealer-only notes
Listing details       location, postcode, contact, description, features if supplied
Photos                ImagesUploads, main-photo selection, removal, limits and upload guidance
```

Use the existing `ImagesUploads` component so the first selected image remains the main image. Keep its existing `maxFiles={20}` and publish disabled until a token, lookup-confirmed details, and at least one image exist. Preserve the existing dealer-only API calls and status message; add a secondary “Start over” action that clears only unsaved local state.

- [ ] **Step 4: Keep the draft/publish payload safe and complete**

When submitting, spread only editable vehicle fields and dealer-private fields into `createDealerCar`; do not pass ownership, visibility, or status fields from React. Upload using `user.uid`, update the draft with the returned download URLs, then publish. On any failed step, retain the filled form and photos, set a readable error, and do not display a false success message.

- [ ] **Step 5: Perform focused source review**

Inspect that the dealer flow calls the same `lookupVehicle` API as `find-car.tsx`, cannot create a draft before lookup, keeps all four server-controlled fields absent from the payload, and retains the ordered photo array. Do not run tests, builds, or deploy commands.

- [ ] **Step 6: Commit the dealer add-vehicle flow**

```bash
git add frontend/src/pages/dealer/DealerPortal.tsx
git commit -m "feat: add dealer vehicle lookup flow"
```

### Task 3: Introduce reusable vehicle facts and image-led dealer inventory views

**Files:**
- Create: `frontend/src/components/cars/VehicleFactsGrid.tsx`
- Modify: `frontend/src/pages/CarDetail.tsx:199-237,473`
- Modify: `frontend/src/pages/dealer/DealerPortal.tsx:14-71,172-306`
- Reuse: `frontend/src/components/cars/CarImageGallery.tsx`

**Interfaces:**
- Consumes: `Car` with optional `registrationNumber`, `mileage`, `fuelType`, `bodyType`, `engineSize`, `transmission`, `doors`, `seats`, `color`, and `year`.
- Produces: `VehicleFactsGrid({ car }: { car: Car })`, a display-only `<dl>` that omits missing values and contains no contact, pricing, ownership, or dealer-private data.
- Produces: Dealer inventory and marketplace cards that link to `/dealer/marketplace/:id` and image-led dealer detail that uses `CarImageGallery`.

- [ ] **Step 1: Extract the public overview facts into a neutral component**

Create `VehicleFactsGrid.tsx` by moving the display-only value list and `<dl>` from `CarDetail`'s `Overview`. Keep labels and existing Mint Motor icon treatment. Export the grid without wrapping it in a panel so each consumer owns its own heading/card.

```tsx
export function VehicleFactsGrid({ car }: { car: Car }) {
  const facts = getVehicleFacts(car);
  return <dl className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3">{/* facts */}</dl>;
}
```

Update `CarDetail` to retain its `Panel title="Vehicle overview"` wrapper and render `<VehicleFactsGrid car={car} />`, preserving the public page output.

- [ ] **Step 2: Make dealer inventory and network cards image-led**

In `DealerDashboard` and `DealerMarketplace`, render the first image in a fixed-ratio media area with an accessible fallback when no image exists. Surface title, registration/year, mileage, location, listing status, asking price, and entitled trade price. Keep dealer marketplace cards linking to the existing detail route and make owner inventory clearly distinguish drafts from live dealer-network stock.

- [ ] **Step 3: Rebuild dealer network detail around gallery, facts, and enquiry**

In `DealerMarketplaceDetail`, place `CarImageGallery` above the detail grid, show the trade price as a dealer-only label, add a “Vehicle overview” card containing `VehicleFactsGrid`, then retain description and the existing enquiry form. Import the existing `VehicleHistoryPanel` from `@/components/cars/VehicleHistoryPanel` and render `<VehicleHistoryPanel history={car.vehicleHistory} mode="public" />` after the overview. Do not render `dealerNotes` anywhere in the network detail.

- [ ] **Step 4: Perform focused source review**

Confirm public `CarDetail` retains its overview, the dealer gallery receives only `car.images`, dealer cards handle an empty image list, and network detail does not include `dealerNotes`. Do not run tests, builds, or deploy commands.

- [ ] **Step 5: Commit the shared presentation and dealer inventory work**

```bash
git add frontend/src/components/cars/VehicleFactsGrid.tsx frontend/src/pages/CarDetail.tsx frontend/src/pages/dealer/DealerPortal.tsx
git commit -m "feat: align dealer inventory with vehicle details"
```

### Task 4: Manual dealer journey and production release

**Files:**
- Review: `backend/functions/vehiclePublish.js`, `backend/functions/index.js`, `frontend/src/lib/api.ts`, `frontend/src/pages/dealer/DealerPortal.tsx`, `frontend/src/components/cars/VehicleFactsGrid.tsx`, `frontend/src/pages/CarDetail.tsx`
- Deployment configuration: existing Firebase Functions and Hosting configuration only; do not alter the paused auth-action configuration.

**Interfaces:**
- Consumes: an approved dealer account, a real registration/mileage pair accepted by the existing provider, and at least one image.
- Produces: a manually verified dealer listing in the dealer network without exposing private notes.

- [ ] **Step 1: Review the final diff for scope**

Use `git diff --check` and inspect the staged/working diff. Confirm changes are limited to shared dealer/private publish history, dealer image URLs, dealer portal UI, and the reusable vehicle facts component. Do not run automated tests or a build.

- [ ] **Step 2: Manually exercise the browser journey after deployment**

As an approved dealer, visit `/dealer/inventory/new`, enter registration and mileage, confirm lookup-prefilled values, add/reorder a photo, publish, and check the item appears as an image-led active card. Open it in `/dealer/marketplace/:id`, verify the gallery/facts/trade price are visible to a dealer, and verify no internal dealer notes are displayed.

- [ ] **Step 3: Manually check failure states**

Try an invalid or unknown registration and verify no dealer draft is created. Repeat a publish while the lookup provider is unavailable only if a safe non-production environment is available; otherwise inspect the helper path rather than forcing an outage. Confirm a failed image upload or publish leaves the form populated and displays an error.

- [ ] **Step 4: Deploy only after manual scope approval**

Deploy the frontend Hosting and Functions using the repository’s existing release commands. Do not change Firebase Auth email templates or deploy the paused `/auth/action` work as part of this release.

- [ ] **Step 5: Record release outcome**

Report the deployed endpoints, the manual checks performed, any remaining provider-dependent limitation, and explicitly state that no automated tests or builds were run per instruction.
