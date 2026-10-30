# MinitMotort Backend

This directory contains the backend for the MinitMotort application, built with Firebase Cloud Functions and Node.js.

## Prerequisites

- Node.js (v22 or later recommended)
- Firebase CLI (`npm install -g firebase-tools`)

## Project Structure

- `firebase.json`: Firebase configuration file specifying hosting and function deployment settings.
- `.firebaserc`: Firebase project aliases.
- `functions/`: Directory containing the backend source code.

## Local Development

To run the backend locally using the Firebase emulator:

1. Navigate to the `functions` directory:
   ```sh
   cd functions
   ```

2. Install dependencies:
   ```sh
   npm install
   ```

3. Start the Firebase emulator:
   ```sh
   npm run serve
   ```

## Deployment

To deploy the backend to Firebase:

1. Make sure you are authenticated with Firebase:
   ```sh
   firebase login
   ```

2. Navigate to the `functions` directory (if not already there):
   ```sh
   cd functions
   ```

3. Deploy the functions:
   ```sh
   npm run deploy
   ```
# Dealer activation configuration

Dealer approval emails require these backend environment values:

```text
RESEND_API_KEY
RESEND_FROM_EMAIL
DEALER_ACTIVATION_CONTINUE_URL=https://mintmotor.co.uk/dealer/login
```

The Resend sender domain must be verified. Firebase Authentication must allow
`mintmotor.co.uk` for password-reset and email-verification action links.

## Stripe subscription release configuration

Configure `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` as Firebase secrets, and configure `FRONTEND_URL` to the approved HTTPS site origin. Set `STRIPE_SELLER_PRICE_ID` to an active live Stripe Price for £10.00 GBP recurring every one calendar month. Set every self-service `STRIPE_DEALER_*_PRICE_ID` to an active live GBP calendar-month Price in that same Stripe account. Do not enable Stripe Tax or `automatic_tax` until MINTMOTOR LTD has made the necessary tax-registration decision.

Before a live release, use Stripe test/live mode to check Checkout, signed webhooks, cancellation through Customer Portal, a failed payment, and the return URLs. Obtain UK solicitor approval of the published policy copy and an accounting/tax review of the VAT position before making paid services public.

Dealer Firestore data is stored in the named `mintmotor` database; the same
deny-by-default rules are also assigned to `(default)`. Storage rules check a
`storageDealerStatus/{uid}` mirror in `(default)` and require Storage-to-Firestore
access to be enabled for the Firebase project before those rules can authorize
dealer uploads.
