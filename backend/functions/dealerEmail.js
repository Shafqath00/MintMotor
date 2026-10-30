class DealerEmailDeliveryError extends Error {}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
}

function link(label, url) {
  return `<a href="${escapeHtml(url)}" style="display:inline-block;margin:0 10px 12px 0;padding:12px 18px;background:#0000A3;color:#fff;border-radius:7px;text-decoration:none;font-weight:700">${label}</a>`;
}

function buildDealerActivationEmail({ businessName, setupLink, verificationLink }) {
  const name = escapeHtml(businessName || "your business");
  const verification = verificationLink ? `\n${link("Verify email", verificationLink)}` : "";
  return {
    subject: "Your Mint Motor dealer account has been approved",
    text: `Mint Motor has approved ${businessName || "your dealer account"}. Choose your own password using this secure setup link: ${setupLink}${verificationLink ? `\nVerify your email: ${verificationLink}` : ""}\n\nYou must verify your email before accessing the dealer portal. Setup links expire; contact Mint Motor to request a new activation link.`,
    html: `<!doctype html><html><body style="margin:0;padding:32px;background:#f5f5f3;font-family:Arial,sans-serif;color:#171717"><main style="max-width:600px;margin:auto;background:#fff;border-radius:16px;overflow:hidden"><header style="background:#0000A3;color:#fff;padding:24px;font-size:24px;font-weight:700">MintMotor</header><section style="padding:28px"><p style="font-weight:700;color:#0000A3">DEALER ACCOUNT APPROVED</p><h1>Welcome, ${name}</h1><p>Your Mint Motor dealer account is ready. Choose your own password to activate it.</p>${link("Set password", setupLink)}${verification}<p>You must verify your email before accessing the dealer portal. These secure links expire. If you need a new link, contact Mint Motor.</p></section></main></body></html>`,
  };
}

function buildDealerPlanActivatedEmail({ businessName, tierName, monthlyPricePence, activeLimit, featuredLimit, currentPeriodEnd }) {
  const business = escapeHtml(businessName || "your business");
  const tier = escapeHtml(tierName || "Dealer Network");
  const price = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }).format(monthlyPricePence / 100);
  const renewal = currentPeriodEnd
    ? new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "Europe/London" }).format(new Date(currentPeriodEnd))
    : "your next billing date";
  return {
    subject: `${tier} plan activated for ${business}`,
    text: `Your Mint Motor Dealer Network ${tier} plan is active for ${business}. It includes up to ${activeLimit} active listings and ${featuredLimit} featured listings for ${price} per month. Your current billing period ends ${renewal}. Manage your subscription in your Dealer Network settings.`,
    html: `<!doctype html><html><body style="margin:0;padding:32px;background:#f5f5f3;font-family:Arial,sans-serif;color:#171717"><main style="max-width:600px;margin:auto;background:#fff;border-radius:16px;overflow:hidden"><header style="background:#0000A3;color:#fff;padding:24px;font-size:24px;font-weight:700">MintMotor</header><section style="padding:28px"><p style="font-weight:700;color:#0000A3">DEALER NETWORK PLAN ACTIVE</p><h1>Your ${tier} plan is ready</h1><p>${business} can now publish Dealer Network vehicles.</p><p><strong>${price} per month</strong><br>${activeLimit} active listings · ${featuredLimit} featured listings<br>Current billing period ends ${escapeHtml(renewal)}.</p><p>Manage your subscription in your Dealer Network settings.</p></section></main></body></html>`,
  };
}

async function sendDealerActivationEmail(input, { apiKey, from, fetchImplementation = fetch }) {
  if (!apiKey || !from) throw new DealerEmailDeliveryError("Resend is not configured.");
  let response;
  try {
    response = await fetchImplementation("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [input.to], ...buildDealerActivationEmail(input) }),
    });
  } catch (error) {
    throw new DealerEmailDeliveryError("Unable to reach Resend.", { cause: error });
  }
  if (!response.ok) throw new DealerEmailDeliveryError("Resend rejected the dealer activation email.");
}

async function sendDealerPlanActivatedEmail(input, { apiKey, from, fetchImplementation = fetch }) {
  if (!apiKey || !from) throw new DealerEmailDeliveryError("Resend is not configured.");
  let response;
  try {
    response = await fetchImplementation("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [input.to], ...buildDealerPlanActivatedEmail(input) }),
    });
  } catch (error) {
    throw new DealerEmailDeliveryError("Unable to reach Resend.", { cause: error });
  }
  if (!response.ok) throw new DealerEmailDeliveryError("Resend rejected the dealer plan activation email.");
}

module.exports = { DealerEmailDeliveryError, buildDealerActivationEmail, buildDealerPlanActivatedEmail, sendDealerActivationEmail, sendDealerPlanActivatedEmail };
