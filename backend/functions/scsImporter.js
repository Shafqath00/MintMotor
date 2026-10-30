const { FieldValue } = require("firebase-admin/firestore");
const { randomUUID } = require("node:crypto");

const SCS_STOCK_URL = "https://www.scs-cars.com/used/cars/sheffield/";
const DEFAULT_OWNER_ID = "2PvIZWRjzwR76Q3dxdizjkvhFjr1";

function decodeHtml(value = "") {
  return value.replace(/&pound;|&#163;/g, "£").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
}

function cleanText(value = "") {
  return decodeHtml(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")).trim();
}

function firstMatch(value, pattern) {
  return value.match(pattern)?.[1] || "";
}

function firstNonEmptyMatch(value, pattern) {
  for (const match of value.matchAll(pattern)) {
    if (cleanText(match[1])) return match[1];
  }
  return "";
}

function parseStockList(html) {
  return html.split('<div class="list-box">').slice(1)
    .map((chunk) => chunk.split('<div class="list-box">')[0])
    .map(parseStockCard)
    .filter(Boolean);
}

function parseStockCard(card) {
  const sourceUrl = firstMatch(card, /href="(https:\/\/www\.scs-cars\.com\/(?:cars|vans)\/[^\"]+)"/);
  const sourceId = sourceUrl.match(/\/(\d+)\/?$/)?.[1] || "";
  const imageUrls = [...card.matchAll(/<img[^>]+src="([^"]+)"/g)]
    .map((match) => decodeHtml(match[1]))
    .filter((url) => /^https:\/\//i.test(url) && /\/stockimages\//i.test(url));
  const fields = {};
  for (const match of card.matchAll(/<span class="feature-box-title(?: [^"]+)?">\s*([^<]+?)\s*<\/span>\s*<span class="feature-box-text">\s*([^<]*?)\s*<\/span>/g)) {
    const key = match[1].toLowerCase().replace(/\s+/g, "");
    fields[{ category: "category", transmission: "transmission", mileage: "mileage", fuel: "fuel", co2: "co2", formerkeeper: "formerKeeper", formerkeepers: "formerKeeper", ownerfromnew: "formerKeeper", color: "color", cc: "cc" }[key] || key] = cleanText(match[2]);
  }
  const title = cleanText(firstNonEmptyMatch(card, /<h3 class="sport-title">([\s\S]*?)<\/h3>/g));
  const description = cleanText(firstMatch(card, /<\/ul>\s*(?:<\/div>\s*)?<p>([\s\S]*?)<\/p>/));
  if (!sourceId || !sourceUrl || !title) return null;
  return {
    sourceId, sourceUrl, imageUrls, badge: cleanText(firstMatch(card, /<span class="imageover">([\s\S]*?)<\/span>/)),
    makeModel: cleanText(firstNonEmptyMatch(card, /<h2 class="sportsback">([\s\S]*?)<\/h2>/g)), title,
    price: Number(cleanText(firstMatch(card, /<h4 class="price">([\s\S]*?)<\/h4>/)).replace(/[^\d.]/g, "")), fields, description,
  };
}

function parseDetailPage(html, fallback) {
  const images = [...html.matchAll(/<img[^>]+(?:src|data-src)="([^"]+)"/g)]
    .map((match) => decodeHtml(match[1]))
    .filter((url) => /^https:\/\//i.test(url) && /\/stockimages\//i.test(url));
  const description = cleanText(firstMatch(html, /<div[^>]+class="[^"]*(?:vehicle-description|description)[^"]*"[^>]*>([\s\S]*?)<\/div>/i)) || fallback.description;
  return { ...fallback, imageUrls: [...new Set([...fallback.imageUrls, ...images])], description };
}

function normalizeTransmission(value) { return /^auto/i.test(value) ? "Automatic" : "Manual"; }
function normalizeFuel(value) { return /diesel/i.test(value) ? "Diesel" : /electric/i.test(value) ? "Electric" : /hybrid/i.test(value) ? "Hybrid" : "Petrol"; }
function parseYear(title) { return Number(title.match(/\((\d{4})\)/)?.[1] || new Date().getFullYear()); }

function buildFirebaseDownloadUrl(bucketName, path, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(path)}?alt=media&token=${encodeURIComponent(token)}`;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, worker));
  return results;
}

function mapScsVehicleToCar(vehicle, { ownerId = DEFAULT_OWNER_ID, now = new Date().toISOString(), seller = {} } = {}) {
  const knownMakes = ["LAND ROVER", "MERCEDES-BENZ", "VOLKSWAGEN", "RANGE ROVER", "BMW", "PORSCHE", "NISSAN", "AUDI", "FORD"];
  const matchedMake = knownMakes.find((candidate) => vehicle.makeModel.toUpperCase().startsWith(`${candidate} `));
  const make = matchedMake || vehicle.makeModel.trim().split(/\s+/)[0] || "Unknown";
  const model = vehicle.makeModel.slice(make.length).trim() || vehicle.title;
  const fields = vehicle.fields;
  const contactName = seller.displayName || "SCS Cars";
  const contactEmail = seller.email || "scscars1@hotmail.com";
  const contactPhone = seller.phone || "07432788077";
  const previousOwners = fields.formerKeeper === undefined || fields.formerKeeper === "" ? null : Number(fields.formerKeeper);
  return {
    ownerId, ownerEmail: contactEmail, sellerType: "dealer", status: "draft", source: "scs-cars", sourceId: vehicle.sourceId, sourceUrl: vehicle.sourceUrl,
    make, model, variant: vehicle.title.replace(/\s*\(\d{4}\)\s*$/, "").trim(), year: parseYear(vehicle.title), price: vehicle.price,
    mileage: Number((fields.mileage || "0").replace(/[^\d]/g, "")), fuelType: normalizeFuel(fields.fuel), transmission: normalizeTransmission(fields.transmission),
    bodyType: fields.category || "Other", engineSize: fields.cc || "", color: fields.color || "", location: "Sheffield", sellerPostcode: "S3 8JD",
    images: vehicle.imageUrls, description: vehicle.description, features: vehicle.badge ? [vehicle.badge] : [], attentionGrabber: vehicle.badge.slice(0, 60),
    contactName, contactEmail, contactPhone, showEmail: Boolean(contactEmail), showPhone: Boolean(contactPhone), allowEnquiries: true,
    isNew: false, isFeatured: false, co2Emissions: fields.co2 || "",
    ...(Number.isFinite(previousOwners) ? { previousOwners } : {}),
    createdAt: now, updatedAt: now,
  };
}

function mergeScsImportWithExisting(car, existing = {}) {
  const merged = { ...car };
  if (["draft", "published", "sold"].includes(existing.status)) merged.status = existing.status;
  if (typeof existing.isFeatured === "boolean") merged.isFeatured = existing.isFeatured;
  if (existing.publishedAt) merged.publishedAt = existing.publishedAt;
  return merged;
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "user-agent": "MintMotor SCS stock importer/1.0" } });
  if (!response.ok) throw new Error(`SCS request failed with status ${response.status}.`);
  return response.text();
}

async function downloadImages(imageUrls, sourceId) {
  const { storage } = require("./firebase");
  const bucket = storage.bucket();
  const urls = await mapWithConcurrency(imageUrls.slice(0, 20), 4, async (imageUrl, index) => {
    const response = await fetch(imageUrl);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    const path = `scs-cars/${sourceId}/${index + 1}.jpg`;
    const downloadToken = randomUUID();
    const file = bucket.file(path);
    await file.save(buffer, {
      metadata: {
        contentType: response.headers.get("content-type") || "image/jpeg",
        cacheControl: "public,max-age=86400",
        metadata: { firebaseStorageDownloadTokens: downloadToken },
      },
    });
    return buildFirebaseDownloadUrl(bucket.name, path, downloadToken);
  });
  return urls.filter(Boolean);
}

async function syncScsStock({ ownerId = DEFAULT_OWNER_ID, downloadStockImages = true } = {}) {
  const { admin, database } = require("./firebase");
  const [profileSnapshot, authUser] = await Promise.all([
    database.collection("users").doc(ownerId).get(),
    admin.auth().getUser(ownerId).catch(() => null),
  ]);
  const profile = profileSnapshot.exists ? profileSnapshot.data() : {};
  const seller = {
    displayName: profile.displayName || authUser?.displayName || "SCS Cars",
    email: profile.email || authUser?.email || "scscars1@hotmail.com",
    phone: profile.phone || authUser?.phoneNumber || "07432788077",
  };
  const listHtml = await fetchText(SCS_STOCK_URL);
  const stock = parseStockList(listHtml);
  const imported = [];
  for (const item of stock) {
    const detailed = await fetchText(item.sourceUrl).then((html) => parseDetailPage(html, item)).catch(() => item);
    const car = mapScsVehicleToCar(detailed, { ownerId, seller });
    if (downloadStockImages) car.images = await downloadImages(detailed.imageUrls, item.sourceId);
    const existing = await database.collection("cars").where("source", "==", "scs-cars").where("sourceId", "==", item.sourceId).limit(1).get();
    const existingCar = existing.empty ? null : existing.docs[0].data();
    const data = {
      ...mergeScsImportWithExisting(car, existingCar || {}),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (existing.empty) {
      data.createdAt = FieldValue.serverTimestamp();
      const ref = await database.collection("cars").add(data);
      imported.push({ id: ref.id, sourceId: item.sourceId, action: "created" });
    } else {
      await existing.docs[0].ref.set(data, { merge: true });
      imported.push({ id: existing.docs[0].id, sourceId: item.sourceId, action: "updated" });
    }
  }
  return { count: imported.length, imported };
}

module.exports = { DEFAULT_OWNER_ID, SCS_STOCK_URL, buildFirebaseDownloadUrl, mapWithConcurrency, parseStockList, parseDetailPage, mapScsVehicleToCar, mergeScsImportWithExisting, syncScsStock };
