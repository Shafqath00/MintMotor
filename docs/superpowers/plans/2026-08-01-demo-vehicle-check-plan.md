# Demo Vehicle Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a browser-only Â£5 demo vehicle-check flow that creates, saves, and displays complete sample vehicle-history reports.

**Architecture:** A focused client-side domain module normalizes registrations, selects deterministic seeded report data, and safely persists a bounded history in `localStorage`. Three public React pages compose it into the check, previous-check, and report routes; they do not call the backend or existing Stripe code.

**Tech Stack:** React 18, TypeScript, React Router 6, Tailwind CSS, Lucide React, Vitest, Testing Library.

## Global Constraints

- The feature is demo data only: do not call a provider, Stripe, or MintMotor backend endpoint.
- Never represent demo data as live, independently verified, or covered by a guarantee.
- Price copy is exactly `Â£5 per vehicle check`; the unlock action states that no payment is taken.
- Preserve all existing seller vehicle lookup and subscription behaviour.
- Support keyboard access, visible focus, semantic table/list markup, and mobile one-column reading.
- Store no personal data; retain at most 20 complete report records in browser `localStorage`.

---

## File Structure

- Create `frontend/src/lib/vehicleCheckDemo.ts`: types, registration normalization/validation, deterministic profiles, report creation, and browser storage.
- Create `frontend/src/lib/vehicleCheckDemo.test.ts`: unit tests for the module's public API and persistence boundaries.
- Create `frontend/src/pages/VehicleCheck.tsx`: landing, preview, validation, and demo checkout confirmation.
- Create `frontend/src/pages/VehicleCheck.test.tsx`: interaction tests for landing and unlock journey.
- Create `frontend/src/pages/VehicleCheckReport.tsx`: report-first full demo report.
- Create `frontend/src/pages/VehicleCheckReport.test.tsx`: report rendering and missing report coverage.
- Create `frontend/src/pages/VehicleCheckPrevious.tsx`: saved report list and empty state.
- Create `frontend/src/pages/VehicleCheckPrevious.test.tsx`: ordering and empty-state coverage.
- Modify `frontend/src/App.tsx`: add public routes.
- Modify `frontend/src/components/layout/Header.tsx`: add shared desktop/mobile navigation link.
- Modify `frontend/src/components/layout/Header.test.tsx`: assert the navigation destination.

### Task 1: Define deterministic demo reports and storage

**Files:**
- Create: `frontend/src/lib/vehicleCheckDemo.ts`
- Test: `frontend/src/lib/vehicleCheckDemo.test.ts`

**Interfaces:**
- Produces `normalizeVehicleCheckRegistration(value: string): string`, `isValidVehicleCheckRegistration(value: string): boolean`, `createDemoVehicleCheck(registration: string, createdAt?: string): DemoVehicleCheckReport`, `getSavedDemoVehicleChecks(): DemoVehicleCheckReport[]`, and `saveDemoVehicleCheck(report: DemoVehicleCheckReport): boolean`.
- `DemoVehicleCheckReport` supplies `id`, `registration`, `createdAt`, `summaryStatus`, `vehicle`, `keepers`, `checks`, `mot`, `tax`, `valuation`, and `features`.

- [ ] **Step 1: Write failing tests for registration and report creation**

```ts
it("normalizes a registration and creates a complete demo report", () => {
  expect(normalizeVehicleCheckRegistration(" ab12 cde ")).toBe("AB12 CDE");
  expect(isValidVehicleCheckRegistration("AB12 CDE")).toBe(true);

  const report = createDemoVehicleCheck("AB12 CDE", "2026-08-01T10:00:00.000Z");

  expect(report.registration).toBe("AB12 CDE");
  expect(report.checks).toEqual(expect.objectContaining({
    outstandingFinance: expect.any(Object), policeStolen: expect.any(Object),
    insuranceWriteOff: expect.any(Object), scrapped: expect.any(Object),
    importedExported: expect.any(Object), colourChanges: expect.any(Object),
    registrationChanges: expect.any(Object), fullMileage: expect.any(Object),
  }));
  expect(report.mot.history.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/vehicleCheckDemo.test.ts`

Expected: FAIL with a missing-module or missing-export error.

- [ ] **Step 3: Write failing tests for safe bounded persistence**

```ts
it("stores newest reports first and keeps at most twenty", () => {
  const reports = Array.from({ length: 21 }, (_, index) =>
    createDemoVehicleCheck(`AB\${String(index).padStart(2, "0")} CDE`, `2026-08-\${String(index + 1).padStart(2, "0")}T10:00:00.000Z`),
  );
  reports.forEach(saveDemoVehicleCheck);

  expect(getSavedDemoVehicleChecks()).toHaveLength(20);
  expect(getSavedDemoVehicleChecks()[0].registration).toBe("AB20 CDE");
});

it("returns no reports when stored JSON is malformed", () => {
  localStorage.setItem("mintmotor.demoVehicleChecks", "not-json");
  expect(getSavedDemoVehicleChecks()).toEqual([]);
});
```

- [ ] **Step 4: Implement the minimum complete domain module**

```ts
export function saveDemoVehicleCheck(report: DemoVehicleCheckReport) {
  try {
    const next = [report, ...getSavedDemoVehicleChecks()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}
```

Use 2â€“3 seeded profiles selected by a stable character-code hash. Each profile includes keeper data, tax status, MOT entries/mileages, valuation, features, and the eight named provenance checks. `createDemoVehicleCheck` applies the normalized user registration and generates a unique ID.

- [ ] **Step 5: Run module tests and verify they pass**

Run: `npm test -- src/lib/vehicleCheckDemo.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/vehicleCheckDemo.ts frontend/src/lib/vehicleCheckDemo.test.ts
git commit -m "feat: add demo vehicle check data"
```

### Task 2: Build landing page and demo checkout unlock

**Files:**
- Create: `frontend/src/pages/VehicleCheck.tsx`
- Test: `frontend/src/pages/VehicleCheck.test.tsx`

**Interfaces:**
- Consumes Task 1's five public utilities.
- Produces the default page component for `/vehicle-check` and navigates to `/vehicle-check/report/:reportId`.

- [ ] **Step 1: Write failing interaction tests**

```tsx
it("explains an invalid registration without leaving the check page", async () => {
  render(<VehicleCheck />, { wrapper: MemoryRouter });
  await userEvent.click(screen.getByRole("button", { name: "Start a check" }));
  expect(screen.getByText("Enter a valid UK registration, for example AB12 CDE.")).toBeInTheDocument();
});

it("unlocks and saves a report after the Â£5 demo action without payment fields", async () => {
  render(<VehicleCheck />, { wrapper: MemoryRouter });
  await userEvent.type(screen.getByLabelText("Vehicle registration"), "ab12 cde");
  await userEvent.click(screen.getByRole("button", { name: "Start a check" }));
  await userEvent.click(screen.getByRole("button", { name: "Pay Â£5" }));

  expect(localStorage.getItem("mintmotor.demoVehicleChecks")).toContain("AB12 CDE");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- src/pages/VehicleCheck.test.tsx`

Expected: FAIL with a missing-module error.

- [ ] **Step 3: Implement form, preview, and confirmation states**

```tsx
type CheckStep = "form" | "preview" | "confirm";

const completeDemoCheckout = () => {
  const report = createDemoVehicleCheck(registration);
  saveDemoVehicleCheck(report);
  navigate(`/vehicle-check/report/\${report.id}`);
};
```

Wrap content in `Layout`. Use a visible input label. The preview identifies demonstration data and shows the fixed price. The confirmation contains **Pay Â£5**, **Demo checkout â€” no payment will be taken**, and a link to `/vehicle-check/previous`.

- [ ] **Step 4: Run the page test and verify it passes**

Run: `npm test -- src/pages/VehicleCheck.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/VehicleCheck.tsx frontend/src/pages/VehicleCheck.test.tsx
git commit -m "feat: add demo vehicle check checkout"
```

### Task 3: Render full report and previous checks

**Files:**
- Create: `frontend/src/pages/VehicleCheckReport.tsx`
- Create: `frontend/src/pages/VehicleCheckReport.test.tsx`
- Create: `frontend/src/pages/VehicleCheckPrevious.tsx`
- Create: `frontend/src/pages/VehicleCheckPrevious.test.tsx`

**Interfaces:**
- Consumes `getSavedDemoVehicleChecks()` from Task 1.
- `VehicleCheckReport` reads `reportId` using `useParams`; `VehicleCheckPrevious` links to `/vehicle-check/report/\${report.id}`.

- [ ] **Step 1: Write failing report and saved-list tests**

```tsx
it("renders every requested history category for a saved report", () => {
  const report = createDemoVehicleCheck("AB12 CDE", "2026-08-01T10:00:00.000Z");
  saveDemoVehicleCheck(report);
  render(<VehicleCheckReport />, { wrapper: reportRouter(report.id) });

  expect(screen.getByRole("heading", { name: "Vehicle details" })).toBeInTheDocument();
  expect(screen.getByText("Keeper information")).toBeInTheDocument();
  expect(screen.getByText("MOT mileage timeline")).toBeInTheDocument();
  expect(screen.getByText("Outstanding finance")).toBeInTheDocument();
  expect(screen.getByText("Police stolen status")).toBeInTheDocument();
  expect(screen.getByText("Insurance write-off")).toBeInTheDocument();
});

it("shows the saved reports newest first and has a helpful empty state", () => {
  render(<VehicleCheckPrevious />, { wrapper: MemoryRouter });
  expect(screen.getByText("You have not run a vehicle check yet.")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/pages/VehicleCheckReport.test.tsx src/pages/VehicleCheckPrevious.test.tsx`

Expected: FAIL with missing-module errors.

- [ ] **Step 3: Implement the report-first page and saved-history list**

```tsx
const report = getSavedDemoVehicleChecks().find((item) => item.id === reportId);
if (!report) return <Navigate to="/vehicle-check" replace />;
```

Use `Layout` and semantic headings for: vehicle details; report summary; keeper information; status and provenance; MOT and mileage; value and equipment; and before-you-buy guidance. Explicit text accompanies every check status. MOT history/mileage uses a table with **Test date**, **Mileage**, and **Result** headers. The previous page lists report identity, status, timestamp, and a view link; its empty state links back to `/vehicle-check`.

- [ ] **Step 4: Run report and previous-list tests and verify they pass**

Run: `npm test -- src/pages/VehicleCheckReport.test.tsx src/pages/VehicleCheckPrevious.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/VehicleCheckReport.tsx frontend/src/pages/VehicleCheckReport.test.tsx frontend/src/pages/VehicleCheckPrevious.tsx frontend/src/pages/VehicleCheckPrevious.test.tsx
git commit -m "feat: show saved demo vehicle reports"
```

### Task 4: Wire public routes and navigation, then verify

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/layout/Header.tsx`
- Modify: `frontend/src/components/layout/Header.test.tsx`

**Interfaces:**
- Consumes the default page exports created in Tasks 2â€“3.
- Produces public routes `/vehicle-check`, `/vehicle-check/report/:reportId`, and `/vehicle-check/previous`.

- [ ] **Step 1: Write a failing header navigation test**

```tsx
it("links buyers to the vehicle check from primary navigation", () => {
  render(<MemoryRouter><Header /></MemoryRouter>);
  expect(screen.getAllByRole("link", { name: "Vehicle check" })[0]).toHaveAttribute("href", "/vehicle-check");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/components/layout/Header.test.tsx`

Expected: FAIL because no `Vehicle check` link is rendered.

- [ ] **Step 3: Add routes and shared header link**

```tsx
<Route path="/vehicle-check" element={<VehicleCheck />} />
<Route path="/vehicle-check/report/:reportId" element={<VehicleCheckReport />} />
<Route path="/vehicle-check/previous" element={<VehicleCheckPrevious />} />
```

Add `{ href: "/vehicle-check", label: "Vehicle check" }` to `navLinks` so desktop and mobile navigation stay in sync. Keep routes above the catch-all route.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- src/components/layout/Header.test.tsx src/lib/vehicleCheckDemo.test.ts src/pages/VehicleCheck.test.tsx src/pages/VehicleCheckReport.test.tsx src/pages/VehicleCheckPrevious.test.tsx`

Expected: PASS.

- [ ] **Step 5: Run full verification**

Run: `npm test && npm run lint && npx tsc --noEmit && npm run build`

Expected: all commands exit 0.

- [ ] **Step 6: Inspect responsive flow**

Run: `npm run dev`

Check `/vehicle-check`, one generated report route, and `/vehicle-check/previous` at desktop and 375px widths. Confirm form errors, demo disclosure, readable table rows, navigation links, and no horizontal overflow.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/App.tsx frontend/src/components/layout/Header.tsx frontend/src/components/layout/Header.test.tsx
git commit -m "feat: route vehicle check experience"
```

## Plan Self-Review

- Spec coverage: Tasks 1â€“3 cover client-only demo data, Â£5 demo checkout, browser persistence, every requested history section, and error handling. Task 4 covers public routes, discoverability, tests, project checks, and responsive inspection.
- Placeholder scan: no deferred work, unspecified tests, or undefined interfaces remain.
- Type consistency: all components consume the `DemoVehicleCheckReport` and named utilities defined in Task 1; route names match Task 4's router wiring.

