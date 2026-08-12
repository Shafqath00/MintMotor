# Car Detail Marketplace Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the public MintMotor car-detail page into a compact, confidence-led marketplace layout while preserving all existing data flows and leaving `CarImageGallery` untouched.

**Architecture:** Keep `CarDetail.tsx` as the route and data owner, but reorganize its local presentational helpers into a consistent rounded-card system. Derive a small confidence summary from existing `Car` fields without creating new APIs or scores. Keep `CarContactCard` behaviour intact and adjust only its presentation so the sticky seller column reads as one coherent surface.

**Tech Stack:** React 18, TypeScript, TanStack Query, React Router, Tailwind CSS, Lucide React, Vitest, Testing Library.

## Global Constraints

- Do not modify `frontend/src/components/cars/CarImageGallery.tsx`.
- Use only fields already present on `Car`; never invent vehicle facts or scores.
- Preserve `getCar(id, token)`, saved-listing storage, share behaviour, contact permissions, enquiry submission, distance lookup, loading, retry, and missing-vehicle states.
- Preserve the mobile fixed contact bar and 44px minimum touch targets.
- Do not add seller inventory, insurance quotes, finance products, expert reviews, or backend changes.
- Keep MintMotor blue `#0000A3`, verified green `#15803D`, neutral canvas `#F5F5F3`, and accessible contrast.

---

### Task 1: Lock the redesigned summary contract with tests

**Files:**
- Modify: `frontend/src/pages/CarDetail.test.tsx`
- Modify: `frontend/src/pages/CarDetail.tsx`

**Interfaces:**
- Consumes: the existing `Car` fixture and mocked `CarImageGallery` boundary.
- Produces: accessible summary landmarks and confidence signals derived from mileage, service history, MOT, and vehicle history.

- [ ] **Step 1: Add a failing summary-hierarchy test**

```tsx
it("presents the vehicle summary and available confidence signals", async () => {
  renderRoute({
    mileage: 21950,
    serviceHistory: "full",
    motDueDate: "2027-04-21",
    vehicleHistory: {
      provider: "ukvehicledata",
      checkedAt: "2026-08-01T10:00:00.000Z",
      registrationNumber: "AB12 CDE",
      summaryStatus: "clear",
    },
  });

  expect(await screen.findByRole("heading", { name: /2024 bmw m4/i })).toBeInTheDocument();
  expect(screen.getByText("21,950 miles")).toBeInTheDocument();
  expect(screen.getByText("Full service history")).toBeInTheDocument();
  expect(screen.getByText(/MOT until 21 April 2027/i)).toBeInTheDocument();
  expect(screen.getByText("History check clear")).toBeInTheDocument();
});
```

- [ ] **Step 2: Verify the test fails for the missing confidence summary**

Run: `npm test -- src/pages/CarDetail.test.tsx`

Expected: FAIL because `History check clear` and the compact confidence labels do not yet exist.

- [ ] **Step 3: Add a confidence-item helper in `CarDetail.tsx`**

```tsx
type ConfidenceItem = {
  label: string;
  tone: "default" | "verified";
};

function getConfidenceItems(car: Car): ConfidenceItem[] {
  const items: ConfidenceItem[] = [];
  if (car.mileage > 0) items.push({ label: formatMileage(car.mileage), tone: "default" });
  if (car.serviceHistory === "full") items.push({ label: "Full service history", tone: "verified" });
  if (car.motDueDate) items.push({ label: `MOT until ${formatUkDate(car.motDueDate)}`, tone: "default" });
  if (car.vehicleHistory?.summaryStatus === "clear") items.push({ label: "History check clear", tone: "verified" });
  return items.filter((item) => !item.label.includes("undefined"));
}
```

- [ ] **Step 4: Render the helper output below title, price, and location**

```tsx
<ul aria-label="Vehicle confidence" className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
  {confidenceItems.map((item) => (
    <li key={item.label} className="rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm font-semibold text-neutral-800">
      <CheckCircle2 className={item.tone === "verified" ? "text-[#15803D]" : "text-[#0000A3]"} />
      {item.label}
    </li>
  ))}
</ul>
```

- [ ] **Step 5: Run the focused page tests**

Run: `npm test -- src/pages/CarDetail.test.tsx`

Expected: PASS with the existing gallery mock assertion unchanged.

### Task 2: Recompose the public detail page into the marketplace card stack

**Files:**
- Modify: `frontend/src/pages/CarDetail.tsx`
- Test: `frontend/src/pages/CarDetail.test.tsx`

**Interfaces:**
- Consumes: `Car`, `CarImageGallery`, `VehicleHistoryPanel`, `CarContactCard`, `getConfidenceItems(car)`.
- Produces: responsive summary, overview, description, running-cost, features, history, guidance, and sticky-contact regions.

- [ ] **Step 1: Update the local `Panel` primitive**

```tsx
function Panel({ children, id, title, action }: {
  children: React.ReactNode;
  id: string;
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <section id={id} className="overflow-hidden rounded-2xl border border-neutral-200 bg-white" aria-labelledby={`${id}-title`}>
      <header className="flex items-center justify-between gap-4 border-b border-neutral-100 px-5 py-4 sm:px-6">
        <h2 id={`${id}-title`} className="font-display text-xl font-semibold tracking-tight text-neutral-950">{title}</h2>
        {action}
      </header>
      <div className="px-5 py-5 sm:px-6">{children}</div>
    </section>
  );
}
```

- [ ] **Step 2: Convert `Overview` to compact icon-led facts**

Use a fact definition with exact fields and icons:

```tsx
const values = [
  { label: "Mileage", value: car.mileage ? formatMileage(car.mileage) : undefined, icon: Gauge },
  { label: "Registration", value: car.registrationNumber, icon: BadgeInfo },
  { label: "Fuel type", value: car.fuelType, icon: Fuel },
  { label: "Body type", value: car.bodyType, icon: CarFront },
  { label: "Engine", value: car.engineSize, icon: Gauge },
  { label: "Gearbox", value: car.transmission, icon: Settings2 },
  { label: "Doors", value: car.doors, icon: DoorOpen },
  { label: "Seats", value: car.seats, icon: Armchair },
  { label: "Colour", value: car.color, icon: Palette },
].filter(({ value }) => hasDisplayValue(value));
```

Render the facts as a two-column mobile grid and three-column desktop grid with no invented fallback values.

- [ ] **Step 3: Restyle summary and route layout**

Implement:

```tsx
<div className="min-h-screen bg-[#F5F5F3] pb-28 pt-4 lg:pb-12">
  <div className="container mx-auto max-w-7xl px-4">
    {/* breadcrumb + actions */}
    <CarImageGallery images={car.images ?? []} title={title} />
    <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
      <main className="min-w-0 space-y-4">{/* card stack */}</main>
      <aside className="scroll-mt-24 space-y-3 lg:sticky lg:top-24">{/* price + contact */}</aside>
    </div>
  </div>
</div>
```

The summary card must show title, attention-grabber when present, location, asking price, and confidence items. Reorder the stack to Overview, Description, Running costs, Vehicle history, Features, Before you buy.

- [ ] **Step 4: Preserve conditional data behaviour**

Keep these exact rules:

```tsx
{hasDisplayValue(car.description) && <Panel id="description" title="Description">...</Panel>}
{runningCostValues.length > 0 && <Panel id="running-costs" title="Running costs">...</Panel>}
<VehicleHistoryPanel history={car.vehicleHistory} mode="public" />
{features.length > 0 && <Panel id="features" title="Features and equipment">...</Panel>}
```

- [ ] **Step 5: Run the focused page tests**

Run: `npm test -- src/pages/CarDetail.test.tsx`

Expected: PASS for loading, retry, not found, hierarchy, omission, save/share, contact permissions, and the new summary assertions.

### Task 3: Align the seller contact surface without changing behaviour

**Files:**
- Modify: `frontend/src/components/cars/CarContactCard.tsx`
- Test: `frontend/src/components/cars/CarContactCard.test.tsx`

**Interfaces:**
- Consumes: existing `CarContactCardProps`, permission-derived phone/email links, enquiry mutation, and distance mutation.
- Produces: a denser rounded marketplace card using the same labels, controls, validation, and links.

- [ ] **Step 1: Preserve behaviour tests before styling**

Run: `npm test -- src/components/cars/CarContactCard.test.tsx`

Expected: PASS before presentation changes.

- [ ] **Step 2: Apply the marketplace card styling**

Update only classes and supporting copy structure:

```tsx
<aside className="overflow-hidden rounded-2xl border border-neutral-200 bg-white" aria-label="Contact seller">
  <div className="p-5 sm:p-6">{/* seller identity and permitted contact buttons */}</div>
  {car.allowEnquiries !== false && (
    <section className="border-t border-neutral-100 p-5 sm:p-6" aria-labelledby="enquiry-title">...</section>
  )}
  <section className="border-t border-neutral-100 p-5 sm:p-6" aria-labelledby="distance-title">...</section>
</aside>
```

Keep all existing field IDs, refs, names, labels, error IDs, `showPhone`, `showEmail`, `allowEnquiries`, and seller-profile link unchanged.

- [ ] **Step 3: Run contact and page tests together**

Run: `npm test -- src/components/cars/CarContactCard.test.tsx src/pages/CarDetail.test.tsx`

Expected: PASS with no behavioural regressions.

### Task 4: Verify responsive composition and production output

**Files:**
- Verify only: `frontend/src/pages/CarDetail.tsx`
- Verify only: `frontend/src/components/cars/CarContactCard.tsx`
- Must remain unmodified: `frontend/src/components/cars/CarImageGallery.tsx`

**Interfaces:**
- Consumes: the finished page and contact card.
- Produces: verified desktop/mobile layout and build output.

- [ ] **Step 1: Confirm gallery is untouched**

Run: `git diff -- src/components/cars/CarImageGallery.tsx`

Expected: no diff caused by this redesign.

- [ ] **Step 2: Run a production build**

Run: `npm run build`

Expected: PASS with no TypeScript or Vite errors.

- [ ] **Step 3: Inspect the local route at desktop and mobile widths**

Verify one populated `/car/:id` route at approximately 1440px and 390px widths. Confirm the unchanged gallery, readable card stack, sticky desktop contact, single-column mobile flow, fixed mobile contact bar, visible focus states, and no horizontal overflow.

- [ ] **Step 4: Review against the approved spec**

Confirm: no seller inventory, no new data/API, no copied Auto Trader branding or text, no `CarImageGallery` edit, and no behavioural regression in contact controls.

## Plan self-review

- Spec coverage: Tasks 1–4 cover the summary, card stack, conditional data, contact presentation, accessibility, mobile behaviour, unchanged gallery, tests, build, and visual QA.
- Placeholder scan: no deferred implementation placeholders remain.
- Type consistency: confidence items consume `Car` and return `{ label, tone }`; all page sections continue consuming the existing `Car` object.
