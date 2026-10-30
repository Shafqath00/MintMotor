# Mintmotor Platform Split Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the independent deliverables below. Preserve existing checkout changes; do not commit, deploy, or operate on live billing.

**Goal:** Separate buyer browsing from dealership and free private seller workflows, safely retiring paid private adverts.

**Architecture:** Retain React/Vite, shared Firebase identities, Express API, Firestore cars and dealerEnquiries collections, and existing main/dealer hosting targets. Dealership owns /dealer/* and /seller/* experiences; backend permissions remain authoritative.

**Spec:** User-approved Mintmotor Main and Dealership Platform Split in this chat.

## Global constraints
- Keep dealer.mintmotor.co.uk, current dealer tiers/approval, and existing listing IDs.
- New private adverts are free, dealer-only, owner-managed and identity-verified.
- Approved dealers may view/enquire without paying; own stock publishing remains subscription limited.
- Existing paid adverts finish their paid period; no automatic free sharing or refunds.
- Preserve all existing uncommitted work; do not push, deploy, send messages, or mutate live billing.

## Review focus
- Forged public plan/visibility/status and alternate detail/distance/enquiry paths must not leak private vehicles.
- Cross-origin login must retain only safe local continuation; sellers never inherit dealer access.
- Old download tokens and public storage objects require migration, not rules alone.
- Delayed billing events must not extend paid-through dates or affect converted free submissions.
- Retryable migration failures must remain visible and must never silently complete cutover.

## Tasks
1. Backend policy and inbox (root): add failing tests for forced private plan, identity checks, legacy paid-through eligibility, public privacy and owner dealer enquiries; implement policy helpers and integrate index.js. Preserve dealer quotas and approval checks. Verify backend tests.
2. Dealership frontend (frontend worker): test safe redirects and limited seller routing; reuse listing editors under /seller/*, free submit flow and owner offers inbox; keep legacy subscription read-only information. Verify frontend tests/build.
3. Legacy migration (migration worker): test dry-run/no writes, paid-period snapshot, cancel-at-period-end retry progress, expiry without auto-sharing, and stale-event guards. Implement helper, script and runbook; root integrates policy/webhooks/scheduler.
4. Private images (media worker): test authenticated owner/dealer image access, unpublished denial, foreign uploads, and token revocation migration. Implement isolated Express media router plus migration helper; root integrates API; frontend worker integrates protected uploads/blob rendering.
5. Integration and review (root): reconcile contracts, run full backend/frontend tests and builds, inspect access matrix, review changes and document rollout limitations. No live rollout.

## Execution ledger
- Initial checkout contains substantial existing uncommitted backend and frontend work. Reuse it as requested, without resetting or committing unrelated changes.
- Architecture defaults and product decisions are approved in the chat.
