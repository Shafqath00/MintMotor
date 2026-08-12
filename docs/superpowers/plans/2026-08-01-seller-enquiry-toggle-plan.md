# Seller Enquiry Toggle and Van Body Type Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let sellers opt out of MintMotor enquiries and add Van as a vehicle body type.

**Architecture:** Store `allowEnquiries` on the listing as a boolean that defaults to true when absent. The seller editor persists it with existing contact preferences; the public contact card uses it to decide whether to render its existing enquiry form.

**Tech Stack:** React, TypeScript, Vitest, Express/Firebase Functions, Node test runner.

## Global Constraints

- Preserve current enquiry availability for listings without `allowEnquiries`.
- Keep direct email and phone visibility independent of the new preference.
- Use existing form controls and the existing enquiry card styling.

---

### Task 1: Define the shared listing field and body type

**Files:**
- Modify: `frontend/src/lib/data.ts:34-87,176-185`
- Test: `frontend/src/components/cars/CarContactCard.test.tsx`

**Interfaces:**
- Produces: `Car.allowEnquiries?: boolean` and `bodyTypes` containing `"Van"`.

- [ ] **Step 1: Write the failing tests**

```ts
it("includes Van in the available body types", () => {
  expect(bodyTypes).toContain("Van");
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- CarContactCard.test.tsx`
Expected: FAIL because `Van` is absent from `bodyTypes`.

- [ ] **Step 3: Add the shared type and option**

```ts
allowEnquiries?: boolean;

export const bodyTypes = [/* existing values */, "Van"];
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npm test -- CarContactCard.test.tsx`
Expected: PASS.

### Task 2: Persist the seller preference

**Files:**
- Modify: `frontend/src/lib/api.ts: ListingPayload`
- Modify: `frontend/src/pages/Sellpages/CarDetails.tsx: emptyForm, hydration, payload, Step 5`
- Modify: `backend/functions/validators.js:286-330`
- Test: `backend/functions/validators.test.js`

**Interfaces:**
- Consumes: `Car.allowEnquiries?: boolean`.
- Produces: `ListingPayload.allowEnquiries: boolean`; stored `listing.allowEnquiries`.

- [ ] **Step 1: Write a failing backend test**

```js
test("validateListingPayload preserves an explicit enquiry preference", () => {
  const {listing} = validateListingPayload({...validPayload, allowEnquiries: false});
  assert.equal(listing.allowEnquiries, false);
});
```

- [ ] **Step 2: Run the backend test to verify it fails**

Run: `npm test -- validators.test.js`
Expected: FAIL because the sanitizer omits `allowEnquiries`.

- [ ] **Step 3: Add the minimal persistence path**

```ts
// CarDetails defaults/hydration/payload
allowEnquiries: true
allowEnquiries: car.allowEnquiries !== false
allowEnquiries: form.allowEnquiries
```

```js
// validator
allowEnquiries: payload.allowEnquiries !== false,
```

- [ ] **Step 4: Add the Step 5 toggle**

```tsx
<ToggleCheck
  checked={form.allowEnquiries}
  onChange={(value) => setField("allowEnquiries", value)}
  label="Allow buyers to contact me through MintMotor"
/>
```

- [ ] **Step 5: Run the backend test to verify it passes**

Run: `npm test -- validators.test.js`
Expected: PASS.

### Task 3: Respect the preference on public listings

**Files:**
- Modify: `backend/functions/publicCar.js:3-12`
- Modify: `frontend/src/components/cars/CarContactCard.tsx:188-213`
- Test: `backend/functions/publicCar.test.js`
- Test: `frontend/src/components/cars/CarContactCard.test.tsx`

**Interfaces:**
- Consumes: `car.allowEnquiries?: boolean`.
- Produces: public listing preference and conditional enquiry form rendering.

- [ ] **Step 1: Write failing tests**

```js
assert.equal(publicCar({allowEnquiries: false}).allowEnquiries, false);
```

```tsx
renderCard({allowEnquiries: false});
expect(screen.queryByRole("heading", {name: /send an enquiry/i})).not.toBeInTheDocument();
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm test -- publicCar.test.js` and `npm test -- CarContactCard.test.tsx`
Expected: the card test fails because the enquiry form still appears.

- [ ] **Step 3: Apply the conditional rendering**

```tsx
{car.allowEnquiries !== false && <section aria-labelledby="enquiry-title">{/* existing form */}</section>}
```

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `npm test -- CarContactCard.test.tsx` and `npm test -- publicCar.test.js`
Expected: PASS.

### Task 4: Verify the change

**Files:**
- Verify only: all modified files.

- [ ] **Step 1: Run focused frontend tests**

Run: `npm test -- CarContactCard.test.tsx CarDetails.test.tsx`
Expected: PASS.

- [ ] **Step 2: Run backend tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Run the frontend production build**

Run: `npm run build`
Expected: exit code 0.
