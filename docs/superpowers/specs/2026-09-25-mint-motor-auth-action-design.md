# Mint Motor custom Firebase email action handler

## Goal

Replace Firebase Authentication's stock hosted password-reset and email-verification pages with a branded Mint Motor page while preserving Firebase's one-time action-code security model.

## Scope

- Add a public frontend route at `/auth/action`.
- Accept Firebase email-action query parameters: `mode`, `oobCode`, and optional `continueUrl`.
- Handle `resetPassword` by validating the action code, collecting and confirming a new password, then calling Firebase `confirmPasswordReset`.
- Handle `verifyEmail` by calling Firebase `applyActionCode` and confirming the result.
- Show explicit safe states for invalid, expired, missing, or already-used links.
- Return users to `/dealer/login` after a successful action. Do not automatically grant dealer dashboard access; the existing authentication and approval checks remain authoritative.
- Deploy the frontend to `https://mintmotor.web.app`, then set that route as the action URL for Firebase Authentication's Password reset and Email verification templates.

## Design

The page is a focused Mint Motor dealer-account screen: a deep blue branded header, compact dealer-access label, generous white card, clear task title, and one primary action. It uses the existing application typography and Tailwind component conventions. The signature detail is a narrow blue status rail along the card that changes tone with the operation state rather than adding decorative imagery.

## Security and behavior

- The Firebase SDK performs every code verification and mutation; no reset code or password is sent to the backend.
- Passwords are never logged or stored outside Firebase Authentication.
- The handler does not trust arbitrary `continueUrl` destinations. Successful actions return to the known dealer-login route.
- Firebase's Authorized domains configuration continues to constrain which action and continuation domains may be used.

## Operational configuration

After deployment, configure both Firebase Authentication email templates to use:

`https://mintmotor.web.app/auth/action`

The backend activation flow continues to generate the password-reset and verification links and send them through Resend.
