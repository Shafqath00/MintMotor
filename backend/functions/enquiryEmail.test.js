const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildEnquiryEmail,
  sendEnquiryEmail,
} = require("./enquiryEmail");

const validInput = {
  to: "seller@example.com",
  replyTo: "jamie@example.com",
  carTitle: "2024 BMW M4 <Competition>",
  carId: "car-123",
  enquiry: {
    name: "Jamie <Buyer>",
    email: "jamie@example.com",
    phone: "+44 7700 900100",
    message: "Can I view it on Saturday?",
  },
};

test("buildEnquiryEmail creates a styled, escaped seller email", () => {
  const email = buildEnquiryEmail(validInput);

  assert.equal(email.subject, "New enquiry for your 2024 BMW M4 <Competition>");
  assert.match(email.text, /Jamie <Buyer>/);
  assert.match(email.html, /MintMotor/);
  assert.match(email.html, /Jamie &lt;Buyer&gt;/);
  assert.doesNotMatch(email.html, /Jamie <Buyer>/);
  assert.match(email.html, /background-color: #0000A3/);
  assert.match(email.html, /Can I view it on Saturday\?/);
});

test("sendEnquiryEmail posts the completed message to Resend", async () => {
  const fetchImplementation = async (url, options) => {
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(options.method, "POST");
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
test("sendEnquiryEmail reports a rejected Resend delivery", async () => {
  const { EnquiryEmailDeliveryError } = require("./enquiryEmail");

  await assert.rejects(
    () => sendEnquiryEmail(validInput, {
      apiKey: "re_test",
      from: "MintMotor <enquiries@example.com>",
      fetchImplementation: async () => ({ ok: false }),
    }),
    (error) => error instanceof EnquiryEmailDeliveryError,
  );
});
