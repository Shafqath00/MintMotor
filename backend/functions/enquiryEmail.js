class EnquiryEmailDeliveryError extends Error {}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}

function formatMessageHtml(message) {
  return escapeHtml(message).replace(/\r?\n/g, "<br>");
}

function buildEnquiryEmail({ carTitle, carId, enquiry }) {
  const title = String(carTitle || "your vehicle").trim();
  const phone = enquiry.phone ? `\nPhone: ${enquiry.phone}` : "";
  const phoneRow = enquiry.phone
    ? `<tr><td style="padding: 0 0 12px; color: #525252; font-size: 14px; font-weight: 600;">Phone</td><td style="padding: 0 0 12px; color: #171717; font-size: 14px;">${escapeHtml(enquiry.phone)}</td></tr>`
    : "";

  return {
    subject: `New enquiry for your ${title}`,
    text: `New enquiry for your ${title}\n\nBuyer: ${enquiry.name}\nEmail: ${enquiry.email}${phone}\nListing ID: ${carId}\n\nMessage:\n${enquiry.message}\n\nReply directly to this email to contact ${enquiry.name}.`,
    html: `<!doctype html>
<html lang="en">
  <body style="margin: 0; padding: 0; background-color: #F5F5F3; font-family: Arial, Helvetica, sans-serif; color: #171717;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #F5F5F3;">
      <tr><td align="center" style="padding: 32px 16px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 600px; background-color: #FFFFFF; border: 1px solid #E5E5E5; border-radius: 16px; overflow: hidden;">
          <tr><td style="background-color: #0000A3; padding: 24px 28px; color: #FFFFFF; font-size: 24px; font-weight: 700; letter-spacing: -0.4px;">MintMotor</td></tr>
          <tr><td style="padding: 28px;">
            <p style="margin: 0 0 8px; color: #525252; font-size: 13px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase;">New enquiry from a buyer</p>
            <h1 style="margin: 0 0 22px; color: #171717; font-size: 24px; line-height: 32px;">${escapeHtml(title)}</h1>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 22px;">
              <tr><td style="padding: 0 0 12px; color: #525252; font-size: 14px; font-weight: 600; width: 92px;">Buyer</td><td style="padding: 0 0 12px; color: #171717; font-size: 14px;">${escapeHtml(enquiry.name)}</td></tr>
              <tr><td style="padding: 0 0 12px; color: #525252; font-size: 14px; font-weight: 600;">Email</td><td style="padding: 0 0 12px; color: #171717; font-size: 14px;">${escapeHtml(enquiry.email)}</td></tr>
              ${phoneRow}
              <tr><td style="padding: 0; color: #525252; font-size: 14px; font-weight: 600;">Listing ID</td><td style="padding: 0; color: #171717; font-size: 14px;">${escapeHtml(carId)}</td></tr>
            </table>
            <div style="margin: 0 0 22px; padding: 18px; background-color: #F5F5F3; border-radius: 10px; color: #262626; font-size: 15px; line-height: 23px;">${formatMessageHtml(enquiry.message)}</div>
            <p style="margin: 0; color: #525252; font-size: 14px; line-height: 21px;">Reply directly to this email to contact ${escapeHtml(enquiry.name)}.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`,
  };
}

async function sendEnquiryEmail(input, { apiKey, from, fetchImplementation = fetch }) {
  if (!apiKey || !from) {
    throw new EnquiryEmailDeliveryError("Resend is not configured.");
  }

  const email = buildEnquiryEmail(input);
  let response;
  try {
    response = await fetchImplementation("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        reply_to: [input.replyTo],
        ...email,
      }),
    });
  } catch (error) {
    throw new EnquiryEmailDeliveryError("Unable to reach Resend.", { cause: error });
  }

  if (!response.ok) {
    throw new EnquiryEmailDeliveryError("Resend rejected the enquiry email.");
  }
}

module.exports = {
  EnquiryEmailDeliveryError,
  buildEnquiryEmail,
  sendEnquiryEmail,
};