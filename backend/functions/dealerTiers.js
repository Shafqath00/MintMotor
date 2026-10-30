const DEALER_TIERS = Object.freeze({
  starter: { name: "Starter", monthlyPricePence: 9900, activeLimit: 10, featuredLimit: 2, priceEnvKey: "STRIPE_DEALER_STARTER_PRICE_ID", selfService: true },
  growth: { name: "Growth", monthlyPricePence: 17000, activeLimit: 17, featuredLimit: 3, priceEnvKey: "STRIPE_DEALER_GROWTH_PRICE_ID", selfService: true },
  scale: { name: "Scale", monthlyPricePence: 25000, activeLimit: 25, featuredLimit: 4, priceEnvKey: "STRIPE_DEALER_SCALE_PRICE_ID", selfService: true },
  pro: { name: "Pro", monthlyPricePence: 35000, activeLimit: 35, featuredLimit: 5, priceEnvKey: "STRIPE_DEALER_PRO_PRICE_ID", selfService: true },
  business: { name: "Business", monthlyPricePence: 50000, activeLimit: 50, featuredLimit: 9, priceEnvKey: "STRIPE_DEALER_BUSINESS_PRICE_ID", selfService: true },
  advanced: { name: "Advanced", monthlyPricePence: 75000, activeLimit: 75, featuredLimit: 15, priceEnvKey: "STRIPE_DEALER_ADVANCED_PRICE_ID", selfService: true },
  enterprise: { name: "Enterprise", monthlyPricePence: 99000, activeLimit: 99, featuredLimit: 20, priceEnvKey: "STRIPE_DEALER_ENTERPRISE_PRICE_ID", selfService: true },
  tier_150: { name: "150", monthlyPricePence: 150000, activeLimit: 150, featuredLimit: 25, priceEnvKey: "STRIPE_DEALER_150_PRICE_ID", selfService: true },
  tier_200: { name: "200", monthlyPricePence: 200000, activeLimit: 200, featuredLimit: 30, priceEnvKey: "STRIPE_DEALER_200_PRICE_ID", selfService: true },
  tier_300: { name: "300", monthlyPricePence: 300000, activeLimit: 300, featuredLimit: 30, priceEnvKey: "STRIPE_DEALER_300_PRICE_ID", selfService: true },
  tier_400: { name: "400", monthlyPricePence: 400000, activeLimit: 400, featuredLimit: 50, priceEnvKey: "STRIPE_DEALER_400_PRICE_ID", selfService: true },
  custom_500_plus: { name: "500+", monthlyPricePence: 500000, activeLimit: null, featuredLimit: null, priceEnvKey: "", selfService: false },
});

function publicDealerTiers() {
  return Object.entries(DEALER_TIERS).map(([key, tier]) => ({ key, name: tier.name, monthlyPricePence: tier.monthlyPricePence, activeLimit: tier.activeLimit, featuredLimit: tier.featuredLimit, selfService: tier.selfService }));
}

module.exports = { DEALER_TIERS, publicDealerTiers };
