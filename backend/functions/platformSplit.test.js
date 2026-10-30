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
  const db={collection,batch(){const ops=[];return {set(ref,value){ops.push(()=>ref.set(value));},async commit(){for(const op of ops)await op();}};},async runTransaction(fn){return fn({get:ref=>ref.get(),set:(ref,data,options)=>ref.set(data,options),update:(ref,data)=>ref.update(data)});}};
  const owner={uid:'seller',email:'seller@example.test',email_verified:true,phone_number:'+447700900000'};
  const admin={auth:()=>({async verifyIdToken(token){if(token==='owner')return owner;if(token==='unverified')return {...owner,email_verified:false,phone_number:undefined};if(token==='other')return {uid:'other'};if(token==='dealer')return {uid:'dealer',role:'dealer',email_verified:true};throw Error('bad token');},async getUserByEmail(email){if(email==='seller@example.test')return {uid:'seller',email,customClaims:{}};if(email==='dealer@example.test')return {uid:'dealer',email,customClaims:{role:'dealer'}};throw Object.assign(Error('missing'),{code:'auth/user-not-found'});}})};
  const {mintapi:app}=proxyquire('./index',{
    './firebase':{admin,database:db,storage:{},storageStatusDatabase:db},
    './vehiclePublish':{refreshVehicleDataForPublish:async()=>({vehicleHistory:null,vehicleHistoryVerified:false})},
    './vehicleLookup':{lookupVehicle:async()=>({})},
    'firebase-functions/v2/https':{onRequest:(_options,handler)=>handler},
    'firebase-functions/v2/scheduler':{onSchedule:()=>()=>{}},
  });
  const car={ownerId:'seller',sellerType:'private',listingPlan:'dealer-network-free',visibility:'dealer-network',status:'published',make:'Ford',model:'Focus',year:2020,price:10000,mileage:100,location:'London',description:'Well maintained car',images:['private-sellers/seller/cars/private/a.jpg'],contactName:'Private Seller',contactEmail:owner.email,registrationNumber:'AB12CDE',ownerEmail:owner.email,sellerPostcode:'SW1A 1AA',sellerGeo:{lat:51.5,lng:-0.1}};
  return {app,db,car,async seed(){await collection('cars').doc('private').set(car);await collection('dealers').doc('dealer').set({dealerStatus:'approved',authUid:'dealer',businessName:'Business',email:'business@example.test',phone:'01234567890',website:'https://dealer.test'});await collection('storageDealerStatus').doc('dealer').set({dealerStatus:'approved'});}};
}

test('new seller draft keeps the chosen plan and ignores forged identity/status',async()=>{
  const {app}=setup();
  const forged={make:'Ford',model:'Focus',visibility:'dealer-network',status:'published',ownerId:'attacker',sellerType:'dealer',legacyPublicUntil:'2099-01-01',isFeatured:true};
  const pub=await request(app).post('/cars').set('Authorization','Bearer owner').send({...forged,listingPlan:'public-subscription'});
  assert.equal(pub.status,201,JSON.stringify(pub.body));
  assert.equal(pub.body.car.ownerId,'seller');assert.equal(pub.body.car.sellerType,'private');assert.equal(pub.body.car.status,'draft');assert.equal(pub.body.car.visibility,'public');assert.equal(pub.body.car.listingPlan,'public-subscription');assert.equal(pub.body.car.legacyPublicUntil,undefined);assert.notEqual(pub.body.car.isFeatured,true);
  const free=await request(app).post('/cars').set('Authorization','Bearer owner').send({...forged,visibility:'public',listingPlan:'dealer-network-free'});
  assert.equal(free.status,201);assert.equal(free.body.car.visibility,'dealer-network');assert.equal(free.body.car.listingPlan,'dealer-network-free');
});

test('plan can change only while the listing is a draft',async()=>{
  const {app,db,car,seed}=setup();await seed();
  assert.equal((await request(app).patch('/cars/private').set('Authorization','Bearer owner').send({listingPlan:'public-subscription'})).status,409);
  await db.collection('cars').doc('private').set({...car,status:'draft'});
  const res=await request(app).patch('/cars/private').set('Authorization','Bearer owner').send({listingPlan:'public-subscription'});
  assert.equal(res.status,200,JSON.stringify(res.body));assert.equal(res.body.car.visibility,'public');assert.equal(res.body.car.listingPlan,'public-subscription');
});

test('published paid public advert is visible on the main site; publishing needs an active subscription',async()=>{
  const {app,db,car,seed}=setup();await seed();
  await db.collection('cars').doc('pub').set({...car,listingPlan:'public-subscription',visibility:'public',status:'draft',images:['private-sellers/seller/cars/pub/a.jpg']});
  const blocked=await request(app).post('/cars/pub/publish').set('Authorization','Bearer owner').send({});
  assert.equal(blocked.status,400);assert.match(JSON.stringify(blocked.body),/subscription/);
  await db.collection('users').doc('seller').set({subscriptionStatus:'active',subscriptionCurrentPeriodEnd:new Date(Date.now()+86400000)});
  assert.equal((await request(app).post('/cars/pub/publish').set('Authorization','Bearer owner').send({})).status,200);
  assert.equal((await request(app).get('/cars/pub')).status,200);
  assert.deepEqual((await request(app).get('/cars')).body.cars.map(c=>c.id),['pub']);
  assert.deepEqual((await request(app).get('/dealer/network/cars').set('Authorization','Bearer dealer')).body.cars.map(c=>c.id),['private']);
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

test('seller checkout is available only for paid public drafts',async()=>{
  const {app,seed}=setup();await seed();
  assert.equal((await request(app).post('/billing/checkout-session').set('Authorization','Bearer owner').send({draftId:'private'})).status,409);
  assert.notEqual((await request(app).post('/billing/customer-portal').set('Authorization','Bearer owner').send({})).status,410);
});

test('dealer accounts cannot use main-site buyer and seller routes',async()=>{
  const {app,seed}=setup();await seed();
  const calls=[['post','/cars'],['patch','/cars/private'],['patch','/cars/private/status'],['post','/cars/private/publish'],['delete','/cars/private'],['post','/billing/checkout-session'],['post','/billing/customer-portal'],['get','/me/subscription'],['get','/me/listings'],['get','/me/enquiries'],['get','/me/dealer-enquiries'],['get','/vehicle-checks'],['post','/vehicle-checks']];
  for(const [method,path] of calls){const res=await request(app)[method](path).set('Authorization','Bearer dealer').send({});assert.equal(res.status,403,method+' '+path);assert.equal(res.body.code,'DEALER_ACCOUNT',path);}
  assert.notEqual((await request(app).get('/dealer/network/cars').set('Authorization','Bearer dealer')).status,403);
});

test('dealer application rejects an email that already has a main-site account',async()=>{
  const {app}=setup();
  const body={businessName:'Cars Ltd',contactName:'Pat Dealer',phone:'01234567890',postcode:'SW1A 1AA',address:'1 High Street, London',dealerType:'independent',estimatedVehicleCount:10,email:'seller@example.test',acceptTerms:true,termsAccepted:true};
  const res=await request(app).post('/dealer-applications').send(body);
  assert.equal(res.status,409,JSON.stringify(res.body));assert.equal(res.body.code,'EMAIL_IN_USE_MAIN');
});

test('dealer bulk upload creates valid draft rows and reports the rest',async()=>{
  const {app,db,seed}=setup();await seed();
  const rows=[{registrationNumber:'AB12CDE',make:'Ford',model:'Focus',year:2020,price:9000,mileage:20000,tradePrice:8000},{registrationNumber:'XY99ZZZ',make:'',model:'Polo',year:2019,price:7000,mileage:3000,tradePrice:6000}];
  const res=await request(app).post('/dealer/cars/bulk').set('Authorization','Bearer dealer').send({rows});
  assert.equal(res.status,201,JSON.stringify(res.body));assert.equal(res.body.created,1);assert.ok(res.body.results[0].id);assert.ok(res.body.results[1].errors.length);
  const car=(await db.collection('cars').doc(res.body.results[0].id).get()).data();
  assert.equal(car.dealerId,'dealer');assert.equal(car.status,'draft');assert.equal(car.sellerType,'dealer');assert.equal(car.visibility,'public');
  assert.equal((await db.collection('dealerCarPrivate').doc(res.body.results[0].id).get()).data().tradePrice,8000);
  const again=await request(app).post('/dealer/cars/bulk').set('Authorization','Bearer dealer').send({rows:[rows[0]]});
  assert.equal(again.status,400);assert.match(JSON.stringify(again.body),/already in your inventory/);
  assert.equal((await request(app).post('/dealer/cars/bulk').set('Authorization','Bearer owner').send({rows})).status,403);
});
