const express = require("express");

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

function isSafeSegment(segment) {
  return typeof segment === "string" && segment.length > 0 && segment !== "." && segment !== ".." && !/[\\/%?#\u0000-\u001f\u007f]/.test(segment);
}

function isSafeOwnedImagePath(path, prefix, ownerId, carId) {
  if (!isSafeSegment(ownerId) || !isSafeSegment(carId) || typeof path !== "string") return false;
  const base = `${prefix}/${ownerId}/cars/${carId}/`;
  if (!path.startsWith(base)) return false;
  const tail = path.slice(base.length);
  return tail.length > 0 && tail.split("/").every(isSafeSegment);
}

function isSafePrivateImagePath(path, ownerId, carId) {
  return isSafeOwnedImagePath(path, "private-sellers", ownerId, carId);
}

// Only this bucket's canonical Firebase URL format is accepted. Never fetch a
// URL supplied by a listing: resolve its object name and use the Storage SDK.
function resolveSellerImagePath(image, ownerId, carId, bucketName) {
  if (isSafePrivateImagePath(image, ownerId, carId)) return image;
  if (isSafeOwnedImagePath(image, "users", ownerId, carId)) return image;
  if (typeof image !== "string") return null;
  try {
    const url = new URL(image);
    if (url.protocol !== "https:" || url.hostname !== "firebasestorage.googleapis.com" || url.port || url.username || url.password || url.hash) return null;
    const parts = url.pathname.match(/^\/v0\/b\/([^/]+)\/o\/([^/]+)$/);
    if (!parts || decodeURIComponent(parts[1]) !== bucketName) return null;
    const path = decodeURIComponent(parts[2]);
    return isSafeOwnedImagePath(path, "users", ownerId, carId) ? path : null;
  } catch {
    return null;
  }
}

function imageMatchesMime(bytes, contentType) {
  if (!Buffer.isBuffer(bytes)) return false;
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (contentType === "image/gif") return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  if (contentType === "image/webp") return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (contentType === "image/avif") return bytes.length >= 16 && bytes.subarray(4, 8).toString("ascii") === "ftyp" && ["avif", "avis"].some((brand) => bytes.subarray(8, Math.min(bytes.length, 40)).includes(Buffer.from(brand)));
  return false;
}

async function getRecord(database, collection, id) {
  const snapshot = await database.collection(collection).doc(id).get();
  return snapshot.exists ? snapshot.data() : null;
}

async function isAccountActive(database, uid, { allowPending = false } = {}) {
  const [deletion, user] = await Promise.all([
    getRecord(database, "accountDeletionRequests", uid),
    getRecord(database, "users", uid),
  ]);
  const blocked = allowPending ? ["finalizing", "completed"] : ["pending", "finalizing", "completed"];
  return !blocked.includes(deletion?.status) && !user?.deletedAt && user?.disabled !== true && !["deleted", "suspended", "disabled"].includes(user?.status);
}

function createSellerMediaRouter({ admin, database, storage, storageStatusDatabase, logger = console, isPublicMarketplaceCar }) {
  const router = express.Router();
  router.get("/cars/:id/images/:imageIndex", async (req, res) => {
    res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Authorization" });
    const authorization = req.get("authorization") || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    let user;
    try {
      if (token) {
        user = await admin.auth().verifyIdToken(token, true);
        if (!user?.uid) throw new Error("Invalid token subject");
      }
    } catch (error) {
      logger.warn?.("Seller image authentication failed");
      return res.status(401).json({ error: "Invalid authentication token." });
    }
    try {
      const { id, imageIndex } = req.params;
      if (!isSafeSegment(id) || !/^(0|[1-9]\d*)$/.test(imageIndex) || !Number.isSafeInteger(Number(imageIndex))) return res.status(404).json({ error: "Image not found." });
      const car = await getRecord(database, "cars", id);
      if (!car || !isSafeSegment(car.ownerId)) return res.status(404).json({ error: "Image not found." });
      const publicPolicy = isPublicMarketplaceCar || require("./sellerPolicy").isPublicMarketplaceCar;
      const publiclyVisible = publicPolicy(car);
      if (!user && !publiclyVisible) return res.status(401).json({ error: "Authentication is required." });
      const isOwner = user?.uid === car.ownerId;
      const [callerActive, ownerActive] = await Promise.all([
        user ? isAccountActive(database, user.uid, { allowPending: isOwner }) : true,
        isAccountActive(database, car.ownerId, { allowPending: isOwner || publiclyVisible }),
      ]);
      if (!callerActive || !ownerActive) return res.status(403).json({ error: "Account access is not active." });
      if (!publiclyVisible && !isOwner && user.role !== "admin") {
        if (user.role !== "dealer" || user.email_verified !== true || car.sellerType !== "private" || car.listingPlan !== "dealer-network-free" || car.visibility !== "dealer-network" || car.status !== "published") return res.status(403).json({ error: "Approved dealer access is required." });
        const dealer = await getRecord(database, "dealers", user.uid);
        const mirror = storageStatusDatabase ? await getRecord(storageStatusDatabase, "storageDealerStatus", user.uid) : null;
        if (dealer?.dealerStatus !== "approved" || (storageStatusDatabase && mirror?.dealerStatus !== "approved")) return res.status(403).json({ error: "Dealer access is not active." });
      }
      const bucket = storage.bucket();
      const image = Array.isArray(car.images) ? car.images[Number(imageIndex)] : null;
      const path = resolveSellerImagePath(image, car.ownerId, id, bucket.name);
      if (!path) return res.status(404).json({ error: "Image not found." });
      const file = bucket.file(path);
      const [metadata] = await file.getMetadata();
      const contentType = metadata.contentType?.toLowerCase();
      if (!IMAGE_TYPES.has(contentType) || !Number.isFinite(Number(metadata.size)) || Number(metadata.size) <= 0 || Number(metadata.size) >= MAX_IMAGE_BYTES) return res.status(404).json({ error: "Image not found." });
      const [bytes] = await file.download();
      if (bytes.length >= MAX_IMAGE_BYTES || !imageMatchesMime(bytes, contentType)) return res.status(404).json({ error: "Image not found." });
      res.set("Content-Type", contentType);
      return res.status(200).send(bytes);
    } catch (error) {
      if (Number(error.code) === 404) return res.status(404).json({ error: "Image not found." });
      logger.error?.("Unable to read seller image", error);
      return res.status(503).json({ error: "Unable to load image." });
    }
  });
  return router;
}

function migrationError(message) {
  return Object.assign(new Error(message), { code: "SELLER_MEDIA_MIGRATION_UNSAFE" });
}

async function verifyDownloadTokensRevoked(file) {
  const [metadata] = await file.getMetadata();
  if (metadata.metadata?.firebaseStorageDownloadTokens) throw migrationError("Storage did not revoke the image download token; listing persistence is blocked.");
}

// Firebase can attach a download token at upload time. Clearing it server-side
// before accepting the path prevents an accidentally retained token URL from
// bypassing authenticated media delivery after the listing is saved.
async function scrubPrivateImageTokens({ bucket, images, ownerId, carId }) {
  if (!Array.isArray(images) || images.some((path) => !isSafePrivateImagePath(path, ownerId, carId))) throw migrationError("Unsupported private seller image owner or path.");
  const files = await Promise.all([...new Set(images)].map(async (path) => {
    const file = bucket.file(path);
    const [metadata] = await file.getMetadata();
    if (!IMAGE_TYPES.has(metadata.contentType?.toLowerCase()) || !Number.isFinite(Number(metadata.size)) || Number(metadata.size) <= 0 || Number(metadata.size) >= MAX_IMAGE_BYTES) throw migrationError("Unsupported seller image type or size.");
    return { file, metadata };
  }));
  for (const { file, metadata } of files) {
    if (metadata.metadata?.firebaseStorageDownloadTokens || metadata.cacheControl !== "private, no-store") {
      await file.setMetadata({ cacheControl: "private, no-store", metadata: { firebaseStorageDownloadTokens: null } });
      await verifyDownloadTokensRevoked(file);
    }
  }
  return images;
}

/**
 * Phase 1: copy validated legacy objects without changing or revoking sources.
 * Persist the returned images array to the car, then read it back and supply it
 * to finalizeSellerListingImages. A failure between phases leaves originals
 * intact, so retrying cannot strand the listing with broken photos.
 */
async function prepareSellerListingImages({ bucket, car, carId, dryRun = true }) {
  if (!bucket?.name || !isSafeSegment(car?.ownerId) || !isSafeSegment(carId) || !Array.isArray(car.images)) throw migrationError("Unsupported seller image migration input.");
  const migrations = [];
  const images = car.images.map((image) => {
    const source = resolveSellerImagePath(image, car.ownerId, carId, bucket.name);
    if (!source) throw migrationError("Unsupported or foreign seller image; manual review required.");
    if (isSafePrivateImagePath(source, car.ownerId, carId)) return source;
    const destination = source.replace(/^users\//, "private-sellers/");
    if (!migrations.some((item) => item.source === source)) migrations.push({ source, destination });
    return destination;
  });
  // Inspect every source before starting copies, so bad references or missing
  // objects cannot leave a partially copied batch mistaken for complete.
  const sources = await Promise.all(migrations.map(async (item) => {
    const [metadata] = await bucket.file(item.source).getMetadata();
    if (!IMAGE_TYPES.has(metadata.contentType?.toLowerCase()) || Number(metadata.size) <= 0 || Number(metadata.size) >= MAX_IMAGE_BYTES || !Number.isFinite(Number(metadata.size))) throw migrationError("Unsupported seller image type or size; manual review required.");
    return { ...item, metadata };
  }));
  if (!dryRun) {
    for (const item of sources) {
      const destination = bucket.file(item.destination);
      const metadata = { ...item.metadata.metadata, firebaseStorageDownloadTokens: null };
      await bucket.file(item.source).copy(destination, { metadata: { contentType: item.metadata.contentType, cacheControl: "private, no-store", metadata } });
      // Explicitly clear Firebase tokens even if a client-library copy preserves
      // inherited source metadata. No token URLs are ever persisted or returned.
      await destination.setMetadata({ cacheControl: "private, no-store", metadata });
      await verifyDownloadTokensRevoked(destination);
    }
  }
  return { bucketName: bucket.name, ownerId: car.ownerId, carId, images, migrations, changed: migrations.length > 0, dryRun };
}

/** Phase 2: call only after the private image paths have been persisted. */
async function finalizeSellerListingImages({ bucket, plan, persistedImages, dryRun = true }) {
  if (!plan || plan.bucketName !== bucket?.name || !Array.isArray(plan.images) || !Array.isArray(plan.migrations) || JSON.stringify(persistedImages) !== JSON.stringify(plan.images)) throw migrationError("Private image paths must be persisted before finalizing seller media.");
  if (plan.images.some((path) => !isSafePrivateImagePath(path, plan.ownerId, plan.carId))) throw migrationError("Unsupported private seller image path.");
  for (const { source, destination } of plan.migrations) {
    if (!isSafeOwnedImagePath(source, "users", plan.ownerId, plan.carId) || !isSafePrivateImagePath(destination, plan.ownerId, plan.carId) || !plan.images.includes(destination)) throw migrationError("Unsupported seller image migration source.");
    if (dryRun) continue;
    if (plan.dryRun) throw migrationError("A dry-run plan cannot be finalized; prepare private images first.");
    const [copied] = await bucket.file(destination).exists();
    if (!copied) throw migrationError("Private image copy is missing; source remains intact.");
    await verifyDownloadTokensRevoked(bucket.file(destination));
    const original = bucket.file(source);
    const [exists] = await original.exists();
    if (!exists) continue;
    await original.setMetadata({ metadata: { firebaseStorageDownloadTokens: null }, cacheControl: "private, no-store" });
    await original.delete({ ignoreNotFound: true });
  }
  return { finalized: !dryRun, count: plan.migrations.length, dryRun };
}

module.exports = { createSellerMediaRouter, isSafePrivateImagePath, resolveSellerImagePath, scrubPrivateImageTokens, prepareSellerListingImages, protectSellerListingImages: prepareSellerListingImages, finalizeSellerListingImages };
