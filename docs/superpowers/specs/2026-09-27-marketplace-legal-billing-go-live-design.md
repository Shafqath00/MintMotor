# Mintmotor legal and billing go-live design

## Status

Approved design for implementation planning. This document is a product and
engineering specification, not legal advice. A UK solicitor must review the
customer-facing policy text before production launch.

## Product scope

Mintmotor is a marketplace. Private sellers and dealers create vehicle
listings, and buyers contact those sellers directly. Mintmotor does not sell
the advertised vehicles, become a party to a vehicle sale, or process vehicle
sale payments in this release.

The legal entity displayed throughout the product is:

> MINTMOTOR LTD (company number 14142260), 122/6 Wicker, Sheffield, England,
> S3 8JD. Support and cancellation contact: worldcomponents.it@gmail.com.

The product serves both consumers and businesses. Consumer-facing safeguards
therefore apply to the public seller subscription flow even where dealers use
the same site.

## Subscription decisions

### Private public-seller plan

* Price: £10 per calendar month.
* Service: publishing public marketplace adverts; drafting/editing remains
  free.
* Renewal: automatic until cancelled.
* Access: begins immediately after successful payment.
* Checkout: show the plan, price, monthly renewal cadence, cancellation route,
  marketplace role, policy links, and legal identity before payment.
* Consent: require an unticked acknowledgement requesting immediate provision
  of the service and explaining the applicable cancellation/refund position.
* Cancellation: offer a simple, account-accessible route through Stripe
  Customer Portal. Normally retain paid access to the end of the current paid
  period, subject to statutory rights and any solicitor-approved refund rules.

### Dealer Network plans

* Each published dealer tier is a recurring monthly Stripe subscription.
* Each tier has its own Stripe Product and monthly Stripe Price. A Price must
  come from the same Stripe account and mode as the deployed API key.
* The published monthly price, Stripe Price interval, Checkout summary, and
  invoice must agree exactly.
* Dealer access and active/featured listing allowances are controlled by
  verified subscription state.

### Tax

Stripe Tax and `automatic_tax` remain disabled for this release. The policy
must not describe prices as VAT-inclusive while Mintmotor is not VAT
registered. The business must monitor taxable turnover and reassess VAT
registration and Stripe Tax separately.

## Customer-facing legal content

Add permanently accessible pages and footer links for:

1. Terms of Use.
2. Marketplace Rules and Listing Standards.
3. Seller and Dealer Subscription Terms.
4. Privacy Notice.
5. Cookie Notice and consent preferences.
6. Refunds and Cancellation Policy.
7. Complaints and listing-reporting process.

All subscription and marketplace policies must state that Mintmotor provides
the platform only; information, condition, availability, ownership, and the
vehicle sale itself remain the seller's responsibility. Policies must avoid
attempting to exclude non-excludable consumer rights.

Subscription terms must clearly cover price, calendar-month cadence,
auto-renewal, immediate access request, cancellation route, failed-payment
outcomes, current-period access, refunds, policy changes, complaints, and the
applicable law/jurisdiction wording approved by counsel.

## Privacy, cookies, and marketplace safety

The Privacy Notice will name Mintmotor as data controller and accurately
describe the services used for the current product:

* Stripe for payment and subscription processing.
* Firebase and Google Cloud for authentication, data storage, and hosting.
* Resend for transactional email.

It will describe the account, listing, enquiry, payment-reference, support,
security, and moderation data that the service handles; its purposes;
recipients; retention; users' rights; and the contact route above.

Non-essential analytics and marketing technologies must not run until the user
gives consent. Strictly necessary security and session technologies remain
available. Consent can be withdrawn through a persistent preference route.

Add a visible Report Listing action and a complaints route. Reports create a
reviewable record. Mintmotor may investigate, remove content, suspend access,
or request more information, while making clear it does not adjudicate or
guarantee the underlying private vehicle transaction.

Sellers and dealers must attest that they are entitled to list the vehicle and
that their description, price, images, and claims are accurate and lawful.

## Technical architecture

### Legal content and acceptance

Use a shared legal-details source for business identity, policy effective date,
policy URLs, and support contact. Store a versioned acceptance record whenever
a user starts a paid subscription. The record includes user ID, policy version,
accepted timestamp, immediate-service acknowledgement, subscription type, and
the Checkout Session ID once available.

### Billing

Keep Checkout Sessions in subscription mode and let Stripe select eligible
payment methods. Add an authenticated Customer Portal endpoint which looks up
the caller's own Stripe customer ID and returns a portal session URL; no caller
may access another customer's billing portal.

Protect Stripe webhooks with signature verification and process events
idempotently. The backend is the source of truth for access, not the Checkout
success page. Handle checkout completion, asynchronous payment success,
subscription creation/update/deletion, paid invoices, and failed invoices.
Subscription access transitions must be auditable and safely retryable.

### Error handling

Missing, invalid, inactive, wrong-account, or wrong-mode Price IDs must return
a safe configuration error to the client and a diagnostic server log that names
the configuration key but never exposes secrets. A failed payment should give
the subscriber a useful account message and Customer Portal route; it must not
silently leave paid publishing active indefinitely.

### Moderation and complaints

Authenticated users can submit a report against a listing. Persist reporter,
listing, category, description, timestamp, and review status. Keep staff review
actions and their rationale in an audit trail. The public policy supplies the
support contact and expected handling route.

## Verification and release gates

Automated tests must cover:

* Required checkout acknowledgement and versioned acceptance persistence.
* Customer Portal ownership checks.
* Idempotent processing of valid Stripe events.
* Subscription cancellation and paid-period access behaviour.
* Failed-payment restriction behaviour.
* Safe response for invalid dealer or seller Price configuration.
* Authorisation and persistence for listing reports/complaints.
* Consent-first loading for non-essential cookies.

Before launch, perform the following live-mode checks with non-production
customer data:

1. Use a live Stripe Price with a calendar-month interval for every published
   plan and deploy only the matching live restricted/secret key configuration.
2. Complete a live Checkout subscription and confirm the receipt, terms,
   account status, and listing access agree.
3. Confirm signed webhooks update subscription state exactly once.
4. Cancel through Customer Portal and confirm the customer receives a
   cancellation acknowledgement and access follows the documented rule.
5. Exercise a failed renewal/payment-method update scenario.
6. Check policy/footer links, cookie-consent behaviour, mobile layout, and
   accessibility.
7. Obtain UK solicitor approval of the policy text and business-specific legal
   position before publication.

## External compliance references

* UK Consumer Contracts Regulations information and electronic order rules:
  https://www.legislation.gov.uk/uksi/2013/3134
* UK subscription-contract cancellation requirements:
  https://www.legislation.gov.uk/ukpga/2024/13/part/4/chapter/2/enacted
* ICO privacy-notice and cookie guidance:
  https://ico.org.uk/for-organisations/advice-for-small-organisations/privacy-notices-and-cookies/cookies-and-privacy-notices-in-detail/
* HMRC VAT registration guidance:
  https://www.gov.uk/register-for-vat
