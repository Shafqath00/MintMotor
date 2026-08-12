# MintMotor Admin User Profile Design

## Purpose

Give MintMotor administrators one complete, live view of a marketplace user, including their account record, vehicle portfolio, and buyer enquiries. The detail page makes it possible to inspect a seller’s activity without manually cross-referencing the Users, Listings, and Enquiries tables.

## Scope

This work adds a dedicated admin-only user profile route. It covers:

- selecting a user from the existing Admin Dashboard Users tab;
- loading the selected user, all listings owned by that user, and enquiries addressed to that user from a protected backend endpoint;
- displaying account details, operational summary metrics, vehicles, and leads on a responsive full-page profile;
- preserving the existing role-management capability on the profile; and
- usable loading, empty, forbidden, and failed-request states.

It does not add user deletion, account suspension, lead assignment, pagination, or new user data fields.

## API and Data Model

Add `GET /admin/users/:uid` behind the existing `requireAdmin` middleware. The endpoint will return:

```ts
interface AdminUserDetailResponse {
  user: AdminUser;
  summary: {
    totalCars: number;
    publishedCars: number;
    draftCars: number;
    soldCars: number;
    totalEnquiries: number;
    openEnquiries: number;
  };
  cars: Car[];
  enquiries: AdminEnquiry[];
}
```

The backend will load the Firestore user document and return `404` when it does not exist. It will select cars by `ownerId === uid` and enquiries by `sellerId === uid`, serialize them through the existing serializers, and sort cars by last activity and enquiries by latest creation time. Counts are calculated from these returned records.

The frontend API module will expose the same response type and a `getAdminUserDetail(uid, token)` request helper. Local admin mode will return a consistent detail response using the existing local users, mock vehicles, and local enquiries so the profile can be demonstrated without Firebase.

## User Interface

The existing user table keeps its search and role controls. Each row gains a clear **View profile** action and clicking the identity cell opens `/admin/users/:uid`.

The new page uses MintMotor’s existing white, charcoal, neutral, and `#d72d2d` operational styling. Its signature element is a compact vehicle-portfolio strip at the top: account identity and live operational counts read as one seller dossier rather than an unrelated analytics dashboard.

Desktop layout:

```text
Back to users                                      Refresh

User identity and role       Listings | Published | Drafts | Leads | Open leads

Profile details              Vehicle portfolio
Contact and account dates    table: image, vehicle, price, status, updated

Buyer lead history
table: buyer, vehicle, contact, message, status, received
```

On smaller screens, the summary metrics wrap and both tables retain their data through horizontal scrolling or stacked readable cells. All profile data remains linked to the live admin query rather than copied into navigation state.

## Interactions and States

- A back action returns to `/admin` with the Users tab active.
- Refresh invalidates the individual user-detail query and the parent admin queries.
- Changing a role uses the existing `PATCH /admin/users/:uid` update, then refreshes user detail and dashboard user/summary data.
- Vehicle rows link to the public listing page in a new ordinary route flow; they do not mutate a listing from this page.
- Lead status is shown from live data. Existing lead status management remains in the dashboard Enquiries tab, avoiding duplicate write controls.
- An unavailable profile shows a direct retry action; a missing user shows a clear not-found state and a route back to Users.

## Testing and Verification

Backend tests will prove that the detail endpoint returns only the selected seller’s cars and enquiries, calculates counts correctly, and returns `404` for an absent user. Frontend API tests will prove the route and local-admin response shape. Existing frontend type checking and a production build will validate the profile page integration.

## Acceptance Criteria

- Selecting a user in Admin Dashboard opens `/admin/users/:uid`.
- The page shows the selected user’s live account details, vehicle list, buyer leads, and calculated activity counts.
- Data from other users is never included in the selected profile response.
- A missing profile, access error, and loading state are understandable and actionable.
- Role updates continue to work and the displayed profile updates after success.
- The page is responsive and production frontend build plus relevant backend tests pass.
