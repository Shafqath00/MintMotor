# Admin Trending Makes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let administrators choose the makes that determine the homepage Trending cars cards.

**Architecture:** Store ordered make names in `platformSettings/homepage`. Add public and admin Express endpoints, typed API helpers, an Admin Dashboard settings card, and homepage filtering that falls back to the present newest-new-cars behavior if no setting is saved.

**Tech Stack:** Firebase Functions, Firestore, Express, React, TypeScript, TanStack Query, Node test runner, Vitest.

## Global Constraints

- Trending makes are separate from `Car.isFeatured`.
- Allow one to four unique, trimmed make names; preserve the saved order.
- Never let a public client write platform settings.
- A missing or failed public setting read must retain the current homepage behavior.

---

### Task 1: Add settings validation and backend routes

**Files:**
- Modify: `backend/functions/validators.js`
- Modify: `backend/functions/index.js`
- Test: `backend/functions/validators.test.js`

**Interfaces:**
- Produces `validateTrendingMakes(payload)`, returning `{ trendingMakes, errors }`.
- Produces `GET /platform-settings/homepage` with `{ trendingMakes: string[] }`.
- Produces admin-only `PUT /admin/platform-settings/homepage` with `{ trendingMakes: string[] }`.

- [ ] **Step 1: Write failing validator tests**

```js
test("validateTrendingMakes keeps an ordered, unique make list", () => {
  const result = validateTrendingMakes({ trendingMakes: ["BMW", "Audi", "Tesla"] });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.trendingMakes, ["BMW", "Audi", "Tesla"]);
});

test("validateTrendingMakes rejects duplicates and more than four makes", () => {
  const result = validateTrendingMakes({ trendingMakes: ["BMW", "bmw", "Audi", "Tesla", "Volvo"] });
  assert.match(result.errors.join(" "), /unique/);
  assert.match(result.errors.join(" "), /four/);
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- validators.test.js`

Working directory: `backend/functions`

Expected: FAIL because `validateTrendingMakes` is not exported.

- [ ] **Step 3: Implement validator and routes**

```js
function validateTrendingMakes(payload = {}) {
  const trendingMakes = Array.isArray(payload.trendingMakes)
    ? payload.trendingMakes.map((make) => asString(make)).filter(Boolean)
    : [];
  const seen = new Set();
  const hasDuplicate = trendingMakes.some((make) => {
    const key = make.toLowerCase();
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
  const errors = [];
  if (!Array.isArray(payload.trendingMakes)) errors.push("Trending makes must be a list.");
  if (trendingMakes.length < 1 || trendingMakes.length > 4) errors.push("Choose between one and four trending makes.");
  if (hasDuplicate) errors.push("Trending makes must be unique.");
  return { trendingMakes, errors };
}
```

Read `platformSettings/homepage` with an empty-list default. Use `requireAdmin`, validate the PUT body, then `set({ trendingMakes, updatedAt: FieldValue.serverTimestamp() }, { merge: true })` and return the saved list.

- [ ] **Step 4: Verify the focused backend test passes**

Run: `npm test -- validators.test.js`

Expected: PASS.

### Task 2: Add API contracts and the dashboard settings card

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/pages/AdminDashboard.tsx`
- Test: `frontend/src/pages/AdminDashboard.test.tsx` (create if missing)

**Interfaces:**
- Produces `HomepageSettings`, `getHomepageSettings()`, and `updateHomepageSettings(payload, token)`.
- Consumes `getAdminCars` to produce available makes for the dashboard selects.

- [ ] **Step 1: Write a failing dashboard test**

```tsx
it("saves the ordered trending make selection", async () => {
  renderDashboard();
  await user.selectOptions(screen.getByLabelText("Trending make 1"), "BMW");
  await user.selectOptions(screen.getByLabelText("Trending make 2"), "Audi");
  await user.click(screen.getByRole("button", { name: "Save trending makes" }));
  expect(mockedUpdateHomepageSettings).toHaveBeenCalledWith(
    { trendingMakes: ["BMW", "Audi"] },
    "admin-token",
  );
});
```

- [ ] **Step 2: Verify the test fails**

Run: `npm test -- AdminDashboard.test.tsx`

Working directory: `frontend`

Expected: FAIL because the settings client and form do not exist.

- [ ] **Step 3: Implement API and dashboard panel**

Add API helpers using `GET /platform-settings/homepage` and `PUT /admin/platform-settings/homepage`. In the Listings tab, render a `HomepageTrendingMakesCard` above the listing table. Load the saved list with `useQuery`; derive alphabetized make options from admin listings; render four labelled selects; filter each select’s options to prevent duplicate choices; save non-empty values with `useMutation`; and display clear saved/error feedback.

- [ ] **Step 4: Verify the focused frontend test passes**

Run: `npm test -- AdminDashboard.test.tsx`

Expected: PASS.

### Task 3: Filter the homepage Trending cars cards

**Files:**
- Modify: `frontend/src/components/home/HomeMarketplaceSections.tsx`
- Modify: `frontend/src/components/home/HomeMarketplaceSections.test.tsx`

**Interfaces:**
- Consumes `getHomepageSettings()` and `getCars({ condition: "new", limit: 24 })`.
- Produces up to four cards ordered first by `trendingMakes`, falling back to existing new-car ordering when the saved list is empty or unavailable.

- [ ] **Step 1: Write failing homepage tests**

```tsx
it("orders live trending cards by the admin-selected makes", async () => {
  mockedGetHomepageSettings.mockResolvedValue({ trendingMakes: ["Tesla", "BMW"] });
  mockedGetCars.mockResolvedValue({ cars: [bmwCar, audiCar, teslaCar] });
  render(<HomeMarketplaceSections />);
  expect(await screen.findAllByRole("link", { name: /tesla|bmw/i })).toHaveLength(2);
  expect(screen.getAllByRole("heading", { level: 3 }).map((item) => item.textContent)).toEqual(["Tesla Model 3", "BMW M4"]);
});
```

- [ ] **Step 2: Verify the test fails**

Run: `npm test -- HomeMarketplaceSections.test.tsx`

Working directory: `frontend`

Expected: FAIL because homepage settings are not requested or used.

- [ ] **Step 3: Implement filtering with a safe fallback**

```ts
const orderedCars = trendingMakes.length
  ? trendingMakes.flatMap((make) => liveCars.filter((car) => car.make.toLowerCase() === make.toLowerCase()))
  : liveCars;
```

Fetch up to 24 new cars so a selected make has a fair chance to be found; de-duplicate cars by id, then limit display to four. On settings-query error or an empty saved list, use the existing unfiltered newest-new-cars behavior.

- [ ] **Step 4: Verify focused homepage tests pass**

Run: `npm test -- HomeMarketplaceSections.test.tsx`

Expected: PASS.

### Task 4: Full verification

**Files:**
- Verify: backend settings route and validators; Admin Dashboard; homepage marketplace section.

- [ ] **Step 1: Run backend tests**

Run: `npm test`

Working directory: `backend/functions`

Expected: PASS.

- [ ] **Step 2: Run frontend focused tests**

Run: `npm test -- AdminDashboard.test.tsx HomeMarketplaceSections.test.tsx`

Working directory: `frontend`

Expected: PASS.

- [ ] **Step 3: Run the production build**

Run: `npm run build`

Working directory: `frontend`

Expected: exit code 0.