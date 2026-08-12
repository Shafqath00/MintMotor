# Phone OTP verification experience

## Goal

Make the seller phone-verification step easy to complete and visibly confirm by collecting a six-digit Firebase SMS code through a dedicated OTP input.

## Scope

- Show the OTP control only after Firebase reports that an SMS code was sent.
- Replace the single code field with six numeric cells.
- Advance focus after each digit; move focus back when Backspace is pressed on an empty cell.
- Support pasting a complete six-digit code into any cell.
- Enable verification only when all six cells contain digits.
- Animate the OTP area into view and show a brief success state after verification.
- Respect `prefers-reduced-motion`.

## Interaction design

The control has six equal, compact boxes in the existing neutral form style. Each box accepts exactly one digit and uses `inputMode="numeric"` with one-time-code autocomplete support. A small helper line says that the code contains six digits.

When the code is sent, the OTP row fades and rises into place once. On success, the form replaces the OTP row with a compact green confirmation containing a check icon. Error feedback stays in the existing verification notice area.

## Data flow

The six cells compose one string passed to the existing Firebase `confirmationResult.confirm(code)` call. No API, authentication, or persistence changes are required.

## Testing

- Input accepts only digits and a maximum of six digits.
- Typing advances focus and Backspace moves focus to the previous cell.
- Pasting distributes six digits across the cells.
- The Verify button remains disabled until six digits are present.

## Non-goals

- Changing Firebase configuration or the SMS send flow.
- Adding a resend timer or retry quota.
- Changing seller publication requirements.
