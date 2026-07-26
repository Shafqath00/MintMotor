# Publish validation focus design

## Goal

When a seller tries to publish an incomplete listing, show the existing validation alert, highlight every required field that is missing, and take the seller directly to the first missing field.

## Approach

Validation will use the same internal field keys that the form controls and error styles use (`registrationNumber`, `photos`, `price`, and so on). This corrects the existing mismatch between human-readable validation labels and the keys checked by `hasError`.

After validation state is updated, the page will find the first missing control by a stable field identifier, smoothly scroll it into view, and focus it. For the photo requirement, the upload region will be focusable and identified as the target. The alert remains visible and its wording is unchanged.

## Error handling and accessibility

All missing required fields remain highlighted. Focusing the first invalid control provides an immediate keyboard-accessible next action. If a matching control is not present in the DOM, validation still displays the alert and highlights the available fields without throwing.

## Verification

Add a regression test that submits an incomplete listing, verifies the field key is marked invalid, and verifies the first missing control receives smooth-scroll/focus handling. Run the focused test, then the frontend type check/build as appropriate.
