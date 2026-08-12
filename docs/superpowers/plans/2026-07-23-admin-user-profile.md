# MintMotor Admin User Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a protected, live, full-page admin profile for every MintMotor user, showing account details, owned listings, and buyer enquiries.

**Architecture:** A protected backend endpoint assembles one user's serialized account record, vehicle portfolio, and leads. The frontend exposes the response through its API module and renders it in a route-level React Query page; the existing Users table links to it.

**Tech Stack:** Firebase Admin/Firestore, Express 5, Node test runner, React 18, React Router 6, TanStack React Query, TypeScript, Tailwind CSS, Lucide.

## Global Constraints

- Keep `GET /admin/users/:uid` behind the existing `requireAdmin` middleware.
- Return only records where `car.ownerId` and `enquiry.sellerId` exactly match the requested `uid`.
- Reuse existing serializers, formatters, and dashboard status styling.
- Do not add dependencies, deletion/suspension actions, lead assignment, or pagination.
- Local-admin mode must return the same detail response shape.

---

## File Structure

- `backend/functions/adminUserDetail.js` — pure filter, sort, and summary-count helper.
- `backend/functions/adminUserDetail.test.js` — Node tests for isolation, ordering, and counts.
- `backend/functions/index.js` — protected detail route.
- `frontend/src/lib/api.ts` — shared response types and live/local request function.
- `frontend/src/pages/AdminUserProfile.tsx` — protected responsive profile page.
- `frontend/src/pages/AdminDashboard.tsx` — profile navigation from the Users tab.
- `frontend/src/App.tsx` — specific user-profile route.

### Task 1: Build and test the backend detail helper

**Files:**
- Create: `backend/functions/adminUserDetail.js`
- Test: `backend/functions/adminUserDetail.test.js`

**Interfaces:**
- Produces: `buildAdminUserDetail({ user, cars, enquiries })`
- Returns: `{ user, cars, enquiries, summary }`, where `summary` is `{ totalCars, publishedCars, draftCars, soldCars, totalEnquiries, openEnquiries }`.

- [ ] **Step 1: Write the failing isolation/count test**

```js
test("returns only the selected seller's records and correct counts", () => {
  const result = buildAdminUserDetail({ user, cars, enquiries });
  assert.deepEqual(result.cars.map((car) => car.id), ["car-new", "car-old"]);
  assert.deepEqual(result.enquiries.map((lead) => lead.id), ["lead-new", "lead-old"]);
  assert.deepEqual(result.summary, {
    totalCars: 2, publishedCars: 1, draftCars: 0, soldCars: 1,
    totalEnquiries: 2, openEnquiries: 1,
  });
});
```

Use fixtures with another seller's car and lead to prove isolation, and dates that prove descending activity order.

- [ ] **Step 2: Verify RED**

Run: `npm test -- adminUserDetail.test.js` from `backend/functions`

Expected: FAIL because `adminUserDetail.js` does not exist.

- [ ] **Step 3: Write the minimal helper**

```js
function buildAdminUserDetail({ user, cars, enquiries }) {
  const userCars = cars.filter((car) => car.ownerId === user.uid)
    .sort((a, b) => toMillis(b.updatedAt || b.createdAt) - toMillis(a.updatedAt || a.createdAt));
  const userEnquiries = enquiries.filter((lead) => lead.sellerId === user.uid)
    .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
  return { user, cars: userCars, enquiries: userEnquiries, summary: countUserActivity(userCars, userEnquiries) };
}
module.exports = { buildAdminUserDetail };
```

Implement local `toMillis` and `countUserActivity`; open leads are all statuses other than `closed`.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- adminUserDetail.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/functions/adminUserDetail.js backend/functions/adminUserDetail.test.js
git commit -m "test: cover admin user activity detail"
```

### Task 2: Add the protected endpoint

**Files:**
- Modify: `backend/functions/index.js:13-18, 1028-1047`
- Test: `backend/functions/adminUserDetail.test.js`

**Interfaces:**
- Consumes: `buildAdminUserDetail`.
- Produces: `GET /admin/users/:uid → { user, cars, enquiries, summary }`.

- [ ] **Step 1: Extend the failing test for an empty selected user**

```js
test("keeps the requested user and returns zero activity counts", () => {
  const result = buildAdminUserDetail({ user, cars: [], enquiries: [] });
  assert.equal(result.user.uid, "seller-a");
  assert.equal(result.summary.totalCars, 0);
  assert.equal(result.summary.totalEnquiries, 0);
});
```

- [ ] **Step 2: Verify RED then complete the helper contract**

Run: `npm test -- adminUserDetail.test.js`

Expected: FAIL until every zero count exists.

- [ ] **Step 3: Implement the route after the list route**

```js
app.get("/admin/users/:uid", requireAdmin, async (req, res) => {
  const userSnapshot = await database.collection("users").doc(req.params.uid).get();
  if (!userSnapshot.exists) return res.status(404).json({ error: "User not found." });
  const [carsSnapshot, enquiriesSnapshot] = await Promise.all([
    database.collection("cars").get(), database.collection("enquiries").get(),
  ]);
  res.json(buildAdminUserDetail({
    user: serializeUser(userSnapshot),
    cars: carsSnapshot.docs.map(serializeCar),
    enquiries: enquiriesSnapshot.docs.map(serializeEnquiry),
  }));
});
```

Import the helper with existing server imports; wrap in the surrounding endpoint error style and log `Failed to load admin user detail`.

- [ ] **Step 4: Verify backend suite**

Run: `npm test` from `backend/functions`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/functions/index.js backend/functions/adminUserDetail.test.js
git commit -m "feat: add admin user detail endpoint"
```

### Task 3: Add typed client data access

**Files:**
- Modify: `frontend/src/lib/api.ts:68-90, 465-488`

**Interfaces:**
- Produces: `AdminUserActivitySummary`, `AdminUserDetailResponse`, `getAdminUserDetail(uid, token)`.
- Consumes: the new protected endpoint and existing local admin fixtures.

- [ ] **Step 1: Add a temporary failing API usage in the profile page**

```ts
const detail = await getAdminUserDetail("local-seller", LOCAL_ADMIN_TOKEN);
detail.summary.openEnquiries.toLocaleString("en-GB");
detail.cars[0]?.ownerId;
detail.enquiries[0]?.sellerId;
```

- [ ] **Step 2: Verify RED**

Run: `npm run build` from `frontend`

Expected: FAIL because `getAdminUserDetail` is not exported.

- [ ] **Step 3: Implement types and request helper**

```ts
export interface AdminUserDetailResponse {
  user: AdminUser;
  summary: AdminUserActivitySummary;
  cars: Car[];
  enquiries: AdminEnquiry[];
}
export function getAdminUserDetail(uid: string, token: string) {
  if (isLocalAdminToken(token)) return Promise.resolve(buildLocalAdminUserDetail(uid));
  return request<AdminUserDetailResponse>(`/admin/users/${encodeURIComponent(uid)}`, {}, token);
}
```

Implement the local helper beside local admin utilities: find by UID, throw `new Error("User not found.")` when absent, filter the existing mock cars and leads, sort them, and calculate the same six counts.

- [ ] **Step 4: Verify GREEN**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api.ts
git commit -m "feat: add admin user detail client"
```

### Task 4: Build the full-page profile and route

**Files:**
- Create: `frontend/src/pages/AdminUserProfile.tsx`
- Modify: `frontend/src/App.tsx:14-16, 65-67`

**Interfaces:**
- Consumes: `getAdminUserDetail`, `updateAdminUser`, session helpers, formatters.
- Produces: protected `/admin/users/:uid` page.

- [ ] **Step 1: Register a failing page import and route**

```tsx
import AdminUserProfile from "./pages/AdminUserProfile";
<Route path="/admin/users/:uid" element={<AdminUserProfile />} />
```

Place it before `/admin`.

- [ ] **Step 2: Verify RED**

Run: `npm run build`

Expected: FAIL because `AdminUserProfile` is missing.

- [ ] **Step 3: Implement the page**

Use `useParams`, `Navigate`, `useQuery`, `useMutation`, and `useQueryClient`. Redirect when there is no local admin session. Query with `["admin-user-detail", adminIdentity, uid]`. Refresh and role mutation must invalidate this query plus `admin-users` and `admin-summary`.

Render a Back to users link, identity block (name/email/role), six live summary cards, account contact and date details, vehicle portfolio table, and buyer lead table. Vehicle rows link to `/car/:id`; leads show buyer contact, message, status, and date. Use the existing card/table styles and `overflow-x-auto`; present distinct loading, retryable error, not-found, and empty list states. Role updates reuse `updateAdminUser` and must remain disabled for `local-admin`.

- [ ] **Step 4: Verify GREEN**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/AdminUserProfile.tsx frontend/src/App.tsx
git commit -m "feat: add admin user profile page"
```

### Task 5: Connect user-list navigation and complete verification

**Files:**
- Modify: `frontend/src/pages/AdminDashboard.tsx:544-603`

**Interfaces:**
- Consumes: `adminUser.uid`.
- Produces: accessible profile links from user identity and a View profile control.

- [ ] **Step 1: Add the profile destination**

```tsx
<Link to={`/admin/users/${encodeURIComponent(adminUser.uid)}`}>
  View profile
</Link>
```

- [ ] **Step 2: Wire identity and explicit action**

Make the identity block a link to the same route and add an outlined View profile control alongside the role action. Its accessible name includes the user’s display name; promotion/demotion behavior is unchanged.

- [ ] **Step 3: Verify all checks**

Run: `npm run build` from `frontend`

Run: `npm test` from `backend/functions`

Expected: both PASS.

Manually check local-admin mode: open `/admin`, select Users, select Demo Seller, confirm their details, vehicles, leads, and counts are visible; use Back to users; refresh the profile URL; confirm the data reloads from the query instead of navigation state.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/AdminDashboard.tsx
git commit -m "feat: link admin users to profile details"
```

## Plan Self-Review

- The backend helper and endpoint cover filtering, sorting, aggregate counts, and missing users.
- The API task ensures identical live and local response contracts.
- The page task covers all approved data, responsive layout, profile state, and role action behavior.
- Navigation and production verification are explicit in the final task.
- No placeholders, unnamed types, or unimplemented requirement references remain.

