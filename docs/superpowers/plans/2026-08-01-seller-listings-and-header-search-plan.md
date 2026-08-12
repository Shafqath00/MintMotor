# Seller Listings and Header Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a seller’s available listings from a car-detail profile click and make header condition links show all matching marketplace cars.

**Architecture:** The public `/cars` query remains the only listing source. Extend its shared server/mock filter with `ownerId`, add a seller-page route that queries published results for that owner, and reuse `CarCard` for rendering. Header navigation will target the existing search route and condition parameter.

**Tech Stack:** React, TypeScript, React Router, TanStack Query, Vitest, Express/Firebase Functions, Node test runner.

## Global Constraints

- Seller results include only published listings and exclude drafts and sold cars.
- Seller identity navigation must be keyboard accessible and use no private seller data.
- Used and New header links must point to `/search?condition=used` and `/search?condition=new`.

---

### Task 1: Add owner filtering to public listings

**Files:**
- Modify: `frontend/src/lib/api.ts:287-318`
- Modify: `backend/functions/index.js:263-300`
- Create: `backend/functions/index.test.js`

**Interfaces:**
- Produces: `getCars({ ownerId: string })` returns the owner’s public listings in mock and server filtering.

- [ ] **Step 1: Write failing filter tests**

```js
test("applyCarFilters returns only published cars for the requested owner", () => {
  const cars = [
    {id: "owner-a-live", ownerId: "owner-a", status: "published"},
    {id: "owner-a-draft", ownerId: "owner-a", status: "draft"},
    {id: "owner-b-live", ownerId: "owner-b", status: "published"},
  ];
  assert.deepEqual(applyCarFilters(cars, {ownerId: "owner-a"}).map((car) => car.id), ["owner-a-live"]);
});
```

- [ ] **Step 2: Run the backend filter test and verify it fails**

Run: `npm test -- index.test.js`
Expected: FAIL because `ownerId` is ignored.

- [ ] **Step 3: Implement the shared owner filter**

```js
if (query.ownerId) results = results.filter((car) => car.ownerId === query.ownerId);
```

```ts
if (params.get("ownerId")) cars = cars.filter((car) => car.ownerId === params.get("ownerId"));
```

- [ ] **Step 4: Run the backend filter test and verify it passes**

Run: `npm test -- index.test.js`
Expected: PASS.

### Task 2: Add the seller listings page and profile navigation

**Files:**
- Create: `frontend/src/pages/SellerListings.tsx`
- Modify: `frontend/src/App.tsx:45-69`
- Modify: `frontend/src/components/cars/CarContactCard.tsx:162-171`
- Test: `frontend/src/components/cars/CarContactCard.test.tsx`
- Create: `frontend/src/pages/SellerListings.test.tsx`

**Interfaces:**
- Consumes: `/seller/:ownerId?exclude=<carId>` and `getCars({ ownerId })`.
- Produces: seller-page heading, `CarCard` grid excluding `exclude`, loading/error/empty states.

- [ ] **Step 1: Write failing navigation and page tests**

```tsx
renderCard({ownerId: "seller-1"});
expect(screen.getByRole("link", {name: /ava mitchell/i})).toHaveAttribute("href", "/seller/seller-1?exclude=contact-car-1");
```

```tsx
mockedGetCars.mockResolvedValue({cars: [currentCar, anotherCar]});
renderSellerPage("/seller/seller-1?exclude=current-car");
expect(await screen.findByText(/another car/i)).toBeInTheDocument();
expect(screen.queryByText(/current car/i)).not.toBeInTheDocument();
```

- [ ] **Step 2: Run focused frontend tests and verify they fail**

Run: `npm test -- CarContactCard.test.tsx SellerListings.test.tsx`
Expected: FAIL because the public seller route and identity link do not exist.

- [ ] **Step 3: Implement the route, page, and profile link**

```tsx
<Route path="/seller/:ownerId" element={<SellerListings />} />
```

```tsx
const sellerCars = (data?.cars ?? []).filter((car) => car.id !== excludeId);
```

```tsx
<Link to={`/seller/${car.ownerId}?exclude=${car.id}`} aria-label={`View ${sellerName}'s listings`}>
  {/* existing seller identity */}
</Link>
```

- [ ] **Step 4: Run focused frontend tests and verify they pass**

Run: `npm test -- CarContactCard.test.tsx SellerListings.test.tsx`
Expected: PASS.

### Task 3: Point header condition links to marketplace results

**Files:**
- Modify: `frontend/src/components/layout/Header.tsx:18-24`
- Create: `frontend/src/components/layout/Header.test.tsx`

**Interfaces:**
- Produces: header Used cars and New cars links targeting complete condition-filtered search results.

- [ ] **Step 1: Write a failing header navigation test**

```tsx
expect(screen.getByRole("link", {name: "Used cars"})).toHaveAttribute("href", "/search?condition=used");
expect(screen.getByRole("link", {name: "New cars"})).toHaveAttribute("href", "/search?condition=new");
```

- [ ] **Step 2: Run the focused header test and verify it fails**

Run: `npm test -- Header.test.tsx`
Expected: FAIL because links point to `/used-cars` and `/new-cars`.

- [ ] **Step 3: Change only the two navigation targets**

```ts
{href: "/search?condition=used", label: "Used cars"},
{href: "/search?condition=new", label: "New cars"},
```

- [ ] **Step 4: Run the focused header test and verify it passes**

Run: `npm test -- Header.test.tsx`
Expected: PASS.

### Task 4: Verify integration

**Files:**
- Verify only: all files above.

- [ ] **Step 1: Run the complete backend suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 2: Run the focused frontend suite**

Run: `npm test -- CarContactCard.test.tsx SellerListings.test.tsx Header.test.tsx`
Expected: PASS.

- [ ] **Step 3: Run the frontend production build**

Run: `npm run build`
Expected: exit code 0.
