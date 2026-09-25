# Mint Motor seller listing plan choice

## Goal

Let every normal Mint Motor seller choose how to publish a vehicle: a paid monthly public Mint Motor listing or a free dealer-only trade listing.

## Seller choices

### Mint Motor monthly plan

- The listing is public and appears in normal Mint Motor search, cards, and public vehicle detail routes.
- Publishing requires the existing Mint Motor seller subscription and Stripe checkout flow.
- The current subscription requirements and public enquiry experience remain unchanged.

### Free dealer-only plan

- The listing is free for every normal seller; it does not start or require a subscription.
- The listing is visible only to approved dealers in the Dealer Network.
- It is excluded from public listing/search/detail responses and cannot be opened through public vehicle routes.
- Approved dealers can send trade enquiries and offers through the existing dealer enquiry flow.

## Data model and publishing rules

Use the existing `cars` collection and the existing `visibility` field; do not introduce a second listing collection or a new billing product.

- Public plan drafts save `visibility: "public"` and retain the existing `sellerType: "private"` ownership model.
- Free dealer-only drafts save `visibility: "dealer-network"`, retain `sellerType: "private"`, and record `listingPlan: "dealer-network-free"` for explicit UI and audit state.
- Paid public drafts record `listingPlan: "public-subscription"`.
- The backend, not the browser, validates the selected plan, controls visibility, and decides whether an active subscription is required.
- Both plans use the same vehicle lookup, images, listing validation, publish-time vehicle-history refresh, and owner permissions.

## Seller experience

After the seller selects or creates a vehicle, show a focused two-card plan choice before the listing editor:

1. **Mint Motor monthly plan** — public audience, existing subscription price/copy, primary action to continue to subscription when required.
2. **Free dealer-only plan** — £0, approved dealers only, trade offers, no public advert, primary action to continue free.

The saved plan selection appears in the listing editor's publish section. A seller can change the plan while the listing is still a draft. The editor clearly explains whether publication will trigger the subscription flow or publish to the private Dealer Network without payment.

## Dealer experience

Dealer Network results include both dealer-owned stock and seller-owned free dealer-only listings. Cards identify seller-owned trade opportunities without exposing private seller contact details or dealer-only fields.

Dealer detail uses the same vehicle gallery, facts, history, and dealer enquiry interface. The seller receives the resulting trade enquiry through the existing protected enquiry workflow. Dealer-owned stock keeps its existing trade-price and internal-note behaviour; a seller-owned dealer-only vehicle does not receive dealer trade-price or notes fields.

## Security and access

- Public APIs continue to filter out every `visibility: "dealer-network"` vehicle.
- Dealer Network APIs require an approved dealer and return only safe shared listing fields for seller-owned vehicles.
- Only the owning seller can edit, change plan, publish, or delete their own listing.
- A free dealer-only listing never grants dealer access to the seller's account, private profile, or unpublished data.
- The server does not accept client-supplied ownership or status fields.

## Out of scope

- A new Stripe product for the free plan.
- Making dealer-only listings public later without a seller plan change and normal publish validation.
- Changing dealer approval, dealer subscriptions, activation email, or the paused custom Firebase email-action handler.

## Validation approach

Do not run automated tests or builds under the current instruction. Validate with focused source review and a manual journey covering: public-plan subscription redirect, free-plan publication without payment, public API exclusion, approved-dealer visibility, and dealer offer submission.
