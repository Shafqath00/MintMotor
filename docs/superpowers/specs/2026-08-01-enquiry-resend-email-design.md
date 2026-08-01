# Enquiry Email Delivery with Resend

## Goal

When a buyer submits the existing public enquiry form for a published car, deliver that enquiry to the seller by email using Resend while preserving the existing Firestore enquiry record and user experience.

## Scope

- Keep the `CarDetail` page and `CarContactCard` form, client validation, success state, and request route unchanged.
- Extend `POST /cars/:id/enquiries` to email the seller after validating the listing and buyer payload.
- Send to the listing's `contactEmail`, falling back to `ownerEmail` when no contact email is available.
- Include the car title, listing identifier, buyer name, email, optional phone, and message in a plain-text email.
- Set the buyer email as the email `reply_to` field so a seller can respond directly.
- Continue storing successful enquiries with their current metadata in Firestore.
- Configure Resend with server-only `RESEND_API_KEY` and `RESEND_FROM_EMAIL` variables.

## Non-goals

- No client-side Resend integration or secret exposure.
- No email template redesign, buyer confirmation email, queue, retry system, or changes to direct phone/email links.
- No changes to the enquiry form fields or its visual design.

## Design

The browser continues to submit to the existing backend endpoint. The backend remains the authority for validating both the listing state and enquiry payload. It resolves the seller destination only from the stored listing, never from client input.

The endpoint will reject unavailable, sold, and enquiry-disabled listings before it attempts delivery. It will also return a controlled server error if either Resend environment variable is missing or if Resend rejects the send. The public client already displays the returned error message through the form's existing error state.

For a valid request, the backend sends a Resend email using the REST API with the configured sender, seller recipient, buyer reply-to email, clear subject line, and a safely constructed plain-text body. After Resend accepts the message, the endpoint writes the current Firestore enquiry record and returns its id. This ordering avoids recording an enquiry as successfully delivered when the provider rejects it.

## Data Flow

`CarContactCard` -> `sendEnquiry` -> `POST /cars/:id/enquiries` -> validate listing and buyer payload -> resolve seller email -> Resend -> Firestore `enquiries` -> `201 { id, ok: true }`.

## Error Handling

- Missing or invalid seller destination: return a 422 response; no email or Firestore record is created.
- Missing Resend configuration or rejected provider request: return a 502 response with `Unable to deliver enquiry email.`; no Firestore record is created.
- Firestore write failure after provider acceptance: return the existing generic server error and log the failure. This rare non-atomic outcome may deliver an email without a dashboard record; the seller still receives the buyer's details.

## Testing

- Unit-test the email request builder/sender with a mocked `fetch`, asserting recipient, reply-to, subject, and plain-text body fields.
- Assert a rejected Resend response becomes the controlled delivery failure.
- Retain the existing frontend card test that verifies a valid enquiry invokes the API client and displays the success state.
- Run the backend function tests, focused frontend contact-card tests, and frontend production build.

## Configuration

Set these server-side variables before deployment:

```env
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=MintMotor <enquiries@your-verified-domain.example>
```

`RESEND_FROM_EMAIL` must use a domain verified in the Resend account. Neither setting belongs in the frontend environment.
