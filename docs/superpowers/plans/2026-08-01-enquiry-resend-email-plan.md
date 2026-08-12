# Enquiry Resend Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver every accepted public-car enquiry to its seller through a styled Resend email while keeping the enquiry record in Firestore.

**Architecture:** A focused `enquiryEmail.js` module builds escaped plain-text and HTML email bodies and sends them through Resend's REST API. The existing Express route validates the listing and buyer input, rejects unavailable recipients and disabled enquiries, invokes that module, and only then writes the existing Firestore record.

**Tech Stack:** Node.js 22, Firebase Functions v2, Express, native `fetch`, Node test runner.

## Global Constraints

- Keep Resend credentials server-only: `RESEND_API_KEY` and `RESEND_FROM_EMAIL`.
- Send only to `car.contactEmail` or its `ownerEmail` fallback; never accept a recipient from the browser.
- Preserve the existing public form, API path, response shape, and Firestore enquiry schema.
- Include a plain-text fallback alongside the inline-style, table-based HTML template.
- Escape all buyer and listing text before placing it into HTML.

---

### Task 1: Add an isolated Resend email builder and sender

**Files:**
- Create: `backend/functions/enquiryEmail.js`
- Test: `backend/functions/enquiryEmail.test.js`

**Interfaces:**
- Produces `buildEnquiryEmail({ carTitle, carId, enquiry })`, returning `{ subject, text, html }`.
- Produces `sendEnquiryEmail({ to, replyTo, carTitle, carId, enquiry }, { apiKey, from, fetchImplementation })`, which resolves on a Resend 2xx response and throws `EnquiryEmailDeliveryError` otherwise.

- [ ] **Step 1: Write failing email-template tests**

```js
test("buildEnquiryEmail creates a styled, escaped seller email", () => {
  const email = buildEnquiryEmail({
    carTitle: '2024 BMW M4 <Competition>',
    carId: "car-123",
    enquiry: {
      name: "Jamie <Buyer>",
      email: "jamie@example.com",
      phone: "+44 7700 900100",
      message: "Can I view it on Saturday?",
    },
  });

  assert.equal(email.subject, "New enquiry for your 2024 BMW M4 <Competition>");
  assert.match(email.text, /Jamie <Buyer>/);
  assert.match(email.html, /MintMotor/);
  assert.match(email.html, /Jamie &lt;Buyer&gt;/);
  assert.doesNotMatch(email.html, /Jamie <Buyer>/);
  assert.match(email.html, /background-color: #0000A3/);
});

test("sendEnquiryEmail posts the completed message to Resend", async () => {
  const fetchImplementation = async (url, options) => {
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(options.headers.Authorization, "Bearer re_test");
    const payload = JSON.parse(options.body);
    assert.equal(payload.from, "MintMotor <enquiries@example.com>");
    assert.deepEqual(payload.to, ["seller@example.com"]);
    assert.deepEqual(payload.reply_to, ["jamie@example.com"]);
    assert.match(payload.html, /New enquiry/);
    return new Response(JSON.stringify({ id: "email-123" }), { status: 200 });
  };

  await sendEnquiryEmail(validInput, {
    apiKey: "re_test",
    from: "MintMotor <enquiries@example.com>",
    fetchImplementation,
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- enquiryEmail.test.js`

Expected: FAIL because `enquiryEmail.js` does not exist.

- [ ] **Step 3: Implement the minimal builder and sender**

```js
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
}

async function sendEnquiryEmail(input, { apiKey, from, fetchImplementation = fetch }) {
  if (!apiKey || !from) throw new EnquiryEmailDeliveryError("Resend is not configured.");
  const email = buildEnquiryEmail(input);
  const response = await fetchImplementation("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [input.to], reply_to: [input.replyTo], ...email }),
  });
  if (!response.ok) throw new EnquiryEmailDeliveryError("Resend rejected the enquiry email.");
}
```

Use `buildEnquiryEmail` to create an inline-style table layout with the MintMotor navy `#0000A3` header, an enquiry summary heading, labelled buyer details, a message block, and a reply instruction. Return an equivalent plain-text body.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npm test -- enquiryEmail.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/functions/enquiryEmail.js backend/functions/enquiryEmail.test.js
git commit -m "feat: add Resend enquiry email template"
```

### Task 2: Deliver accepted enquiries from the existing endpoint

**Files:**
- Modify: `backend/functions/index.js:1-25,812-849`
- Test: `backend/functions/enquiryEmail.test.js`

**Interfaces:**
- Consumes `sendEnquiryEmail` and `EnquiryEmailDeliveryError` from `enquiryEmail.js`.
- Produces `201 { id, ok: true }` only after Resend accepts the email and Firestore writes the enquiry record.

- [ ] **Step 1: Write failing sender-failure tests**

```js
test("sendEnquiryEmail reports a rejected Resend delivery", async () => {
  await assert.rejects(
    () => sendEnquiryEmail(validInput, {
      apiKey: "re_test",
      from: "MintMotor <enquiries@example.com>",
      fetchImplementation: async () => new Response("invalid sender", { status: 422 }),
    }),
    (error) => error instanceof EnquiryEmailDeliveryError,
  );
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- enquiryEmail.test.js`

Expected: FAIL because the sender does not yet turn non-2xx responses into `EnquiryEmailDeliveryError`.

- [ ] **Step 3: Integrate delivery into the enquiry route**

```js
const { EnquiryEmailDeliveryError, sendEnquiryEmail } = require("./enquiryEmail");

const sellerEmail = String(car.contactEmail || car.ownerEmail || "").trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sellerEmail)) {
  res.status(422).json({ error: "This listing cannot receive enquiry emails." });
  return;
}
if (car.allowEnquiries === false) {
  res.status(409).json({ error: "This listing is not accepting enquiries." });
  return;
}
try {
  await sendEnquiryEmail({ to: sellerEmail, replyTo: enquiry.email, carTitle, carId: req.params.id, enquiry }, {
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM_EMAIL,
  });
} catch (error) {
  if (error instanceof EnquiryEmailDeliveryError) {
    res.status(502).json({ error: "Unable to deliver enquiry email." });
    return;
  }
  throw error;
}
```

Define `carTitle` once so the email and Firestore record use exactly the same title. Keep the existing outer catch for unexpected failures and write the Firestore record after delivery succeeds.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npm test -- enquiryEmail.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/functions/index.js backend/functions/enquiryEmail.test.js
git commit -m "feat: email car enquiries to sellers"
```

### Task 3: Document server configuration and verify the feature

**Files:**
- Modify: `backend/functions/.env.example` (create it if no example file exists)
- Verify: `backend/functions/enquiryEmail.test.js`, `backend/functions/*.test.js`, `frontend/src/components/cars/CarContactCard.test.tsx`

**Interfaces:**
- Documents `RESEND_API_KEY` and `RESEND_FROM_EMAIL` without adding secrets to the repository.

- [ ] **Step 1: Add non-secret configuration placeholders**

```env
# Resend sender domain must be verified in the Resend account.
RESEND_API_KEY=re_replace_with_your_key
RESEND_FROM_EMAIL=MintMotor <enquiries@your-verified-domain.example>
```

- [ ] **Step 2: Run backend tests**

Run: `npm test`

Working directory: `backend/functions`

Expected: PASS with zero failed tests.

- [ ] **Step 3: Run the existing frontend enquiry-card regression test**

Run: `npm test -- CarContactCard.test.tsx`

Working directory: `frontend`

Expected: PASS; the client request and success/error UI remain unchanged.

- [ ] **Step 4: Run the frontend production build**

Run: `npm run build`

Working directory: `frontend`

Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add backend/functions/.env.example
git commit -m "docs: configure Resend enquiry delivery"
```