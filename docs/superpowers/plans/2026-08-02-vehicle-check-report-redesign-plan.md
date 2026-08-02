# MintMotor Vehicle Check Report Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the authenticated saved vehicle-check report as a polished, accessible, print-friendly MintMotor document that presents every supported live API field clearly.

**Architecture:** Keep authentication, route handling, and `getVehicleCheck` fetching in `VehicleCheckReport`. Keep focused presentation components and deterministic formatting/chart helpers in the same page file so they consume only the normalized `VehicleCheckReport` API type; add a page-scoped print class in the global stylesheet and exercise the screen through mocked authenticated API data.

**Tech Stack:** React 18, TypeScript, React Router, Tailwind CSS, lucide-react, Vitest, Testing Library.

## Global Constraints

- Use existing MintMotor `primary`, neutral, charcoal, border, background, and foreground tokens; do not copy AutoTrader branding, colours, logos, wording, or proprietary assets.
- Use the configured Outfit display font and DM Sans body font through existing Tailwind utilities.
- Do not add a chart dependency; generate the mileage SVG locally from the saved report snapshot.
- Do not change the live-report API, Firestore storage, payment flow, or UKVD package.
- Do not display credentials, raw provider payloads, full VIN data, or unsupported check categories.
- Missing provider values must display `Not supplied by provider`.
- Excluded categories must be presented neutrally and must not resemble failed checks.
- Status meaning must be communicated with icon and text, not colour alone.
- The page must avoid horizontal page scrolling at mobile widths; only the MOT table may scroll within its own container.

---

## File Structure

- Modify `frontend/src/pages/VehicleCheckReport.test.tsx`: replace the stale demo-storage test with authenticated live-report mocks and behavioral coverage.
- Modify `frontend/src/pages/VehicleCheckReport.tsx`: implement fetching states, report layout, local formatting/deduplication helpers, semantic check rows, mileage SVG/table, valuation, equipment disclosure, exclusions, and buyer guidance.
- Modify `frontend/src/index.css`: add narrowly scoped print rules for the report shell and action row.

### Task 1: Authenticated Report Shell, Vehicle Facts, and Semantic Summary

**Files:**
- Modify: `frontend/src/pages/VehicleCheckReport.test.tsx`
- Modify: `frontend/src/pages/VehicleCheckReport.tsx`

**Interfaces:**
- Consumes: `getVehicleCheck(reportId: string, token: string): Promise<{ report: VehicleCheckReport }>` and `useAuth(): { user; getToken }`.
- Produces: `formatProviderDate(value?: string): string`, `formatStatus(value?: string): string`, `getOverallStatus(report: Report): "clear" | "attention"`, `ReportSection`, `FactGrid`, and `StatusRow` local page helpers.

- [ ] **Step 1: Replace demo storage setup with authenticated live API mocks**

Use a hoisted mock state and a normalized report fixture so the test exercises the real page contract:

```tsx
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { VehicleCheckReport as Report } from "@/lib/api";
import VehicleCheckReport from "./VehicleCheckReport";

const mocks = vi.hoisted(() => ({
  getToken: vi.fn<() => Promise<string | null>>(),
  getVehicleCheck: vi.fn(),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { uid: "buyer-1" },
    getToken: mocks.getToken,
  }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, getVehicleCheck: mocks.getVehicleCheck };
});

const report: Report = {
  id: "report-1",
  reference: "MM-PL65VNG",
  registrationNumber: "PL65VNG",
  checkedAt: "2026-08-02T11:16:10.000Z",
  vehicle: {
    make: "Land Rover",
    model: "Range Rover Sport",
    variant: "Autobiography Dynamic SDV6 Auto",
    year: 2016,
    fuelType: "Diesel",
    transmission: "Automatic",
    bodyType: "SUV",
    engineSize: "3.0L",
    color: "White",
    dateOfFirstRegistration: "2016-02-22",
  },
  mot: {
    status: "valid",
    expiryDate: "2027-07-03",
    latestMileage: 90485,
    mileageTimeline: [
      { date: "2026-06-25", mileage: 90485, result: "passed" },
      { date: "2025-06-30", mileage: 81206, result: "passed" },
      { date: "2024-07-04", mileage: 71659, result: "passed" },
      { date: "2023-04-17", mileage: 61378, result: "failed" },
    ],
  },
  tax: { status: "taxed", expiryDate: "2027-06-01" },
  valuation: { privateSale: 14608, retail: 17495 },
  specification: {
    features: [
      "Meridian Surround Sound System",
      "meridian surround sound system",
      "Adaptive Cruise Control",
      "Rear View Camera",
      "Heated Windscreen",
      "Fixed Panoramic Roof",
      "Keyless Entry",
      "Front Parking Aid",
      "Power Adjustable Steering Column",
      "Three-zone Climate Control",
      "Automatic Headlamps",
      "Air Suspension",
      "Bluetooth Telephone Connection",
      "Premium Metallic Paint",
    ],
  },
  checks: {
    stolen: { status: "clear", label: "Police stolen status", detail: "No police stolen record found." },
    writtenOff: { status: "recorded", label: "Insurance write-off", detail: "A category S write-off was recorded." },
  },
  excludedChecks: ["Outstanding finance", "Keeper information", "Imported/exported status"],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/vehicle-check/report/${report.id}`]}>
      <Routes>
        <Route path="/vehicle-check/report/:reportId" element={<VehicleCheckReport />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("VehicleCheckReport", () => {
  beforeEach(() => {
    mocks.getToken.mockResolvedValue("test-token");
    mocks.getVehicleCheck.mockResolvedValue({ report });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });
```

- [ ] **Step 2: Add the first failing report-shell test**

Append this test inside the suite:

```tsx
it("renders live vehicle facts and semantic report warnings", async () => {
  renderPage();

  expect(await screen.findByRole("heading", { name: "PL65VNG" })).toBeInTheDocument();
  expect(mocks.getVehicleCheck).toHaveBeenCalledWith("report-1", "test-token");
  expect(screen.getByText(/2016 Land Rover Range Rover Sport/)).toBeInTheDocument();
  expect(screen.getByText("22 February 2016")).toBeInTheDocument();
  expect(screen.getByText("Automatic")).toBeInTheDocument();
  expect(screen.getByText("No police stolen record found.")).toBeInTheDocument();
  expect(screen.getByText("A category S write-off was recorded.")).toBeInTheDocument();
  expect(screen.getByText("Attention needed")).toBeInTheDocument();
});
```

- [ ] **Step 3: Run the focused test and verify the old page fails the new contract**

Run: `npm --prefix frontend test -- --run src/pages/VehicleCheckReport.test.tsx`

Expected: FAIL because the current page does not render the formatted UK date or `Attention needed` status badge.

- [ ] **Step 4: Implement the shell and semantic helpers**

In `VehicleCheckReport.tsx`, expand the imports to include `ReactNode` and the required lucide icons:

```tsx
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CircleHelp,
  Info,
  Printer,
  ShieldAlert,
} from "lucide-react";
```

Add deterministic presentation helpers above the page component:

```tsx
const NOT_SUPPLIED = "Not supplied by provider";

function formatProviderDate(value?: string) {
  if (!value) return NOT_SUPPLIED;
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(date);
}

function formatCheckedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? NOT_SUPPLIED
    : new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function formatStatus(value?: string) {
  if (!value) return NOT_SUPPLIED;
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getOverallStatus(report: Report): "clear" | "attention" {
  return Object.values(report.checks).some((check) => check.status === "recorded")
    ? "attention"
    : "clear";
}

function ReportSection({ id, title, intro, children }: {
  id: string;
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="border-t border-border px-5 py-7 sm:px-8 sm:py-9">
      <h2 id={id} className="font-display text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
        {title}
      </h2>
      {intro && <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{intro}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

function FactGrid({ facts }: { facts: Array<{ label: string; value?: string | number }> }) {
  return (
    <dl className="grid gap-x-8 sm:grid-cols-2">
      {facts.map(({ label, value }) => (
        <div key={label} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] gap-4 border-b border-border py-3 last:border-b-0 sm:last:border-b">
          <dt className="text-sm text-muted-foreground">{label}</dt>
          <dd className="text-right text-sm font-semibold text-foreground">{value || NOT_SUPPLIED}</dd>
        </div>
      ))}
    </dl>
  );
}

function StatusRow({ check }: { check: Report["checks"][keyof Report["checks"]] }) {
  const styles = {
    clear: { Icon: CheckCircle2, box: "border-emerald-200 bg-emerald-50", icon: "text-emerald-700", label: "Clear" },
    recorded: { Icon: ShieldAlert, box: "border-red-200 bg-red-50", icon: "text-red-700", label: "Recorded" },
    unavailable: { Icon: CircleHelp, box: "border-amber-200 bg-amber-50", icon: "text-amber-700", label: "Unavailable" },
  }[check.status];
  const Icon = styles.Icon;

  return (
    <div className={`rounded-xl border p-4 ${styles.box}`}>
      <div className="flex items-start gap-3">
        <Icon aria-hidden="true" className={`mt-0.5 h-5 w-5 shrink-0 ${styles.icon}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-display font-semibold text-foreground">{check.label}</h3>
            <span className={`text-xs font-bold uppercase tracking-wide ${styles.icon}`}>{styles.label}</span>
          </div>
          <p className="mt-1 text-sm leading-6 text-foreground/75">{check.detail || formatStatus(check.status)}</p>
        </div>
      </div>
    </div>
  );
}
```

Render `Layout`, the quiet neutral page background, `.vehicle-report-actions`, a compact previous/print action row, and a `.vehicle-report-document` article. In the article header, render the registration as the `h1`, full vehicle identity, checked timestamp, and an overall badge. Use `AlertTriangle` plus `Attention needed` when `getOverallStatus(report) === "attention"`; otherwise use `CheckCircle2` plus `No recorded warnings`. Follow the header with `Vehicle details` using `FactGrid` and `Report summary` using `Object.values(report.checks).map(check => <StatusRow ... />)`.

- [ ] **Step 5: Run the focused test and verify it passes**

Run: `npm --prefix frontend test -- --run src/pages/VehicleCheckReport.test.tsx`

Expected: PASS for `renders live vehicle facts and semantic report warnings`.

- [ ] **Step 6: Commit the independently working report shell**

```bash
git add frontend/src/pages/VehicleCheckReport.tsx frontend/src/pages/VehicleCheckReport.test.tsx
git commit -m "feat: redesign vehicle report summary"
```

### Task 2: MOT Timeline, Valuation, Equipment Disclosure, and Exclusions

**Files:**
- Modify: `frontend/src/pages/VehicleCheckReport.test.tsx`
- Modify: `frontend/src/pages/VehicleCheckReport.tsx`

**Interfaces:**
- Consumes: the Task 1 `ReportSection`, `FactGrid`, `formatProviderDate`, `formatStatus`, and normalized `Report` type.
- Produces: `normalizeMotEntries(entries): MotEntry[]`, `deduplicateFeatures(features: string[]): string[]`, `MileageChart`, `MotHistory`, `ValuationFigure`, and `EquipmentList` local helpers.

- [ ] **Step 1: Add failing coverage for every remaining supported report section**

Append these tests inside the existing suite:

```tsx
it("renders MOT, tax, mileage, valuation, and neutral package exclusions", async () => {
  renderPage();

  expect(await screen.findByRole("heading", { name: "MOT and mileage history" })).toBeInTheDocument();
  expect(screen.getByText("Valid")).toBeInTheDocument();
  expect(screen.getByText("3 July 2027")).toBeInTheDocument();
  expect(screen.getByText("90,485 miles")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Mileage history from 61,378 to 90,485 miles" })).toBeInTheDocument();
  expect(screen.getByText("£14,608")).toBeInTheDocument();
  expect(screen.getByText("£17,495")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Not included in this report" })).toBeInTheDocument();
  expect(screen.getByText("Outstanding finance")).toBeInTheDocument();
  expect(screen.getByText("These checks were not part of the selected data package.")).toBeInTheDocument();
});

it("deduplicates equipment and expands it on request", async () => {
  const user = userEvent.setup();
  renderPage();

  expect(await screen.findByText("Meridian Surround Sound System")).toBeInTheDocument();
  expect(screen.getAllByText(/Meridian Surround Sound System/i)).toHaveLength(1);
  expect(screen.queryByText("Premium Metallic Paint")).not.toBeInTheDocument();

  const toggle = screen.getByRole("button", { name: "Show all equipment" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  await user.click(toggle);

  expect(screen.getByText("Premium Metallic Paint")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show fewer" })).toHaveAttribute("aria-expanded", "true");
});
```

- [ ] **Step 2: Run the focused test and verify the new sections fail**

Run: `npm --prefix frontend test -- --run src/pages/VehicleCheckReport.test.tsx`

Expected: FAIL because the mileage SVG, formatted values, neutral exclusion copy, and equipment disclosure do not exist yet.

- [ ] **Step 3: Add deterministic MOT, chart, money, and equipment helpers**

Add these helpers to `VehicleCheckReport.tsx`:

```tsx
type MotEntry = Report["mot"]["mileageTimeline"][number];

function normalizeMotEntries(entries: MotEntry[]) {
  return [...entries].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

function deduplicateFeatures(features: string[]) {
  const seen = new Set<string>();
  return features.filter((feature) => {
    const key = feature.trim().toLocaleLowerCase("en-GB");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatMoney(value?: number) {
  return value
    ? new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }).format(value)
    : NOT_SUPPLIED;
}

function MileageChart({ entries }: { entries: MotEntry[] }) {
  const points = [...entries]
    .filter((entry): entry is MotEntry & { mileage: number } => typeof entry.mileage === "number")
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  if (points.length < 2) return <p className="text-sm text-muted-foreground">Not enough mileage data to draw a timeline.</p>;

  const width = 720;
  const height = 220;
  const padding = 28;
  const mileages = points.map(({ mileage }) => mileage);
  const minimum = Math.min(...mileages);
  const maximum = Math.max(...mileages);
  const range = Math.max(maximum - minimum, 1);
  const coordinates = points.map(({ mileage }, index) => ({
    x: padding + (index / (points.length - 1)) * (width - padding * 2),
    y: height - padding - ((mileage - minimum) / range) * (height - padding * 2),
  }));
  const path = coordinates.map(({ x, y }, index) => `${index === 0 ? "M" : "L"} ${x} ${y}`).join(" ");

  return (
    <figure className="rounded-xl border border-border bg-muted/30 p-4">
      <svg role="img" aria-label={`Mileage history from ${minimum.toLocaleString("en-GB")} to ${maximum.toLocaleString("en-GB")} miles`} viewBox={`0 0 ${width} ${height}`} className="h-auto w-full">
        {[0, 1, 2, 3].map((line) => {
          const y = padding + (line / 3) * (height - padding * 2);
          return <line key={line} x1={padding} x2={width - padding} y1={y} y2={y} className="stroke-border" strokeWidth="1" />;
        })}
        <path d={path} fill="none" className="stroke-primary" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" />
        {coordinates.map(({ x, y }, index) => <circle key={`${x}-${y}`} cx={x} cy={y} r="5" className="fill-card stroke-primary" strokeWidth="3" />)}
      </svg>
      <figcaption className="mt-2 flex justify-between text-xs text-muted-foreground">
        <span>{formatProviderDate(points[0].date)}</span>
        <span>{formatProviderDate(points.at(-1)?.date)}</span>
      </figcaption>
    </figure>
  );
}

function MotHistory({ entries }: { entries: MotEntry[] }) {
  const sorted = normalizeMotEntries(entries);
  return (
    <div className="mt-6 overflow-x-auto">
      <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
        <caption className="sr-only">MOT mileage history, newest first</caption>
        <thead><tr className="border-b border-border text-muted-foreground"><th className="py-3 pr-4 font-medium">Test date</th><th className="py-3 pr-4 font-medium">Mileage</th><th className="py-3 font-medium">Result</th></tr></thead>
        <tbody>{sorted.map((entry, index) => <tr key={`${entry.date}-${entry.mileage}-${index}`} className="border-b border-border last:border-b-0"><td className="py-3 pr-4">{formatProviderDate(entry.date)}</td><td className="py-3 pr-4 font-semibold">{typeof entry.mileage === "number" ? `${entry.mileage.toLocaleString("en-GB")} miles` : NOT_SUPPLIED}</td><td className="py-3"><span className={entry.result?.toLowerCase() === "failed" ? "font-semibold text-red-700" : "font-semibold text-emerald-700"}>{formatStatus(entry.result)}</span></td></tr>)}</tbody>
      </table>
    </div>
  );
}

function ValuationFigure({ label, value }: { label: string; value?: number }) {
  return <div className="rounded-xl border border-border bg-muted/30 p-5"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="mt-2 font-display text-2xl font-semibold text-foreground sm:text-3xl">{formatMoney(value)}</dd></div>;
}

function EquipmentList({ features }: { features: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const unique = useMemo(() => deduplicateFeatures(features), [features]);
  const visible = expanded ? unique : unique.slice(0, 12);
  return (
    <div className="mt-8 border-t border-border pt-6">
      <h3 className="font-display text-lg font-semibold text-foreground">Equipment and features</h3>
      {unique.length ? <ul className="mt-4 grid gap-3 sm:grid-cols-2">{visible.map((feature) => <li key={feature.toLocaleLowerCase("en-GB")} className="flex gap-2 text-sm leading-6 text-foreground/80"><CheckCircle2 aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-primary" />{feature}</li>)}</ul> : <p className="mt-3 text-sm text-muted-foreground">{NOT_SUPPLIED}</p>}
      {unique.length > 12 && <Button type="button" variant="outline" className="mt-5" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "Show fewer" : "Show all equipment"}</Button>}
    </div>
  );
}
```

- [ ] **Step 4: Compose the remaining report sections**

After `Report summary`, render:

```tsx
<ReportSection id="mot-history" title="MOT and mileage history" intro="Review the latest MOT and tax position, then compare the recorded mileage over time.">
  <FactGrid facts={[
    { label: "MOT status", value: formatStatus(report.mot.status) },
    { label: "MOT expiry", value: formatProviderDate(report.mot.expiryDate) },
    { label: "Tax status", value: formatStatus(report.tax.status) },
    { label: "Tax expiry", value: report.tax.expiryDate ? formatProviderDate(report.tax.expiryDate) : report.tax.detail },
  ]} />
  <div className="mt-7"><MileageChart entries={report.mot.mileageTimeline} /></div>
  <MotHistory entries={report.mot.mileageTimeline} />
</ReportSection>

<ReportSection id="valuation" title="Valuation and equipment" intro="Provider estimates are a guide and may differ from the seller's asking price.">
  <dl className="grid gap-4 sm:grid-cols-2">
    <ValuationFigure label="Private sale estimate" value={report.valuation.privateSale} />
    <ValuationFigure label="Retail estimate" value={report.valuation.retail} />
  </dl>
  <EquipmentList features={report.specification.features} />
</ReportSection>

<ReportSection id="not-included" title="Not included in this report">
  <div className="rounded-xl border border-border bg-muted/40 p-4">
    <div className="flex gap-3"><Info aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-primary" /><div><p className="text-sm font-semibold text-foreground">These checks were not part of the selected data package.</p><ul className="mt-3 grid gap-2 sm:grid-cols-2">{report.excludedChecks.map((check) => <li key={check} className="text-sm text-muted-foreground">{check}</li>)}</ul></div></div>
  </div>
</ReportSection>

<ReportSection id="buyer-guidance" title="Before buying this vehicle">
  <p className="text-sm leading-6 text-muted-foreground">This report is a dated snapshot. Confirm the vehicle identity and VIN in person, compare the report with the V5C and service documents, and ask the seller about anything that does not match.</p>
</ReportSection>
```

- [ ] **Step 5: Run the focused test and verify all content behavior passes**

Run: `npm --prefix frontend test -- --run src/pages/VehicleCheckReport.test.tsx`

Expected: all three report tests PASS; the duplicate Meridian item appears once and the thirteenth unique item is hidden until expansion.

- [ ] **Step 6: Commit the complete data presentation**

```bash
git add frontend/src/pages/VehicleCheckReport.tsx frontend/src/pages/VehicleCheckReport.test.tsx
git commit -m "feat: add complete vehicle report sections"
```

### Task 3: Loading, Error, Print, and Final Regression Coverage

**Files:**
- Modify: `frontend/src/pages/VehicleCheckReport.test.tsx`
- Modify: `frontend/src/pages/VehicleCheckReport.tsx`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: Task 1's authenticated loading flow and `.vehicle-report-actions` / `.vehicle-report-document` class hooks.
- Produces: accessible loading and safe error report shells plus report-scoped print behavior.

- [ ] **Step 1: Add failing tests for loading and safe error states**

Append these tests inside the suite:

```tsx
it("shows an accessible report loading state", () => {
  mocks.getVehicleCheck.mockReturnValue(new Promise(() => undefined));
  renderPage();
  expect(screen.getByRole("status")).toHaveTextContent("Loading your vehicle check report…");
});

it("shows a safe error with a route to start another check", async () => {
  mocks.getVehicleCheck.mockRejectedValue(new Error("Provider secret diagnostic"));
  renderPage();

  expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load this vehicle check report.");
  expect(screen.queryByText("Provider secret diagnostic")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Start another check" })).toHaveAttribute("href", "/vehicle-check");
});
```

- [ ] **Step 2: Run the focused test and verify the safe error contract fails**

Run: `npm --prefix frontend test -- --run src/pages/VehicleCheckReport.test.tsx`

Expected: FAIL because the current error path exposes the rejected error message and has no start-another-check route.

- [ ] **Step 3: Implement report-shell loading and safe error UI**

Track `loading` separately from `error`, clear state at the start of the effect, and ignore late promise resolution after unmount:

```tsx
const [report, setReport] = useState<Report | null>(null);
const [loading, setLoading] = useState(true);
const [error, setError] = useState(false);

useEffect(() => {
  if (!user || !reportId) return;
  let active = true;
  setLoading(true);
  setError(false);

  getToken()
    .then((token) => token ? getVehicleCheck(reportId, token) : Promise.reject(new Error("Missing token")))
    .then(({ report: nextReport }) => { if (active) setReport(nextReport); })
    .catch(() => { if (active) setError(true); })
    .finally(() => { if (active) setLoading(false); });

  return () => { active = false; };
}, [user, reportId, getToken]);
```

Render both states inside the same neutral background and centered `max-w-3xl` report card. Use `role="status"` with `Loading your vehicle check report…` while loading. Use `role="alert"`, the fixed copy `Unable to load this vehicle check report. Please try again or start a new check.`, and a `Button asChild` link to `/vehicle-check` labelled `Start another check` on failure. Do not interpolate the caught exception.

- [ ] **Step 4: Add narrowly scoped print styles**

Append to `frontend/src/index.css`:

```css
@media print {
  @page { margin: 14mm; }
  body { background: #fff !important; }
  header, footer, .vehicle-report-actions { display: none !important; }
  .vehicle-report-page { padding: 0 !important; background: #fff !important; }
  .vehicle-report-document { max-width: none !important; border: 0 !important; box-shadow: none !important; }
  .vehicle-report-document section { break-inside: avoid; }
}
```

Ensure the page root has `vehicle-report-page` and the article has `vehicle-report-document`. The print button must call `window.print()` and include `Printer aria-hidden="true"`; the previous-check link must include `ArrowLeft aria-hidden="true"`.

- [ ] **Step 5: Run focused behavior tests**

Run: `npm --prefix frontend test -- --run src/pages/VehicleCheckReport.test.tsx`

Expected: all five tests PASS.

- [ ] **Step 6: Run TypeScript validation**

Run: `npm --prefix frontend exec tsc -- --noEmit`

Expected: exit code 0 with no TypeScript diagnostics.

- [ ] **Step 7: Run the production build**

Run: `npm --prefix frontend run build`

Expected: Vite completes successfully and writes the production bundle to `frontend/dist`.

- [ ] **Step 8: Inspect the final diff for scope and encoding problems**

Run: `git diff --check -- frontend/src/pages/VehicleCheckReport.tsx frontend/src/pages/VehicleCheckReport.test.tsx frontend/src/index.css`

Expected: no whitespace errors and no malformed sequences such as `Â£`, `â†`, `â€¦`, or `Â·` in the changed report files.

- [ ] **Step 9: Commit the resilient and print-ready page**

```bash
git add frontend/src/pages/VehicleCheckReport.tsx frontend/src/pages/VehicleCheckReport.test.tsx frontend/src/index.css
git commit -m "test: finish vehicle report experience"
```

## Final Acceptance Checklist

- [ ] The page reads as a compact MintMotor document and uses existing theme tokens and typography.
- [ ] Live report fetching still uses the authenticated report ID and saved API response.
- [ ] Vehicle facts, status checks, MOT/tax, chart, MOT table, valuations, deduplicated equipment, exclusions, and buyer guidance are visible.
- [ ] Recorded, clear, and unavailable outcomes use distinct icon-plus-text treatment.
- [ ] Dates, status text, mileage, and GBP values are formatted for UK readers.
- [ ] Equipment starts at 12 unique items and expands/collapses accessibly.
- [ ] Loading and error content stay inside the report shell and errors reveal no provider diagnostics.
- [ ] Mobile layout has no page-level horizontal overflow, while the MOT table owns its narrow-screen scroll.
- [ ] Printing hides site chrome/actions and removes report decoration.
- [ ] Focused tests, TypeScript validation, production build, and `git diff --check` pass.
