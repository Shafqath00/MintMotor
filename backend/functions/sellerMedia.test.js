const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { createSellerMediaRouter, isSafePrivateImagePath, prepareSellerListingImages, finalizeSellerListingImages, scrubPrivateImageTokens } = require("./sellerMedia");

const IMAGE = Buffer.from("ffd8ffe000104a4649460001", "hex");
const PRIVATE = "private-sellers/seller/cars/car-1/photo.jpg";
const LEGACY = "users/seller/cars/car-1/photo.jpg";
const legacyUrl = (path = LEGACY, bucket = "own-bucket") => `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=old-token`;

function fakeDatabase(records = {}) {
  return { collection: (collection) => ({ doc: (id) => ({ get: async () => {
    const value = records[collection]?.[id];
    return { exists: value !== undefined, data: () => value };
  } }) }) };
}

function fakeBucket(objects = { [PRIVATE]: { contentType: "image/jpeg", metadata: {}, bytes: IMAGE } }) {
  const writes = [];
  const bucket = { name: "own-bucket", writes, objects, file: (name) => ({
    name,
    exists: async () => [Boolean(objects[name])],
    getMetadata: async () => {
      if (!objects[name]) throw Object.assign(new Error("missing"), { code: 404 });
      return [{ ...objects[name], size: String(objects[name].bytes.length), generation: "1" }];
    },
    download: async () => [objects[name].bytes],
    copy: async (destination, options) => {
      writes.push(["copy", name, destination.name]);
      objects[destination.name] = { ...objects[name], ...(options?.metadata || {}) };
    },
    setMetadata: async (metadata) => {
      writes.push(["metadata", name]);
      objects[name] = { ...objects[name], ...metadata, metadata: { ...objects[name].metadata, ...metadata.metadata } };
    },
    delete: async () => { writes.push(["delete", name]); delete objects[name]; },
  }) };
  return bucket;
}

function fixture({ car = {}, user = {}, dealer = {}, deletion = {}, bucket = fakeBucket(), mirror } = {}) {
  const records = {
    cars: { "car-1": { ownerId: "seller", sellerType: "private", listingPlan: "dealer-network-free", visibility: "dealer-network", status: "published", images: [PRIVATE], ...car } },
    dealers: { dealer: { dealerStatus: "approved", ...dealer } },
    accountDeletionRequests: deletion,
    users: user,
  };
  const tokens = { owner: { uid: "seller", role: "user" }, other: { uid: "other", role: "user" }, dealer: { uid: "dealer", role: "dealer", email_verified: true }, unverified: { uid: "dealer", role: "dealer" }, admin: { uid: "admin", role: "admin" } };
  const admin = { auth: () => ({ verifyIdToken: async (token, revoked) => {
    assert.equal(revoked, true);
    if (!tokens[token]) throw new Error("invalid token");
    return tokens[token];
  } }) };
  const app = express();
  app.use(createSellerMediaRouter({ admin, database: fakeDatabase(records), storage: { bucket: () => bucket }, storageStatusDatabase: mirror && fakeDatabase(mirror), logger: { warn() {}, error() {} } }));
  return { app, bucket, records };
}

test("private media requires valid authentication and never fetches for anonymous/other sellers", async () => {
  const { app, bucket } = fixture();
  assert.equal((await request(app).get("/cars/car-1/images/0")).status, 401);
  assert.equal((await request(app).get("/cars/car-1/images/0").set("Authorization", "Bearer invalid")).status, 401);
  assert.equal((await request(app).get("/cars/car-1/images/0").set("Authorization", "Bearer other")).status, 403);
  assert.equal(bucket.writes.length, 0);
});

for (const status of ["draft", "published", "sold"]) {
  test(`owner may view their ${status} listing bytes without permanent URLs`, async () => {
    const { app } = fixture({ car: { status } });
    const response = await request(app).get("/cars/car-1/images/0").set("Authorization", "Bearer owner");
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(response.headers["content-type"], "image/jpeg");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.deepEqual(response.body, IMAGE);
  });
}

test("approved verified dealer needs no paid subscription to view published private dealer-network-free media", async () => {
  const { app } = fixture();
  assert.equal((await request(app).get("/cars/car-1/images/0").set("Authorization", "Bearer dealer")).status, 200);
});

test("dealer rejects unverified, suspended, unpaid public, dealer inventory and unpublished media", async () => {
  const cases = [
    [{}, "unverified"], [{ dealer: { dealerStatus: "suspended" } }, "dealer"],
    [{ car: { status: "draft" } }, "dealer"], [{ car: { status: "sold" } }, "dealer"],
    [{ car: { listingPlan: "public-subscription" } }, "dealer"], [{ car: { sellerType: "dealer" } }, "dealer"],
    [{ car: { visibility: "public" } }, "dealer"],
    [{ mirror: { storageDealerStatus: { dealer: { dealerStatus: "suspended" } } } }, "dealer"],
    [{ deletion: { dealer: { status: "pending" } } }, "dealer"],
  ];
  for (const [options, token] of cases) {
    const { app } = fixture(options);
    assert.equal((await request(app).get("/cars/car-1/images/0").set("Authorization", `Bearer ${token}`)).status, 403);
  }
});

test("deleted owners cannot read, owners of deleted listings cannot expose media to dealers", async () => {
  for (const token of ["owner", "dealer"]) {
    const { app } = fixture({ deletion: { seller: { status: "completed" } } });
    assert.equal((await request(app).get("/cars/car-1/images/0").set("Authorization", `Bearer ${token}`)).status, 403);
  }
});

test("media path must match the real owner and listing; image index is strict", async () => {
  for (const image of ["private-sellers/other/cars/car-1/photo.jpg", "private-sellers/seller/cars/other/photo.jpg", "private-sellers/seller/cars/car-1/../secret.jpg", "https://evil.test/x.jpg"]) {
    const { app } = fixture({ car: { images: [image] } });
    assert.equal((await request(app).get("/cars/car-1/images/0").set("Authorization", "Bearer owner")).status, 404);
  }
  for (const index of ["-1", "01", "1", "1x"]) {
    assert.equal((await request(fixture().app).get(`/cars/car-1/images/${index}`).set("Authorization", "Bearer owner")).status, 404);
  }
});

test("legacy own Firebase image can be delivered safely before migration; MIME and bytes must be images", async () => {
  const bucket = fakeBucket({ [LEGACY]: { contentType: "image/jpeg", bytes: IMAGE, metadata: {} } });
  const { app } = fixture({ bucket, car: { images: [legacyUrl()] } });
  assert.equal((await request(app).get("/cars/car-1/images/0").set("Authorization", "Bearer owner")).status, 200);
  for (const object of [{ contentType: "image/svg+xml", bytes: Buffer.from("<svg/>") }, { contentType: "image/jpeg", bytes: Buffer.from("<script>x</script>") }]) {
    const invalid = fixture({ bucket: fakeBucket({ [PRIVATE]: { ...object, metadata: {} } }) });
    assert.equal((await request(invalid.app).get("/cars/car-1/images/0").set("Authorization", "Bearer owner")).status, 404);
  }
});

test("private image path validation rejects traversal, encoded delimiters and foreign listings", () => {
  assert.equal(isSafePrivateImagePath(PRIVATE, "seller", "car-1"), true);
  for (const suffix of ["../x.jpg", "a/../../x.jpg", "%2e%2e/x.jpg", "foo%2fbar.jpg", "x\\y.jpg", "", "//x.jpg"]) {
    assert.equal(isSafePrivateImagePath(`private-sellers/seller/cars/car-1/${suffix}`, "seller", "car-1"), false, suffix);
  }
  assert.equal(isSafePrivateImagePath(PRIVATE, "other", "car-1"), false);
});

test("migration dry run validates all references without writes or revoked originals", async () => {
  const bucket = fakeBucket({ [LEGACY]: { contentType: "image/jpeg", bytes: IMAGE, metadata: { firebaseStorageDownloadTokens: "token", other: "keep" } } });
  const plan = await prepareSellerListingImages({ bucket, car: { ownerId: "seller", images: [legacyUrl()] }, carId: "car-1" });
  assert.deepEqual(plan.images, [PRIVATE]);
  assert.equal(plan.changed, true);
  assert.deepEqual(bucket.writes, []);
  assert.equal(bucket.objects[LEGACY].metadata.firebaseStorageDownloadTokens, "token");
});

test("migration copies privately first, then requires persisted metadata before revoking/removing originals", async () => {
  const bucket = fakeBucket({ [LEGACY]: { contentType: "image/jpeg", bytes: IMAGE, metadata: { firebaseStorageDownloadTokens: "token", other: "keep" } } });
  const plan = await prepareSellerListingImages({ bucket, car: { ownerId: "seller", images: [legacyUrl()] }, carId: "car-1", dryRun: false });
  assert.equal(bucket.objects[PRIVATE].metadata.firebaseStorageDownloadTokens, null);
  assert.equal(bucket.objects[PRIVATE].metadata.other, "keep");
  assert.equal(bucket.objects[LEGACY].metadata.firebaseStorageDownloadTokens, "token");
  await assert.rejects(finalizeSellerListingImages({ bucket, plan, persistedImages: [legacyUrl()], dryRun: false }), /persist/i);
  assert.ok(bucket.objects[LEGACY]);
  await finalizeSellerListingImages({ bucket, plan, persistedImages: plan.images, dryRun: false });
  assert.equal(bucket.objects[LEGACY], undefined);
  const again = await prepareSellerListingImages({ bucket, car: { ownerId: "seller", images: plan.images }, carId: "car-1", dryRun: false });
  assert.equal(again.changed, false);
  const writes = bucket.writes.length;
  await finalizeSellerListingImages({ bucket, plan, persistedImages: plan.images, dryRun: false });
  assert.equal(bucket.writes.length, writes);
});

test("migration rejects external/foreign/token URLs before copying any image", async () => {
  for (const image of ["https://example.test/image.jpg", legacyUrl(LEGACY, "foreign-bucket"), legacyUrl("users/other/cars/car-1/photo.jpg"), legacyUrl("users/seller/cars/other/photo.jpg")]) {
    const bucket = fakeBucket();
    await assert.rejects(prepareSellerListingImages({ bucket, car: { ownerId: "seller", images: [legacyUrl(), image] }, carId: "car-1", dryRun: false }), /unsupported|owner|image/i);
    assert.deepEqual(bucket.writes, []);
  }
});

test("paid public advert images are viewable anonymously only while the advert is published", async () => {
  const legacy = { listingPlan: "public-subscription", visibility: "public" };
  const valid = fixture({ car: legacy });
  assert.equal((await request(valid.app).get("/cars/car-1/images/0")).status, 200);
  assert.equal((await request(valid.app).get("/cars/car-1/images/0").set("Authorization", "Bearer other")).status, 200);
  for (const patch of [{ status: "draft" }, { visibility: "dealer-network" }, { listingPlan: "dealer-network-free" }]) {
    assert.equal((await request(fixture({ car: { ...legacy, ...patch } }).app).get("/cars/car-1/images/0")).status, 401);
  }
});

test("scrub private uploads before persistence; reject foreign references and skip clean metadata", async () => {
  const bucket = fakeBucket({ [PRIVATE]: { contentType: "image/jpeg", bytes: IMAGE, metadata: { firebaseStorageDownloadTokens: "auto-token", other: "keep" } } });
  await assert.rejects(scrubPrivateImageTokens({ bucket, images: [PRIVATE, "private-sellers/other/cars/car-1/x.jpg"], ownerId: "seller", carId: "car-1" }), /image|owner/i);
  assert.deepEqual(bucket.writes, []);
  await scrubPrivateImageTokens({ bucket, images: [PRIVATE], ownerId: "seller", carId: "car-1" });
  assert.equal(bucket.objects[PRIVATE].metadata.firebaseStorageDownloadTokens, null);
  assert.equal(bucket.objects[PRIVATE].metadata.other, "keep");
  const writes = bucket.writes.length;
  await scrubPrivateImageTokens({ bucket, images: [PRIVATE], ownerId: "seller", carId: "car-1" });
  assert.equal(bucket.writes.length, writes);
});

test("token scrubbing fails closed if Storage retains a download token", async () => {
  const metadata = { contentType: "image/jpeg", size: "12", metadata: { firebaseStorageDownloadTokens: "still-public" } };
  const bucket = { file: () => ({ getMetadata: async () => [metadata], setMetadata: async () => {} }) };
  await assert.rejects(scrubPrivateImageTokens({ bucket, images: [PRIVATE], ownerId: "seller", carId: "car-1" }), /token.*revok|revok.*token/i);
});
