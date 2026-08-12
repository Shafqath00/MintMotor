# Publish Validation Focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Direct sellers to the first missing required field when a listing cannot be published.

**Architecture:** Keep validation state as internal form field keys, so the existing error styling can consume it directly. Associate each required field with a focusable DOM target; after React renders the invalid state, smooth-scroll and focus the first target while retaining the existing summary alert.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library.

## Global Constraints

- Preserve the existing publish-blocking validation message.
- Highlight every missing required field, including the photos upload region.
- Smoothly scroll to and focus the first missing required field.
- Do not change the save-draft or subscription/verification behavior.

---

### Task 1: Publish validation focus behavior

**Files:**
- Modify: `frontend/src/pages/Sellpages/CarDetails.tsx:1-795`
- Create: `frontend/src/pages/Sellpages/CarDetails.test.tsx`

**Interfaces:**
- Consumes: the existing `form`, `existingImages`, `imageFiles`, `invalidFields`, and `handlePublishClick` state in `CarDetails`.
- Produces: invalid field keys (`registrationNumber`, `photos`, `make`, `model`, `year`, `price`, `mileage`, `fuelType`, `transmission`, `bodyType`, `location`, `sellerPostcode`, `description`) and focus handling for the first invalid field.

- [ ] **Step 1: Write the failing regression test**

Create `frontend/src/pages/Sellpages/CarDetails.test.tsx`. Render the seller form with an authenticated, verified, subscribed user and an incomplete listing. Click `Publish listing` and assert that the registration-number input gets the blue error style, receives focus, and has `scrollIntoView({ behavior: "smooth", block: "center" })` called. Mock only Firebase/API boundaries; use the real `CarDetails` component and assert its DOM behavior.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- CarDetails.test.tsx`

Expected: FAIL because the current validation records human-readable labels and scrolls to the page top instead of focusing the first invalid control.

- [ ] **Step 3: Implement the minimal focusable-field mapping**

In `CarDetails.tsx`, replace the `missingFields.push("Display label")` calls with the matching internal field keys. Add stable `id` attributes to required native controls, a focusable target for photos, and a post-render focus effect keyed by the first invalid field. In that effect, call `scrollIntoView({ behavior: "smooth", block: "center" })` and `focus({ preventScroll: true })` when supported. Remove the top-of-page scroll from the missing-field branch only.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npm test -- CarDetails.test.tsx`

Expected: PASS; the test confirms the first missing field is highlighted, scrolled into view, and focused.

- [ ] **Step 5: Run type checking and the production build**

Run: `npm run build`

Expected: exit code 0 with no TypeScript or Vite build errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Sellpages/CarDetails.tsx frontend/src/pages/Sellpages/CarDetails.test.tsx docs/superpowers/plans/2026-07-26-publish-validation-focus-plan.md
git commit -m "fix: focus first invalid listing field"
```
