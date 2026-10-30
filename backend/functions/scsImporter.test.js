const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFirebaseDownloadUrl, mapWithConcurrency, mergeScsImportWithExisting, parseDetailPage, parseStockList, mapScsVehicleToCar } = require("./scsImporter");

const fixture = `
<div class="list-box"><div class="listing-box">
  <span class="imageover">3 MONTHS WARRANTY</span>
  <a href="https://www.scs-cars.com/cars/bmw/3series/3.0-335d/1093960/"><img src="https://img.example/stockimages/car.jpg" alt="BMW 3 SERIES 3.0 335d"></a>
  <img src="/admin/uploaded_photos/site_logo.png">
  <h2 class="sportsback">BMW 3 SERIES</h2><h3 class="sport-title">3.0 335d xDrive M Sport (2017)</h3>
  <h4 class="price">&pound;17,989</h4>
  <ul class="details-list">
    <li><span class="feature-box-title">CATEGORY</span><span class="feature-box-text">Saloon</span></li>
    <li><span class="feature-box-title">TRANSMISSION</span><span class="feature-box-text">Auto</span></li>
    <li><span class="feature-box-title">MILEAGE</span><span class="feature-box-text">82,000</span></li>
    <li><span class="feature-box-title">FUEL</span><span class="feature-box-text">Diesel</span></li>
    <li><span class="feature-box-title">CO2</span><span class="feature-box-text">145</span></li>
    <li><span class="feature-box-title">FORMER KEEPER</span><span class="feature-box-text">1</span></li>
    <li><span class="feature-box-title">COLOR</span><span class="feature-box-text">Black</span></li>
    <li><span class="feature-box-title">CC</span><span class="feature-box-text">2,993CC</span></li>
  </ul><p>Full service history and 2 keys.</p>
</div></div>`;

test("parseStockList extracts exact stock-card fields and source id", () => {
  const [vehicle] = parseStockList(fixture);
  assert.deepEqual(vehicle, {
    sourceId: "1093960",
    sourceUrl: "https://www.scs-cars.com/cars/bmw/3series/3.0-335d/1093960/",
    imageUrls: ["https://img.example/stockimages/car.jpg"],
    badge: "3 MONTHS WARRANTY",
    makeModel: "BMW 3 SERIES",
    title: "3.0 335d xDrive M Sport (2017)",
    price: 17989,
    fields: {
      category: "Saloon", transmission: "Auto", mileage: "82,000", fuel: "Diesel",
      co2: "145", formerKeeper: "1", color: "Black", cc: "2,993CC",
    },
    description: "Full service history and 2 keys.",
  });
});

test("mapScsVehicleToCar creates a draft under the requested user's contact profile", () => {
  const [vehicle] = parseStockList(fixture);
  const car = mapScsVehicleToCar(vehicle, {
    ownerId: "owner-1",
    now: "2026-08-20T00:00:00.000Z",
    seller: { displayName: "Dealer Owner", email: "dealer@example.com", phone: "07700900123" },
  });
  assert.equal(car.ownerId, "owner-1");
  assert.equal(car.status, "draft");
  assert.equal(car.contactName, "Dealer Owner");
  assert.equal(car.contactEmail, "dealer@example.com");
  assert.equal(car.contactPhone, "07700900123");
  assert.equal(car.ownerEmail, "dealer@example.com");
  assert.equal(car.make, "BMW");
  assert.equal(car.model, "3 SERIES");
  assert.equal(car.year, 2017);
  assert.equal(car.transmission, "Automatic");
  assert.equal(car.mileage, 82000);
  assert.equal(car.sourceId, "1093960");
  assert.equal(car.sourceUrl, vehicle.sourceUrl);
});

test("mapScsVehicleToCar omits previousOwners when SCS has no keeper value", () => {
  const [vehicle] = parseStockList(fixture);
  delete vehicle.fields.formerKeeper;
  const car = mapScsVehicleToCar(vehicle, { ownerId: "owner-1" });
  assert.equal(Object.hasOwn(car, "previousOwners"), false);
});

test("mergeScsImportWithExisting preserves admin publication controls during a stock refresh", () => {
  const refreshed = mergeScsImportWithExisting(
    { status: "draft", isFeatured: false, price: 15989 },
    { status: "published", isFeatured: true, publishedAt: "EXISTING_PUBLICATION_TIME" },
  );

  assert.deepEqual(refreshed, {
    status: "published",
    isFeatured: true,
    price: 15989,
    publishedAt: "EXISTING_PUBLICATION_TIME",
  });
});

test("buildFirebaseDownloadUrl uses a download token instead of a signed URL", () => {
  assert.equal(
    buildFirebaseDownloadUrl("jellylabsprojects.firebasestorage.app", "scs-cars/1297216/1.jpg", "download-token"),
    "https://firebasestorage.googleapis.com/v0/b/jellylabsprojects.firebasestorage.app/o/scs-cars%2F1297216%2F1.jpg?alt=media&token=download-token",
  );
});

test("parseDetailPage keeps stock images and rejects unrelated relative page images", () => {
  const result = parseDetailPage(`
    <img src="/admin/uploaded_photos/site_logo.png?nocache=192358">
    <img src="https://img-uk4.cd5.uk/originals/3247/stockimages/1093960/w1200/car.jpg">
  `, { imageUrls: ["https://img-uk4.cd5.uk/originals/3247/stockimages/1093960/w450/main.jpg"], description: "" });
  assert.deepEqual(result.imageUrls, [
    "https://img-uk4.cd5.uk/originals/3247/stockimages/1093960/w450/main.jpg",
    "https://img-uk4.cd5.uk/originals/3247/stockimages/1093960/w1200/car.jpg",
  ]);
});

test("mapWithConcurrency never exceeds the requested upload concurrency", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.equal(peak, 2);
});
