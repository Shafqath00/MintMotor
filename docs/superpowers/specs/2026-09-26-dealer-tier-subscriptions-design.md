# Mint Motor dealer tier subscriptions

## Goal

Sell recurring monthly dealer subscriptions that set enforceable allowances for active Dealer Network listings and featured Dealer Network listings.

## Tier catalogue

| Tier | Active listings | Featured listings | Monthly price |
|---|---:|---:|---:|
| Starter | 10 | 2 | £99 |
| Growth | 17 | 3 | £170 |
| Scale | 25 | 4 | £250 |
| Pro | 35 | 5 | £350 |
| Business | 50 | 9 | £500 |
| Advanced | 75 | 15 | £750 |
| Enterprise | 99 | 20 | £990 |
| 150 | 150 | 25 | £1,500 |
| 200 | 200 | 30 | £2,000 |
| 300 | 300 | 30 | £3,000 |
| 400 | 400 | 50 | £4,000 |
| 500+ | Custom | Custom | £5,000+ |

The 500+ tier is sales-led and does not offer a self-service checkout until a specific allowance and Stripe Price are configured by Mint Motor.

## Billing model

- Each self-service tier has one recurring monthly Stripe Price in GBP.
- Mint Motor uses Stripe Checkout Sessions in subscription mode to start a dealer subscription.
- Stripe webhooks are authoritative for granting, changing, renewing, cancelling, or ending entitlement. A checkout success page is informational only.
- Mint Motor stores the Stripe customer ID, subscription ID, subscription status, current period end, selected tier key, active-listing allowance, and featured-listing allowance on the dealer document.
- The portal provides a Stripe Billing Portal link for upgrades, downgrades, payment methods, invoices, and cancellation.

## Entitlement enforcement

- An approved dealer needs an active/trialing dealer subscription before publishing Dealer Network stock.
- Before publishing, the backend counts the dealer's active listings. It blocks publication when that count would exceed the tier's active-listing allowance.
- Before setting or retaining `isFeatured: true`, the backend counts active featured listings. It blocks the change when it would exceed the featured allowance.
- Editing a draft does not consume a listing allowance. Marking a listing sold, archived, or deleting it releases an active slot. Removing featured status releases a featured slot.
- Existing active dealer inventory is not silently deleted if a subscription is downgraded or becomes inactive. New publish/feature actions are blocked until usage is within the new allowance; the dealer portal shows the overage and required action.

## Dealer portal

- Add a Dealer plan page showing selected tier, monthly price, active usage, featured usage, renewal/expiry date, and subscription status.
- Dealers without an active tier see a clear publish requirement and a primary “Choose a plan” action.
- The plan-picker cards show active and featured allowances, price, and a CTA that starts Checkout for the selected tier.
- The inventory editor disables publish/featured actions when an allowance is exhausted and explains the exact limit.

## Security and operations

- Price IDs are server configuration only; the browser sends only a trusted tier key.
- The server maps tier keys to Price IDs and allowance values. It never accepts client-supplied price IDs or entitlement counts.
- Verify every Stripe webhook signature and process subscription lifecycle events idempotently.
- Use a restricted Stripe API key for server integration and retain the existing webhook secret as a managed secret.
- Do not enable automatic tax/VAT collection until Mint Motor has a confirmed tax registration and VAT number.

## Out of scope

- Normal-seller £9.99 subscriptions.
- Free normal-seller dealer-only listings.
- Usage-based overage billing.
- Dealer payout, Stripe Connect, or marketplace payment splitting.

## Validation approach

Do not run automated tests or builds under the current instruction. Validate through source review and Stripe sandbox/manual checks: checkout, webhook entitlement sync, publish limit, featured limit, cancellation, downgrade, and billing portal return.
