const test = require("node:test");
const assert = require("node:assert/strict");
const { DealerEmailDeliveryError, buildDealerActivationEmail, sendDealerActivationEmail } = require("./dealerEmail");

test("activation email explains approval, self-selected password, verification, expiry, and replacement", () => {
  const email = buildDealerActivationEmail({ businessName: "Mint Cars", setupLink: "https://auth.test/setup", verificationLink: "https://auth.test/verify" });
  assert.match(email.subject, /approved/i);
  assert.match(email.text, /choose your own password/i);
  assert.match(email.text, /verify your email/i);
  assert.match(email.text, /expire/i);
  assert.match(email.text, /request a new activation link/i);
  assert.match(email.html, /Set password/);
  assert.match(email.html, /Verify email/);
});

test("escapes business names and action links in activation HTML", () => {
  const email = buildDealerActivationEmail({ businessName: "Cars <script>alert(1)</script>", setupLink: 'https://auth.test/?a="b"' });
  assert.match(email.html, /Cars &lt;script&gt;/);
  assert.doesNotMatch(email.html, /<script>/);
  assert.match(email.html, /&quot;b&quot;/);
});

test("sends activation email through Resend", async () => {
  let sent;
  await sendDealerActivationEmail({ to: "dealer@mint.test", businessName: "Mint Cars", setupLink: "https://auth.test/setup" }, {
    apiKey: "key", from: "Mint Motor <dealer@mint.test>",
    fetchImplementation: async (_url, request) => { sent = JSON.parse(request.body); return { ok: true }; },
  });
  assert.deepEqual(sent.to, ["dealer@mint.test"]);
  assert.match(sent.subject, /approved/i);
});

test("returns a delivery error when Resend rejects or cannot receive the email", async () => {
  const input = { to: "dealer@mint.test", businessName: "Mint Cars", setupLink: "https://auth.test/setup" };
  const options = { apiKey: "key", from: "Mint Motor <dealer@mint.test>" };
  await assert.rejects(sendDealerActivationEmail(input, { ...options, fetchImplementation: async () => ({ ok: false }) }), DealerEmailDeliveryError);
  await assert.rejects(sendDealerActivationEmail(input, { ...options, fetchImplementation: async () => { throw new Error("offline"); } }), DealerEmailDeliveryError);
  await assert.rejects(sendDealerActivationEmail(input, { fetchImplementation: async () => ({ ok: true }) }), DealerEmailDeliveryError);
});
