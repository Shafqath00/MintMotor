# Seller enquiry toggle and van body type

## Goal

Let sellers choose whether buyers can contact them through MintMotor, while adding Van to the shared body-type selector. The buyer-facing enquiry card should retain its current visual design and remain enabled by default for backwards compatibility.

## Scope

- Add `Van` to the shared `bodyTypes` options.
- Add an `allowEnquiries` boolean to seller listing state and payloads.
- Default `allowEnquiries` to `true` for new listings and legacy listings without the field.
- Add an accessible toggle in the existing seller contact panel.
- Persist and expose the setting through the backend/public listing mapping.
- Render the existing buyer enquiry section only when `allowEnquiries` is enabled.

## Design

The seller control belongs beside the existing phone and email visibility toggles in Step 5. Its label will be “Allow buyers to contact me through MintMotor”, with supporting copy explaining that disabling it removes the in-app enquiry form from the public listing. It will use the existing `ToggleCheck` component and styling so it reads as a privacy/contact preference rather than a new workflow.

The public `CarContactCard` will keep the seller identity and optional direct-contact buttons unchanged. Only the `Send an enquiry` section will be conditionally rendered from `car.allowEnquiries !== false`, preserving the current behavior for old data and for listings that omit the property.

## Data flow

`CarDetails` form state → `ListingPayload` → backend listing sanitizer/validator → stored car → public car projection → `CarContactCard`.

The field is optional at the API boundary for backwards compatibility, but normalized to a boolean when present. Existing validation rules for contact details and enquiry submission remain unchanged.

## Testing

- Assert the shared body-type list contains Van.
- Assert the seller form exposes the enquiry toggle and includes its value in the save payload through the existing form behavior where practical.
- Assert the buyer card renders the enquiry heading by default and when `allowEnquiries` is true.
- Assert the buyer card omits the enquiry section when `allowEnquiries` is false.
- Run the focused frontend and backend tests, then the frontend build/type checks.

## Non-goals

- No redesign of the attached enquiry card.
- No changes to direct phone/email visibility.
- No new enquiry delivery channel or moderation workflow.
