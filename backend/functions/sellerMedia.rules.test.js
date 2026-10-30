const test = require("node:test");
const assert = require("node:assert/strict");

const storageHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const project = "demo-seller-media";
const bucket = `${project}.appspot.com`;

function mockToken(uid) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: uid, user_id: uid, aud: project, iss: `https://securetoken.google.com/${project}`, iat: now, exp: now + 3600, auth_time: now, firebase: { sign_in_provider: "custom", identities: {} } };
  return `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.`;
}

test("Storage rules enforce owned uploads, private byte access, recovery listing and public expiry", { skip: !storageHost || !firestoreHost }, async () => {
  const firestore = `http://${firestoreHost}/v1/projects/${project}/databases/(default)/documents/storageSellerListings`;
  const storage = `http://${storageHost}/v0/b/${bucket}/o`;
  const fields = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
    value instanceof Date ? { timestampValue: value.toISOString() } : typeof value === "boolean" ? { booleanValue: value } : { stringValue: value },
  ]));
  const seed = async (id, values) => {
    const response = await fetch(`${firestore}/${id}`, { method: "PATCH", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" }, body: JSON.stringify({ fields: fields(values) }) });
    assert.equal(response.status, 200, await response.text());
  };
  const headers = (uid) => uid ? { Authorization: `Bearer ${uid === "owner" ? "owner" : mockToken(uid)}` } : {};
  const upload = (path, uid, contentType = "image/jpeg") => {
    const boundary = "seller-media-test-boundary";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify({ name: path, contentType })}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
      Buffer.from("ffd8ffe000104a4649460001", "hex"), Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return fetch(`${storage}?name=${encodeURIComponent(path)}`, { method: "POST", headers: { ...headers(uid), "X-Goog-Upload-Protocol": "multipart", "Content-Type": `multipart/related; boundary=${boundary}` }, body });
  };
  const get = (path, uid) => fetch(`${storage}/${encodeURIComponent(path)}?alt=media`, { headers: headers(uid) });
  const listing = { ownerId: "seller", sellerType: "private", status: "draft", listingPlan: "dealer-network-free", visibility: "dealer-network", accountActive: true };
  await seed("private-car", listing);
  const privatePath = "private-sellers/seller/cars/private-car/photo.jpg";
  const ownedUpload = await upload(privatePath, "seller");
  const uploadMetadata = await ownedUpload.json();
  assert.equal(ownedUpload.status, 200, `owner upload must pass: ${JSON.stringify(uploadMetadata)}`);
  const oldToken = uploadMetadata.downloadTokens;
  assert.ok(oldToken, "Firebase attaches an upload token even when SDK reads are denied");
  const tokenUrl = `${storage}/${encodeURIComponent(privatePath)}?alt=media&token=${encodeURIComponent(oldToken)}`;
  assert.equal((await fetch(tokenUrl)).status, 200, "upload token initially bypasses rules");
  const admin = require("firebase-admin");
  const app = admin.initializeApp({ projectId: project, storageBucket: bucket }, "seller-media-rules-test");
  try {
    const { scrubPrivateImageTokens } = require("./sellerMedia");
    // firebase-tools v15 keeps a separate downloadTokens array after deleting
    // the GCS metadata key. Real GCS metadata deletion must be checked in a test
    // bucket before rollout; the API must fail closed under this limitation.
    await assert.rejects(scrubPrivateImageTokens({ bucket: admin.storage(app).bucket(), images: [privatePath], ownerId: "seller", carId: "private-car" }), /revoke.*token/i);
    assert.equal((await fetch(tokenUrl)).status, 200, "emulator limitation is detected rather than accepting an unsafe image");
  } finally {
    await app.delete();
  }
  assert.equal((await upload("private-sellers/seller/cars/missing/photo.jpg", "seller")).status, 403, "car must exist in server mirror");
  assert.equal((await upload(privatePath, "other")).status, 403, "other seller cannot overwrite");
  assert.equal((await upload("private-sellers/seller/cars/private-car/not-image.svg", "seller", "image/svg+xml")).status, 403, "active image MIME must fail");
  assert.equal((await get(privatePath)).status, 403, "anonymous private bytes denied");
  assert.equal((await get(privatePath, "seller")).status, 403, "owner must use API byte route");
  const listUrl = `${storage}?prefix=${encodeURIComponent("private-sellers/seller/cars/private-car/")}`;
  assert.equal((await fetch(listUrl, { headers: headers("seller") })).status, 200, "owner recovery list allowed");
  assert.equal((await fetch(listUrl, { headers: headers("other") })).status, 403, "foreign recovery list denied");
  await seed("private-car", { ...listing, accountActive: false });
  assert.equal((await upload(privatePath, "seller")).status, 403, "inactive account cannot upload");
  const publicPath = "users/seller/cars/public-car/photo.jpg";
  assert.equal((await upload(publicPath, "owner")).status, 200);
  const publicListing = { ...listing, status: "published", listingPlan: "public-subscription", visibility: "public" };
  await seed("public-car", publicListing);
  assert.equal((await get(publicPath)).status, 200, "published paid advert image is public");
  await seed("public-car", { ...publicListing, status: "draft" });
  assert.equal((await get(publicPath)).status, 403, "withdrawn or lapsed advert image is not public");
  await seed("public-car", { ...listing, status: "published" });
  assert.equal((await get(publicPath)).status, 403, "dealer-only legacy image is not public");
});
