const test = require('node:test');
const assert = require('node:assert/strict');
const { sellerPlanPatch, isPublicMarketplaceCar, dealerSubmission, validateSellerIdentity, validatePrivateImageReferences } = require('./sellerPolicy');

test('seller plan patch derives visibility on the server and never features private adverts', () => {
  assert.deepEqual(sellerPlanPatch('dealer-network-free'), { sellerType: 'private', listingPlan: 'dealer-network-free', visibility: 'dealer-network', isFeatured: false });
  assert.deepEqual(sellerPlanPatch('public-subscription'), { sellerType: 'private', listingPlan: 'public-subscription', visibility: 'public', isFeatured: false });
  assert.deepEqual(sellerPlanPatch('anything-else'), sellerPlanPatch('public-subscription'));
});

test('public marketplace eligibility shows paid public adverts and denies dealer-only submissions even with forged visibility', () => {
  const advert = {sellerType:'private',status:'published',visibility:'public',listingPlan:'public-subscription'};
  assert.equal(isPublicMarketplaceCar(advert), true);
  assert.equal(isPublicMarketplaceCar({...advert,status:'sold'}), true);
  assert.equal(isPublicMarketplaceCar({...advert,status:'draft'}), false);
  assert.equal(isPublicMarketplaceCar({...advert,listingPlan:'dealer-network-free'}), false);
  assert.equal(isPublicMarketplaceCar({...advert,visibility:'dealer-network'}), false);
  assert.equal(isPublicMarketplaceCar({sellerType:'dealer',status:'active',visibility:'public'}), true);
  assert.equal(isPublicMarketplaceCar({sellerType:'dealer',status:'draft',visibility:'public'}), false);
  assert.equal(isPublicMarketplaceCar({sellerType:'dealer',status:'active',visibility:'dealer-network'}), false);
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
