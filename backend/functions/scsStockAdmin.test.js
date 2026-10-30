const test = require("node:test");
const assert = require("node:assert/strict");

const { updateScsStockStatus } = require("./scsStockAdmin");

function createFakeDatabase(cars) {
  const writes = [];
  return {
    writes,
    collection(name) {
      assert.equal(name, "cars");
      return {
        where(field, operator, value) {
          assert.deepEqual([field, operator, value], ["source", "==", "scs-cars"]);
          return {
            async get() {
              return {
                docs: cars
                  .filter((car) => car.source === "scs-cars")
                  .map((car) => ({ id: car.id, ref: { id: car.id }, data: () => car })),
              };
            },
          };
        },
      };
    },
    batch() {
      const pending = [];
      return {
        set(ref, patch, options) {
          pending.push({ id: ref.id, patch, options });
        },
        async commit() {
          writes.push(...pending);
        },
      };
    },
  };
}

test("publishes only SCS stock and records publication timestamps", async () => {
  const database = createFakeDatabase([
    { id: "scs-1", source: "scs-cars", status: "draft" },
    { id: "private-1", source: "private", status: "draft" },
  ]);

  const result = await updateScsStockStatus({
    database,
    status: "published",
    timestamp: "SERVER_TIME",
  });

  assert.deepEqual(result, { count: 1, status: "published" });
  assert.deepEqual(database.writes, [{
    id: "scs-1",
    patch: { status: "published", updatedAt: "SERVER_TIME", publishedAt: "SERVER_TIME" },
    options: { merge: true },
  }]);
});

test("returns SCS stock to draft without changing unrelated listings", async () => {
  const database = createFakeDatabase([
    { id: "scs-1", source: "scs-cars", status: "published" },
    { id: "other-1", source: "manual", status: "published" },
  ]);

  const result = await updateScsStockStatus({ database, status: "draft", timestamp: "SERVER_TIME" });

  assert.deepEqual(result, { count: 1, status: "draft" });
  assert.deepEqual(database.writes, [{
    id: "scs-1",
    patch: { status: "draft", updatedAt: "SERVER_TIME" },
    options: { merge: true },
  }]);
});

test("rejects unsupported bulk statuses", async () => {
  const database = createFakeDatabase([]);

  await assert.rejects(
    updateScsStockStatus({ database, status: "sold", timestamp: "SERVER_TIME" }),
    /published or draft/i,
  );
});
