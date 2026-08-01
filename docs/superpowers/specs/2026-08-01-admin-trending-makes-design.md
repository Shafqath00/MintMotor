# Admin-Managed Trending Makes

## Goal

Allow an administrator to choose the ordered car makes shown in the homepage “Trending cars” section, instead of always displaying the most recently added new-car listings.

## Scope

- Add a platform-settings document for an ordered list of up to four trending makes.
- Provide a public read endpoint so the homepage can retrieve that list.
- Provide an admin-only update endpoint that validates and persists the list.
- Add an Admin Dashboard panel with make selection, ordering, and save feedback.
- Use the saved makes to filter published new-car listings in the homepage section.
- Preserve the existing static fallback cards when no matching live listing is available.

## Design

The setting is separate from `Car.isFeatured`. Featured remains a per-listing editorial flag; trending makes is an ordered, platform-wide merchandising choice.

The backend stores a single `platformSettings/homepage` Firestore document:

```json
{ "trendingMakes": ["BMW", "Audi", "Mercedes-Benz", "Tesla"] }
```

The public endpoint returns an empty list when the document does not exist, allowing existing installations to keep the current newest-new-cars behavior. The admin endpoint accepts an array of one to four trimmed, distinct make names; the backend normalizes duplicate comparison case-insensitively and rejects invalid input.

The admin panel uses four compact select controls sourced from currently known listing makes. It allows a blank slot, prevents duplicate choices in the UI, retains the selected order, and saves with the administrator’s existing token. The panel belongs near listing-management controls, not inside the per-listing table.

The homepage first fetches the setting and its new-car query. When saved makes exist, it keeps only matching published new-car listings and orders them by the selected makes, then by the existing listing order. When no makes are saved, it retains current behavior. It shows up to four live cards and keeps the current static placeholder cards for any empty state.

## Data Flow

Admin Dashboard -> `PUT /admin/platform-settings/homepage` -> Firestore `platformSettings/homepage` -> `GET /platform-settings/homepage` -> homepage trending-cars query/filter/order -> cards.

## Error Handling

- Non-admin write attempts receive the existing admin authorization response.
- Invalid arrays, more than four entries, blanks within submitted entries, or duplicate makes receive `400` with clear validation errors.
- A homepage settings-read failure does not block the section; it falls back to the existing newest-new-cars behavior.
- Save failures show the existing dashboard mutation-error style and leave the administrator’s chosen values intact for retry.

## Testing

- Backend tests cover defaults, validation, ordering preservation, and authorization through the existing route pattern where practical.
- Frontend tests cover the admin form’s save payload, loading/success/error feedback, and homepage filtering/ordering with saved makes and its fallback behavior.
- Run focused frontend tests, the backend test suite, and the frontend production build.

## Non-goals

- No automatic popularity calculation, analytics ranking, or scheduled refresh.
- No changes to the existing Featured listing flag.
- No new homepage layout or visual redesign.