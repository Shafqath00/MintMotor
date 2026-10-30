# Mint Motor Custom Firebase Email Action Handler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a branded, live Mint Motor page for Firebase password-reset and email-verification links.

**Architecture:** A new public React route parses Firebase's one-time email action parameters and uses the existing client `auth` instance to verify, reset, or verify an email. Firebase remains the authority for action-code validation and password mutation; the frontend never sends passwords to the backend. The existing Hosting SPA rewrite serves the new route, while Firebase Authentication email templates are pointed to the deployed handler.

**Tech Stack:** React 18, TypeScript, React Router 6, Firebase Web SDK 12, Tailwind CSS, Firebase Hosting.

**Spec:** `docs/superpowers/specs/2026-09-25-mint-motor-auth-action-design.md`

## Global Constraints

- Use `https://mintmotor.web.app/auth/action` as the Firebase email-template action URL.
- Keep all password operations in Firebase Authentication's Web SDK; do not add a backend password endpoint.
- Return successful actions to `/dealer/login`; do not trust or redirect to arbitrary continuation URLs.
- Preserve the existing approved-dealer and verified-email route checks.
- Do not run automated tests, per the user's instruction.

## Review Focus

- Missing `mode` or `oobCode` must show an actionable invalid-link screen and never call Firebase.
- An expired, malformed, or already-used reset/verification code must show a safe retry message.
- Password mismatch must be blocked locally before `confirmPasswordReset` runs.
- A weak password rejected by Firebase must leave the form usable and show Firebase's safe error text.
- A completed reset or verification must only send the user to `/dealer/login`, even if the incoming URL includes another `continueUrl`.

---

### Task 1: Build the branded Firebase email-action page

**Files:**
- Create: `frontend/src/pages/auth/FirebaseEmailAction.tsx`
- Modify: `frontend/src/App.tsx:38-98`

**Interfaces:**
- Consumes: `auth` from `@/lib/firebase`; `verifyPasswordResetCode`, `confirmPasswordReset`, and `applyActionCode` from `firebase/auth`; `useSearchParams` and `Link` from `react-router-dom`.
- Produces: public route component `<FirebaseEmailAction />` at `/auth/action`.

- [ ] **Step 1: Add the email-action component with explicit states**

Create `FirebaseEmailAction.tsx` with a discriminated UI state of `loading | reset | verify | success | error`. Read `mode` and `oobCode` from `useSearchParams`. On mount, require a non-empty code; call `verifyPasswordResetCode(auth, oobCode)` for `resetPassword`, and expose a verification confirmation screen for `verifyEmail`. For any other mode, set the error state without calling Firebase.

```tsx
const mode = searchParams.get("mode");
const oobCode = searchParams.get("oobCode");

if (!oobCode || (mode !== "resetPassword" && mode !== "verifyEmail")) {
  setView({ kind: "error", message: "This account link is invalid or incomplete." });
}
```

- [ ] **Step 2: Implement secure Firebase actions**

For reset mode, render password and confirmation fields, enforce matching values before submission, then call `confirmPasswordReset(auth, oobCode, password)`. For verification mode, call `applyActionCode(auth, oobCode)` only from the confirmation button. Map Firebase failures to user-safe copy without logging the code or password.

```tsx
await confirmPasswordReset(auth, oobCode, password);
setView({ kind: "success", title: "Password set", message: "You can now sign in to your dealer account." });

await applyActionCode(auth, oobCode);
setView({ kind: "success", title: "Email verified", message: "Your email address is confirmed." });
```

- [ ] **Step 3: Apply the Mint Motor dealer-access design**

Use a pale neutral full-page background, a compact dark-blue Mint Motor wordmark header, a white max-width card, and a 4px left status rail. Use `ShieldCheck`, `KeyRound`, `MailCheck`, `AlertCircle`, and `ArrowRight` from `lucide-react` for action states. Use the existing `Button` and `Input` components, labelled inputs, visible focus states, and `aria-live="polite"` for status content. The primary copy is: `Set your dealer password`, `Verify your email`, `Password set`, and `Email verified`.

- [ ] **Step 4: Register the route before the catch-all route**

In `App.tsx`, import the new component and add:

```tsx
<Route path="/auth/action" element={<FirebaseEmailAction />} />
```

Place it before `<Route path="*" element={<NotFound />} />`.

- [ ] **Step 5: Inspect the changed source without running tests**

Run:

```powershell
git -C frontend diff --check -- src/pages/auth/FirebaseEmailAction.tsx src/App.tsx
```

Expected: no whitespace errors. Do not run `npm test` or `vitest`.

- [ ] **Step 6: Commit the frontend handler**

```powershell
git -C frontend add src/pages/auth/FirebaseEmailAction.tsx src/App.tsx
git -C frontend commit -m "feat: add branded Firebase email action page"
```

### Task 2: Make the deployed activation continuation explicit

**Files:**
- Modify: `backend/functions/.env`
- Modify: `backend/functions/.env.example`

**Interfaces:**
- Consumes: `DEALER_ACTIVATION_CONTINUE_URL` in `backend/functions/index.js`.
- Produces: a deployed continuation URL of `https://mintmotor.web.app/dealer/login` for reset and verification links generated during dealer approval.

- [ ] **Step 1: Add the live continuation URL locally and document it**

Add the following non-secret setting to the local Functions environment file and its example file:

```env
DEALER_ACTIVATION_CONTINUE_URL=https://mintmotor.web.app/dealer/login
```

This avoids relying on the `https://mintmotor.co.uk` fallback while preserving the existing `getFrontendUrl` implementation.

- [ ] **Step 2: Inspect configuration without exposing secrets**

Run:

```powershell
Get-Content backend/functions/.env | Where-Object { $_ -match '^DEALER_ACTIVATION_CONTINUE_URL=' }
```

Expected: exactly the hosted dealer-login URL. Do not print other environment values.

- [ ] **Step 3: Commit only the non-secret example documentation**

```powershell
git add backend/functions/.env.example
git commit -m "docs: configure dealer activation continuation URL"
```

Do not commit `backend/functions/.env`.

### Task 3: Deploy and point Firebase Authentication at the handler

**Files:**
- Modify externally: Firebase Hosting deployment for site `mintmotor`
- Modify externally: Firebase Authentication Password reset and Email address verification template action URLs

**Interfaces:**
- Consumes: built frontend with `/auth/action` and Firebase project `jellylabsprojects`.
- Produces: branded action links in all future dealer activation and reset emails.

- [ ] **Step 1: Build and deploy the frontend hosting site**

From `frontend`:

```powershell
npm run build
firebase deploy --only hosting:mintmotor
```

Expected: `https://mintmotor.web.app/auth/action` serves the application rather than the Not Found page.

- [ ] **Step 2: Deploy Functions with the explicit continuation environment**

From `backend/functions`:

```powershell
firebase deploy --only functions:mintapi
```

Expected: the next deployed `mintapi` revision includes `DEALER_ACTIVATION_CONTINUE_URL` and still uses `jellylabsprojects`.

- [ ] **Step 3: Configure both Firebase Authentication templates**

In Firebase Console for `jellylabsprojects`, open **Authentication → Templates**. Set the action URL for both **Password reset** and **Email address verification** to:

```text
https://mintmotor.web.app/auth/action
```

Save each template. Keep `mintmotor.web.app` in Authentication → Settings → Authorized domains.

- [ ] **Step 4: Perform the live smoke flow without automated tests**

Use the existing approved dealer's **Resend activation** control. Confirm that the password link opens the Mint Motor set-password screen, the verification link opens the Mint Motor verification screen, and each successful state offers a route to `/dealer/login`. Do not run automated tests.

- [ ] **Step 5: Commit deployment-related tracked files only**

```powershell
git status --short
git add frontend/firebase.json backend/functions/.env.example
git commit -m "chore: prepare branded Firebase email actions"
```

Only stage files intentionally changed for this feature; do not stage existing unrelated working-tree changes.

## Self-review

- Spec coverage: Task 1 implements the public handler, reset and verification actions, error states, and Mint Motor visual design. Task 2 sets the known dealer-login return URL. Task 3 deploys the handler and updates Firebase template configuration.
- Placeholder scan: no unfinished implementation markers are present.
- Type consistency: `FirebaseEmailAction` is the component imported by `App.tsx`; all Firebase functions consume `auth`, `oobCode`, and password strings as documented.
- Review focus coverage: Task 1 handles missing/invalid parameters, Firebase failures, password mismatch, weak-password errors, and a fixed dealer-login destination. Task 3 checks the user-visible live paths.
