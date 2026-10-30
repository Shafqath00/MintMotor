const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const proxyquire = require('proxyquire');

function setup() {
  const rows = new Map(); let seq = 0;
  function collection(name) {
    if (!rows.has(name)) rows.set(name,new Map());
    const records = rows.get(name);
    function doc(id = `car-${++seq}`) {
      const ref = {id, async get(){ return {id,ref,exists:records.has(id),data:()=>records.get(id)}; }, async set(value,options={}){records.set(id,options.merge?{...records.get(id),...value}:value);},async update(value){records.set(id,{...records.get(id),...value});},async delete(){records.delete(id);}};
      return ref;
    }
    function query(filters=[]) {return {where(field,op,value){return query([...filters,[field,op,value]]);},limit(){return this;},async get(){const docs=await Promise.all([...records.entries()].filter(([,data])=>filters.every(([field,op,value])=>op==='in'?value.includes(data[field]):data[field]===value)).map(([id])=>doc(id).get()));return {docs,size:docs.length};}};}
    return {...query(),doc,async add(value){const ref=doc();await ref.set(value);return ref;}};
  }
  const db={collection,async runTransaction(fn){return fn({get:ref=>ref.get(),set:(ref,data,options)=>ref.set(data,options),update:(ref,data)=>ref.update(data)});}};
  const owner={uid:'seller',email:'seller@example.test',email_verified:true,phone_number:'+447700900000'};
  const admin={auth:()=>({async verifyIdToken(token){if(token==='owner')return owner;if(token==='unverified')return {...owner,email_verified:false,phone_number:undefined};if(token==='other')return {uid:'other'};if(token==='dealer')return {uid:'dealer',role:'dealer',email_verified:true};throw Error('bad token');}})};
  const {mintapi:app}=proxyquire('./index',{
    './firebase':{admin,database:db,storage:{},storageStatusDatabase:db},
    './vehiclePublish':{refreshVehicleDataForPublish:async()=>({vehicleHistory:null,vehicleHistoryVerified:false})},
    './vehicleLookup':{lookupVehicle:async()=>({})},
    'firebase-functions/v2/https':{onRequest:(_options,handler)=>handler},
    'firebase-functions/v2/scheduler':{onSchedule:()=>()=>{}},
  });
  const car={ownerId:'seller',sellerType:'private',listingPlan:'dealer-network-free',visibility:'dealer-network',status:'published',make:'Ford',model:'Focus',year:2020,price:10000,mileage:100,location:'London',description:'Well maintained car',images:['private-sellers/seller/cars/private/a.jpg'],contactName:'Private Seller',contactEmail:owner.email,registrationNumber:'AB12CDE',ownerEmail:owner.email,sellerPostcode:'SW1A 1AA',sellerGeo:{lat:51.5,lng:-0.1}};
  return {app,db,car,async seed(){await collection('cars').doc('private').set(car);await collection('dealers').doc('dealer').set({dealerStatus:'approved',businessName:'Business',email:'business@example.test',phone:'01234567890',website:'https://dealer.test'});await collection('storageDealerStatus').doc('dealer').set({dealerStatus:'approved'});}};
}

test('new seller draft forcibly uses the free private plan and ignores forged identity/status',async()=>{
  const {app}=setup();
  const res=await request(app).post('/cars').set('Authorization','Bearer owner').send({make:'Ford',model:'Focus',listingPlan:'public-subscription',visibility:'public',status:'published',ownerId:'attacker',sellerType:'dealer',legacyPublicUntil:'2099-01-01'});
  assert.equal(res.status,201,JSON.stringify(res.body));
  assert.equal(res.body.car.ownerId,'seller');assert.equal(res.body.car.sellerType,'private');assert.equal(res.body.car.status,'draft');assert.equal(res.body.car.visibility,'dealer-network');assert.equal(res.body.car.listingPlan,'dealer-network-free');assert.equal(res.body.car.legacyPublicUntil,undefined);
});

test('private listing cannot be published via status or generic patch and requires verified identity',async()=>{
  const {app,db,car,seed}=setup();await seed();await db.collection('cars').doc('private').set({...car,status:'draft'});
  assert.equal((await request(app).patch('/cars/private/status').set('Authorization','Bearer owner').send({status:'published'})).status,400);
  assert.equal((await request(app).patch('/cars/private').set('Authorization','Bearer owner').send({status:'published'})).status,400);
  assert.equal((await request(app).post('/cars/private/publish').set('Authorization','Bearer unverified').send({})).status,400);
  assert.equal((await request(app).post('/cars/private/publish').set('Authorization','Bearer owner').send({})).status,200);
  assert.equal((await request(app).patch('/cars/private/status').set('Authorization','Bearer owner').send({status:'draft'})).status,200);
});

test('every public private-vehicle endpoint rejects before vehicle lookups or email delivery',async()=>{
  const {app,seed}=setup();await seed();
  assert.equal((await request(app).get('/cars/private')).status,404);
  assert.equal((await request(app).get('/cars/private/distance?postcode=SW1A1AA')).status,404);
  assert.equal((await request(app).post('/cars/private/enquiries').send({})).status,404);
  assert.equal((await request(app).get('/cars')).body.cars.length,0);
});

test('dealer projection hides all seller contact and owner fields; seller sees only own offers',async()=>{
  const {app,db,seed}=setup();await seed();
  const network=await request(app).get('/dealer/network/cars').set('Authorization','Bearer dealer');assert.equal(network.status,200);
  for(const key of ['ownerEmail','ownerId','contactEmail','contactPhone','sellerPostcode','sellerGeo'])assert.equal(network.body.cars[0][key],undefined,key);
  const sent=await request(app).post('/dealer/network/cars/private/enquiries').set('Authorization','Bearer dealer').send({message:'Interested in buying this vehicle',offerAmount:9000});assert.equal(sent.status,201);
  await db.collection('dealerEnquiries').doc('foreign').set({sellerOwnerId:'other',buyerDealerId:'dealer',carId:'private',message:'private foreign offer'});
  const inbox=await request(app).get('/me/dealer-enquiries').set('Authorization','Bearer owner');assert.equal(inbox.status,200);assert.equal(inbox.body.enquiries.length,1);assert.equal(inbox.body.enquiries[0].dealer.email,'business@example.test');assert.equal(inbox.body.enquiries[0].offerAmount,9000);assert.equal(inbox.body.enquiries[0].vehicle.make,'Ford');
  assert.equal((await request(app).get('/me/dealer-enquiries')).status,401);
});

test('retired seller checkout and billing portal cannot create/reactivate plans',async()=>{
  const {app}=setup();
  assert.equal((await request(app).post('/billing/checkout-session').set('Authorization','Bearer owner').send({draftId:'private'})).status,410);
  assert.equal((await request(app).post('/billing/customer-portal').set('Authorization','Bearer owner').send({})).status,410);
});
