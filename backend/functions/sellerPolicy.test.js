const test = require('node:test');
const assert = require('node:assert/strict');
const { privateSellerPatch, isPublicMarketplaceCar, dealerSubmission, validateSellerIdentity, validatePrivateImageReferences } = require('./sellerPolicy');

test('new private submissions cannot retain client ownership, paid plans or publication status', () => {
  assert.deepEqual(privateSellerPatch(), { sellerType: 'private', listingPlan: 'dealer-network-free', visibility: 'dealer-network', status: 'draft', isFeatured: false });
  assert.deepEqual(privateSellerPatch({ status: 'published', listingPlan: 'dealer-network-free' }), { sellerType: 'private', listingPlan: 'dealer-network-free', visibility: 'dealer-network', status: 'published', isFeatured: false });
  assert.equal(privateSellerPatch({status: 'published', listingPlan:'public-subscription'}).status, 'draft');
});

test('public marketplace eligibility enforces grandfather dates and denies private submissions even with forged visibility', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  const legacy = {sellerType:'private',status:'published',visibility:'public',listingPlan:'public-subscription',legacyPublicUntil:'2026-11-01T00:00:00Z'};
  assert.equal(isPublicMarketplaceCar(legacy, now), true);
  assert.equal(isPublicMarketplaceCar({...legacy,legacyPublicUntil:new Date(now).toISOString()}, now), false);
  assert.equal(isPublicMarketplaceCar({...legacy,legacyPublicUntil:undefined}, now), false);
  assert.equal(isPublicMarketplaceCar({...legacy,listingPlan:'dealer-network-free'}, now), false);
  assert.equal(isPublicMarketplaceCar({sellerType:'dealer',status:'active',visibility:'public'}, now), true);
  assert.equal(isPublicMarketplaceCar({sellerType:'dealer',status:'draft',visibility:'public'}, now), false);
  assert.equal(isPublicMarketplaceCar({sellerType:'dealer',status:'active',visibility:'dealer-network'}, now), false);
});

test('dealer feed uses a field allowlist and coarse vehicle facts only', () => {
  const car = dealerSubmission({id:'car',make:'Ford',model:'Focus',year:2020,images:['private-sellers/s/cars/car/a.jpg'],ownerId:'s',ownerEmail:'secret@example.test',contactEmail:'secret@example.test',contactPhone:'secret',contactName:'Private person',sellerPostcode:'SW1A 1AA',sellerGeo:{lat:1,lng:1},dealerNotes:'secret',unexpectedSecret:'secret',vehicleHistory:{provider:'ukvehicledata',registrationNumber:'AB12CDE',summaryStatus:'clear',secret:'secret',mot:{status:'valid',secret:'secret'}}});
  assert.equal(car.make,'Ford');
  for (const field of ['ownerId','ownerEmail','contactEmail','contactPhone','contactName','sellerPostcode','sellerGeo','dealerNotes','unexpectedSecret']) assert.equal(car[field],undefined,field);
  assert.equal(car.vehicleHistory.secret,undefined);
  assert.equal(car.vehicleHistory.mot.secret,undefined);
});

test('free seller publication checks identity separately from billing and ignores untrusted profile flags', () => {
  assert.deepEqual(validateSellerIdentity({email_verified:true,phone_number:'+447700900000'}),[]);
  assert.equal(validateSellerIdentity({email_verified:false}).length,2);
  assert.equal(validateSellerIdentity({email_verified:true}).length,1);
});

test('private images must be canonical paths belonging to this exact owner and listing', () => {
  assert.deepEqual(validatePrivateImageReferences(['private-sellers/s/cars/car/a.jpg'],'s','car'),[]);
  for (const path of ['https://example.test/a.jpg','private-sellers/other/cars/car/a.jpg','private-sellers/s/cars/other/a.jpg','private-sellers/s/cars/car/../a.jpg']) {
    assert.equal(validatePrivateImageReferences([path],'s','car').length,1,path);
  }
});
