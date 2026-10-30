const { sanitizeVehicleHistory } = require('./validators');

function privateSellerPatch(current) {
  return {
    sellerType: 'private', listingPlan: 'dealer-network-free', visibility: 'dealer-network',
    status: current?.listingPlan === 'dealer-network-free' ? current.status : 'draft', isFeatured: false,
  };
}

function dateMillis(value) {
  if (value?.toMillis) return value.toMillis();
  if (value?.toDate) return value.toDate().getTime();
  return value ? new Date(value).getTime() : NaN;
}

function isPublicMarketplaceCar(car = {}, now = Date.now()) {
  if (car.visibility === 'dealer-network' || car.listingPlan === 'dealer-network-free') return false;
  if (!['published', 'active', 'sold'].includes(car.status)) return false;
  if (car.sellerType === 'dealer' || car.ownerType === 'dealer') return true;
  if (process.env.SELLER_PLATFORM_SPLIT_ENABLED === 'false') return true;
  return car.listingPlan === 'public-subscription' && dateMillis(car.legacyPublicUntil) > now;
}

// This projection is deliberately independent of the public marketplace's contact
// preferences: a private submission must never reveal seller contact or account data.
const SUBMISSION_FIELDS = [
  'id','registrationNumber','make','model','variant','year','price','mileage','fuelType','transmission',
  'bodyType','engineSize','color','location','description','attentionGrabber','features','images',
  'motDueDate','dateOfFirstRegistration','serviceHistory','seats','doors','previousOwners','keysCount',
  'co2Emissions','insuranceGroup','fuelConsumptionUrban','fuelConsumptionExtraUrban',
  'fuelConsumptionCombined','vehicleHistoryVerified','status','sellerType','listingPlan','visibility','publishedAt','createdAt','updatedAt',
];
function dealerSubmission(car = {}) {
  const result = Object.fromEntries(SUBMISSION_FIELDS.filter(key => car[key] !== undefined).map(key => [key,car[key]]));
  if (car.vehicleHistory) {
    const history = sanitizeVehicleHistory(car.vehicleHistory);
    if (history) result.vehicleHistory = history;
  }
  return result;
}

function validateSellerIdentity(authUser = {}) {
  const errors = [];
  if (authUser.email_verified !== true && authUser.emailVerified !== true) errors.push('Verify your email address before publishing.');
  if (!authUser.phone_number && !authUser.phoneNumber) errors.push('Verify your mobile number before publishing.');
  return errors;
}

function validatePrivateImageReferences(images, ownerId, carId) {
  const prefix = `private-sellers/${ownerId}/cars/${carId}/`;
  return (images || []).some(path => typeof path !== 'string' || !path.startsWith(prefix) || !path.slice(prefix.length) || /[\\%?#\x00-\x1f]/.test(path) || path.split('/').some(part => part === '.' || part === '..' || !part))
    ? ['Private vehicle photos must be uploaded to this listing.'] : [];
}

module.exports = {privateSellerPatch, isPublicMarketplaceCar, dealerSubmission, validateSellerIdentity, validatePrivateImageReferences, dateMillis};
