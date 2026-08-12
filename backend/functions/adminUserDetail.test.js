const assert = require("node:assert/strict");
const test = require("node:test");
const { buildAdminUserDetail } = require("./adminUserDetail");

test("buildAdminUserDetail isolates a seller's activity and calculates live counts", () => {
  const result = buildAdminUserDetail({
    user: { uid: "seller-a", displayName: "Ava Seller" },
    cars: [
      { id: "car-old", ownerId: "seller-a", status: "published", createdAt: "2026-06-01T10:00:00.000Z" },
      { id: "car-new", ownerId: "seller-a", status: "sold", updatedAt: "2026-06-03T10:00:00.000Z" },
      { id: "other-car", ownerId: "seller-b", status: "draft", createdAt: "2026-06-04T10:00:00.000Z" },
    ],
    enquiries: [
      { id: "lead-old", sellerId: "seller-a", status: "closed", createdAt: "2026-06-01T10:00:00.000Z" },
      { id: "lead-new", sellerId: "seller-a", status: "new", createdAt: "2026-06-04T10:00:00.000Z" },
      { id: "other-lead", sellerId: "seller-b", status: "read", createdAt: "2026-06-05T10:00:00.000Z" },
    ],
  });

  assert.deepEqual(result.cars.map((car) => car.id), ["car-new", "car-old"]);
  assert.deepEqual(result.enquiries.map((enquiry) => enquiry.id), ["lead-new", "lead-old"]);
  assert.deepEqual(result.summary, {
    totalCars: 2,
    publishedCars: 1,
    draftCars: 0,
    soldCars: 1,
    totalEnquiries: 2,
    openEnquiries: 1,
  });
});

test("buildAdminUserDetail preserves the selected user and returns zero counts for new accounts", () => {
  const user = { uid: "seller-a", displayName: "Ava Seller" };
  const result = buildAdminUserDetail({ user, cars: [], enquiries: [] });

  assert.equal(result.user, user);
  assert.deepEqual(result.summary, {
    totalCars: 0,
    publishedCars: 0,
    draftCars: 0,
    soldCars: 0,
    totalEnquiries: 0,
    openEnquiries: 0,
  });
});
