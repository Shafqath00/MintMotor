# Mint Motor shared dealer vehicle listing flow

## Goal

Give dealers the same trustworthy vehicle lookup, image-led listing experience, and vehicle-information presentation used by Mint Motor's private-seller journey, while keeping dealer-only stock private to the dealer network.

## Existing model to preserve

Private and dealer listings already use the same `cars` collection and vehicle schema. A dealer listing is distinguished by existing ownership and visibility fields:

- `ownerType` and `sellerType`: `dealer` rather than `private`
- `dealerId`: the approved dealer that owns the stock
- `visibility`: `dealer-network` rather than the public marketplace
- `dealerCarPrivate`: the separate dealer-only trade price and internal notes document

No new `carType` field or duplicate dealer vehicle API will be introduced. The listing context determines creation, access control, visibility, and dealer-only data.

## Shared vehicle-information flow

1. A dealer starts **Add vehicle** by entering a UK registration and mileage, using the existing authenticated `POST /vehicle-lookup` endpoint used by the normal Mint Motor seller flow.
2. The lookup response pre-fills the dealer draft with the returned make, model, year, variant, fuel, transmission, body style, engine and available vehicle history. The dealer can correct listing fields before publishing.
3. The dealer draft is created through the existing `POST /dealer/cars` endpoint. That endpoint remains responsible for applying dealer ownership and dealer-network visibility; the shared lookup response is only vehicle data.
4. At publish time, both `POST /cars/:id/publish` and `POST /dealer/cars/:id/publish` refresh the same vehicle lookup and pass it through the same history-selection rules. A temporary lookup failure must not discard an already verified history record; it follows the present private-listing fallback behaviour.
5. Dealer stock remains visible only to approved dealers through the existing dealer network endpoints. Public routes never receive `tradePrice`, `dealerNotes`, or dealer-network listings.

## Dealer UI

The dealer portal adopts the visual language of `find-car.tsx`, `Sellpages/CarDetails.tsx`, and `CarDetail.tsx` rather than introducing a separate generic admin form.

### Add vehicle

- The initial registration-and-mileage step mirrors Mint Motor's private seller lookup screen, with dealer-specific copy such as “Add dealer vehicle”.
- The completed editor is structured into clear cards for vehicle details, pricing, location/contact, description, and photos.
- Photo upload uses the same upload component and behaviours as the regular seller editor: preview grid, selected main image, safe removal, and upload progress/error states.
- Dealer-only fields are visually identified but kept modest: trade price and internal dealer notes are separated from the customer-facing listing details.

### Inventory and network detail

- Inventory and dealer-network cards become image-led and surface the make/model, registration/year, mileage, location, dealer-network status, asking price, and trade price where the viewer is entitled to see it.
- The dealer detail screen uses the existing vehicle-gallery treatment and a shared facts/overview presentation. It includes vehicle history when available, dealer-enquiry actions, and never exposes internal notes outside the owning dealer's inventory workflow.
- Responsive layout and empty/loading/error states follow the existing Mint Motor patterns so dealer stock feels part of the main product.

## Reuse boundaries

- Reuse the existing API endpoint, listing persistence, validation, image upload, and public gallery primitives.
- Extract small presentational vehicle primitives only where needed to prevent copied card/detail markup. Keep private seller subscription, contact, and publishing controls out of dealer components.
- Factor the publish-time lookup/history refresh into a backend helper used by both publish routes. The wrapper routes retain their own authorization, status, visibility, and response serializers.

## Security and data rules

- `/vehicle-lookup` remains authenticated; dealer tokens can use it under the existing authentication policy.
- Dealer create/update/publish routes continue to require the dealer role and approved dealer status.
- Trade price and notes stay in `dealerCarPrivate` and are fetched only for the owning dealer or authorized dealer-network views as already designed.
- The client must not set `ownerType`, `sellerType`, `dealerId`, or `visibility`; the backend continues to set them from the authenticated dealer context.

## Out of scope

- Changing public marketplace listing rules.
- Changing dealer approval, authentication, activation email, or the paused custom Firebase email-action page.
- Adding a second vehicle-data provider or duplicating the vehicle lookup endpoint.

## Validation approach

Per the current instruction, do not run automated tests. Implementation will be checked by focused source review and a manual dealer journey: lookup, prefilled draft, image upload, publish refresh, inventory view, and dealer-network detail.
