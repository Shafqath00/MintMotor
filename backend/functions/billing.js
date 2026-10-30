async function createCustomerPortalSession({ stripe, customerId, returnUrl }) {
  if (!customerId) {
    throw new Error("There is no Stripe customer for this account yet.");
  }
  if (!stripe?.billingPortal?.sessions?.create) {
    throw new Error("Stripe billing portal is not configured.");
  }
  return stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
}

function priceConfigurationError() {
  const error = new Error("Stripe subscription price is not configured correctly.");
  error.code = "STRIPE_PRICE_CONFIGURATION";
  return error;
}

async function validateRecurringPrice({ stripe, priceId, expectedAmount, expectedCurrency = "gbp" }) {
  if (!priceId || !stripe?.prices?.retrieve) throw priceConfigurationError();
  let price;
  try {
    price = await stripe.prices.retrieve(priceId);
  } catch (error) {
    if (error?.code === "resource_missing") throw priceConfigurationError();
    throw error;
  }
  if (!price?.active || price.currency !== expectedCurrency || price.unit_amount !== expectedAmount || price.recurring?.interval !== "month" || (price.recurring?.interval_count || 1) !== 1) throw priceConfigurationError();
  return { id: price.id || priceId };
}

async function unpublishPublicListingsAfterAccessEnds({ database, userId, timestamp }) {
  if (!database || !userId) return 0;
  const snapshot = await database.collection("cars").where("ownerId", "==", userId).get();
  const listings = snapshot.docs.filter((doc) => {
    const car = doc.data();
    return car.ownerId === userId && car.listingPlan === "public-subscription" && car.status === "published";
  });

  for (let offset = 0; offset < listings.length; offset += 500) {
    const batch = database.batch();
    for (const listing of listings.slice(offset, offset + 500)) {
      batch.update(listing.ref, { status: "draft", updatedAt: timestamp });
    }
    await batch.commit();
  }

  return listings.length;
}

async function unpublishDealerListingsAfterAccessEnds({ database, dealerId, timestamp }) {
  if (!database || !dealerId) return 0;
  const snapshot = await database.collection("cars").where("dealerId", "==", dealerId).get();
  const listings = snapshot.docs.filter((doc) => {
    const car = doc.data();
    return car.dealerId === dealerId && car.sellerType === "dealer" && car.status === "active";
  });

  for (let offset = 0; offset < listings.length; offset += 500) {
    const batch = database.batch();
    for (const listing of listings.slice(offset, offset + 500)) {
      batch.update(listing.ref, { status: "draft", updatedAt: timestamp });
    }
    await batch.commit();
  }

  return listings.length;
}

function buildSellerCheckoutUrls({ frontendUrl, draftId }) {
  const successQuery = new URLSearchParams({ id: draftId, checkout: "success" });
  const cancelQuery = new URLSearchParams({ id: draftId, checkout: "cancelled" });
  return {
    successUrl: `${frontendUrl}/sell/subscription?${successQuery.toString()}`,
    cancelUrl: `${frontendUrl}/sell/subscription?${cancelQuery.toString()}`,
  };
}

function prepareSellerListingPlanUpdate({ listingPlan, hasSubscription }) {
  const patch = {
    listingPlan,
    visibility: listingPlan === "dealer-network-free" ? "dealer-network" : "public",
  };
  if (listingPlan === "public-subscription" && !hasSubscription) patch.status = "draft";
  return patch;
}

module.exports = { buildSellerCheckoutUrls, createCustomerPortalSession, prepareSellerListingPlanUpdate, unpublishDealerListingsAfterAccessEnds, unpublishPublicListingsAfterAccessEnds, validateRecurringPrice };
