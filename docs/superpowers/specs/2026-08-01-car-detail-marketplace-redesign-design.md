# Car detail marketplace redesign

## Goal

Reshape the public MintMotor vehicle-detail page into a compact, confidence-led marketplace experience inspired by the information hierarchy of the supplied Auto Trader reference while preserving MintMotor branding and using only existing listing data.

## Scope

- Redesign `frontend/src/pages/CarDetail.tsx` and the presentation of its existing detail sections.
- Restyle `CarContactCard` only where needed to make the seller card visually consistent with the redesigned page.
- Keep `CarImageGallery` unchanged in code, behaviour, and presentation.
- Keep existing save, share, mobile contact, enquiry, distance, loading, error, and missing-vehicle behaviours.
- Do not add a more-vehicles-from-this-seller section.
- Do not add new backend fields, APIs, or invented vehicle facts.

## Visual direction

The page uses a soft neutral canvas (`#F5F5F3`) with white cards, subtle `#E5E5E5` borders, 14–16px corner radii, and restrained shadows only where hierarchy needs reinforcement. MintMotor blue (`#0000A3`) remains the action and focus colour; verified or clear history uses `#15803D`. Existing project typography remains in place: the display face is reserved for the vehicle title and asking price, while the body face handles dense facts and guidance.

The signature element is a compact vehicle-confidence summary derived only from supplied mileage, service-history, MOT, and vehicle-history data. It is informative rather than promotional and omits any fact that is unavailable.

## Layout

The existing gallery remains immediately below the breadcrumb/action row. Below it, desktop uses a wide content column and a 360px sticky seller column. Mobile collapses to one column and retains the existing fixed contact bar.

```text
[ Back to search                           Save  Share ]
[ Existing CarImageGallery — unchanged                 ]

[ Vehicle title, price, location, confidence ] [ Seller contact ]
[ Overview facts                            ] [ Sticky desktop ]
[ Description                               ]
[ Running costs                             ]
[ Vehicle history                           ]
[ Features                                  ]
[ Before you buy                            ]
```

## Information architecture

### Vehicle summary

The first card leads with year, make, model, and variant. Asking price is prominent but secondary to identification. Location and available confidence signals sit below in a compact row. Attention-grabber copy appears only when supplied.

### Overview

Vehicle facts use a compact responsive grid with small icons and plain labels. Registration, mileage, fuel type, transmission, body type, engine, colour, doors, seats, owners, keys, manufacture year, and first-registration date continue to be omitted when unavailable under the existing display rules.

### Description and features

Description remains readable long-form content, split into supplied paragraphs. Features remain a scannable two-column list using only the listing’s feature array.

### Running costs and history

Running-cost facts remain conditional and use the existing CO2, insurance, consumption, MOT, and service-history fields. `VehicleHistoryPanel` retains its existing data contract and public mode, with surrounding spacing aligned to the redesigned cards.

### Seller contact

The desktop contact area remains sticky and contains the asking-price summary plus `CarContactCard`. The card’s seller identity, permitted call/email actions, enquiry form, and distance checker remain functional. Styling becomes denser and visually aligned with the page cards. Contact data continues to respect `showPhone`, `showEmail`, and `allowEnquiries`.

## Responsive and accessibility requirements

- Preserve semantic headings, definition lists, form labels, status announcements, and keyboard focus behaviour.
- Keep touch targets at least 44px high.
- Preserve the mobile fixed contact bar and safe-area padding.
- Ensure cards collapse without horizontal scrolling at small widths.
- Keep text and controls at accessible contrast against the neutral canvas.
- Any transition must respect reduced-motion preferences; no decorative page-wide animation is required.

## Data flow and error handling

`CarDetail` continues to load one vehicle with `getCar(id, token)`. All presentation derives from the returned `Car`; no additional query is introduced. Loading, retry, missing-vehicle, saved-listing storage failure, share failure, contact validation, enquiry failure, and distance failure retain their current user-facing handling.

## Testing

- Existing loading, retry, missing-vehicle, save/share, contact-permission, mobile-contact, and fact-omission tests remain green.
- Add assertions for the redesigned summary hierarchy and confidence signals.
- Confirm `CarImageGallery` remains a shared mocked boundary in page tests and is not modified.
- Run the focused `CarDetail` tests and a production build.

## Non-goals

- No Auto Trader branding, copied text, proprietary scoring, insurance quote integration, expert reviews, finance products, tax calculations, or seller inventory carousel.
- No changes to `CarImageGallery`.
- No backend or data-model changes.
