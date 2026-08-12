# Phone OTP Verification Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the seller phone-verification code field with an accessible six-digit OTP interaction and concise animated feedback.

**Architecture:** Reuse the existing `InputOTP` primitives and Firebase `ConfirmationResult`. `CarDetails` remains the owner of the complete OTP string; the UI component derives the six visible cells from that string. Framer Motion animates only the conditional OTP and success blocks, while Tailwind’s `motion-reduce` utilities prevent movement for users who prefer reduced motion.

**Tech Stack:** React 18, TypeScript, `input-otp`, Framer Motion, Tailwind CSS, Vitest, Testing Library.

## Global Constraints

- The confirmation code accepts digits only and must contain exactly six digits before verification can be submitted.
- Preserve the existing Firebase `confirmationResult.confirm(otp)` and verification-profile sync flow.
- Keep phone verification error messages in the existing verification notice area.
- Respect `prefers-reduced-motion`.
- Do not change Firebase settings, SMS delivery, or publication rules.

---

### Task 1: Cover the six-digit OTP contract

**Files:**
- Modify: `frontend/src/pages/Sellpages/CarDetails.test.tsx`

**Interfaces:**
- Consumes: `CarDetails` rendered with an authenticated user whose `phoneNumber` is `null`.
- Produces: Regression coverage for the six-cell OTP UI and disabled verification state.

- [ ] **Step 1: Write the failing test**

```tsx
it("keeps Verify disabled until a six-digit code is entered", async () => {
  renderCarDetails();
  // Arrange Firebase to expose the confirmation step, then render the OTP controls.
  const codeInput = await screen.findByLabelText("6-digit verification code");
  const verifyButton = screen.getByRole("button", { name: "Verify" });

  fireEvent.change(codeInput, { target: { value: "12345" } });
  expect(verifyButton).toBeDisabled();

  fireEvent.change(codeInput, { target: { value: "123456" } });
  expect(verifyButton).toBeEnabled();
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- src/pages/Sellpages/CarDetails.test.tsx`

Expected: FAIL because the current field is a plain input with no six-digit constraint or accessible OTP label.

- [ ] **Step 3: Add a success-state test**

```tsx
it("shows the phone verified confirmation after Firebase confirms the OTP", async () => {
  renderCarDetails();
  // Provide the resolved confirmation result and enter 123456.
  fireEvent.change(await screen.findByLabelText("6-digit verification code"), {
    target: { value: "123456" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Verify" }));

  expect(await screen.findByText("Mobile number verified.")).toBeInTheDocument();
});
```

- [ ] **Step 4: Run the focused test again**

Run: `npm test -- src/pages/Sellpages/CarDetails.test.tsx`

Expected: FAIL because the current confirmation UI has no dedicated success state.

- [ ] **Step 5: Commit the red tests**

```bash
git add frontend/src/pages/Sellpages/CarDetails.test.tsx
git commit -m "test: define phone OTP verification flow"
```

### Task 2: Build the six-cell OTP entry and submit guard

**Files:**
- Modify: `frontend/src/pages/Sellpages/CarDetails.tsx:1-25,99-103,329-337,719-726`
- Test: `frontend/src/pages/Sellpages/CarDetails.test.tsx`

**Interfaces:**
- Consumes: `confirmationResult: ConfirmationResult | null`, `otp: string`, and `setOtp`.
- Produces: a controlled `InputOTP` with `maxLength={6}`, `pattern={REGEXP_ONLY_DIGITS}`, accessible name `6-digit verification code`, and a Verify button disabled unless `otp.length === 6`.

- [ ] **Step 1: Import the OTP primitives and motion helpers**

```tsx
import { AnimatePresence, motion } from "framer-motion";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
```

- [ ] **Step 2: Restrict the confirmation function to complete codes**

```tsx
const confirmPhoneCode = async () => {
  setVerificationNotice("");
  if (!confirmationResult || !token || otp.length !== 6) return;
  await confirmationResult.confirm(otp);
  await syncVerificationProfile(token);
  setVerificationNotice("Mobile number verified.");
};
```

- [ ] **Step 3: Replace the single code field with the OTP control**

```tsx
<InputOTP
  maxLength={6}
  pattern={REGEXP_ONLY_DIGITS}
  value={otp}
  onChange={setOtp}
  aria-label="6-digit verification code"
  autoComplete="one-time-code"
>
  <InputOTPGroup className="gap-1.5">
    {[0, 1, 2, 3, 4, 5].map((index) => (
      <InputOTPSlot key={index} index={index} className="rounded-md border" />
    ))}
  </InputOTPGroup>
</InputOTP>
<Button type="button" disabled={otp.length !== 6} onClick={() => void confirmPhoneCode()}>
  Verify
</Button>
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npm test -- src/pages/Sellpages/CarDetails.test.tsx`

Expected: PASS. If Vitest exhausts its worker memory before tests run, record that environment failure and use the production build in Task 3 as the compile verification.

- [ ] **Step 5: Commit the OTP interaction**

```bash
git add frontend/src/pages/Sellpages/CarDetails.tsx frontend/src/pages/Sellpages/CarDetails.test.tsx
git commit -m "feat: add six-digit phone OTP entry"
```

### Task 3: Add restrained verification motion and validate the build

**Files:**
- Modify: `frontend/src/pages/Sellpages/CarDetails.tsx:719-726`
- Test: `frontend/src/pages/Sellpages/CarDetails.test.tsx`

**Interfaces:**
- Consumes: `confirmationResult` and `phoneVerified`.
- Produces: an animated OTP reveal while a code is pending, and an animated verified confirmation after success.

- [ ] **Step 1: Wrap the pending OTP block in an accessible animation**

```tsx
<AnimatePresence initial={false}>
  {confirmationResult && !phoneVerified && (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2 }}
      className="space-y-2 motion-reduce:transform-none"
    >
      {/* six-cell OTP control */}
    </motion.div>
  )}
</AnimatePresence>
```

- [ ] **Step 2: Add the compact verified confirmation**

```tsx
{phoneVerified && (
  <motion.p
    initial={{ opacity: 0, scale: 0.98 }}
    animate={{ opacity: 1, scale: 1 }}
    transition={{ duration: 0.18 }}
    className="flex items-center gap-2 text-sm font-medium text-emerald-700 motion-reduce:transform-none"
  >
    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
    Mobile number verified
  </motion.p>
)}
```

- [ ] **Step 3: Run the focused test**

Run: `npm test -- src/pages/Sellpages/CarDetails.test.tsx`

Expected: PASS, including the successful confirmation assertion.

- [ ] **Step 4: Run a production build**

Run: `npm run build`

Expected: PASS with no TypeScript or Vite errors.

- [ ] **Step 5: Commit the visual polish**

```bash
git add frontend/src/pages/Sellpages/CarDetails.tsx frontend/src/pages/Sellpages/CarDetails.test.tsx
git commit -m "feat: animate phone verification feedback"
```

## Plan self-review

- Spec coverage: Tasks 1-3 cover six digits, numeric input, paste/focus behavior through `input-otp`, disabled submission, entrance/success motion, reduced motion, and no Firebase flow changes.
- Placeholder scan: No deferred implementation placeholders are present.
- Type consistency: `otp` stays a string and continues into `ConfirmationResult.confirm(otp)` only after the six-digit guard.
