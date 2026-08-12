function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function buildSummary(cars, enquiries) {
  return {
    totalCars: cars.length,
    publishedCars: cars.filter((car) => car.status === "published").length,
    draftCars: cars.filter((car) => car.status === "draft").length,
    soldCars: cars.filter((car) => car.status === "sold").length,
    totalEnquiries: enquiries.length,
    openEnquiries: enquiries.filter((enquiry) => enquiry.status !== "closed").length,
  };
}

function buildAdminUserDetail({ user, cars, enquiries }) {
  const userCars = cars
    .filter((car) => car.ownerId === user.uid)
    .sort((a, b) => toMillis(b.updatedAt || b.createdAt) - toMillis(a.updatedAt || a.createdAt));
  const userEnquiries = enquiries
    .filter((enquiry) => enquiry.sellerId === user.uid)
    .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));

  return {
    user,
    cars: userCars,
    enquiries: userEnquiries,
    summary: buildSummary(userCars, userEnquiries),
  };
}

module.exports = { buildAdminUserDetail };
