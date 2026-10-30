// In-memory Firestore stand-in for tests. Supports the subset the admin modules use:
// where (==, !=, in, <, <=, >, >=, array-contains), orderBy, limit, startAfter, add, batch and transactions.
const getPath = (data, path) => path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), data);
const millis = (value) => (value?.toMillis ? value.toMillis() : value instanceof Date ? value.getTime() : value);

function compare(op, actual, expected) {
  const a = millis(actual), b = millis(expected);
  switch (op) {
    case "==": return a === b;
    case "!=": return a !== b;
    case "in": return expected.includes(actual);
    case "array-contains": return Array.isArray(actual) && actual.includes(expected);
    case "<": return a != null && a < b;
    case "<=": return a != null && a <= b;
    case ">": return a != null && a > b;
    case ">=": return a != null && a >= b;
    default: throw new Error(`Unsupported operator ${op}`);
  }
}

function createTestDb(seed = {}) {
  const store = new Map();
  let sequence = 0;
  const table = (name) => { if (!store.has(name)) store.set(name, new Map()); return store.get(name); };
  for (const [name, rows] of Object.entries(seed)) for (const [id, data] of Object.entries(rows)) table(name).set(id, structuredClone(data));

  function snapshot(name, id) {
    const rows = table(name);
    // Like Firestore, a snapshot is a copy taken at read time and doesn't change if the document later does.
    const copy = rows.has(id) ? structuredClone(rows.get(id)) : undefined;
    return { id, exists: rows.has(id), ref: docRef(name, id), data: () => (copy ? structuredClone(copy) : undefined) };
  }
  function docRef(name, id) {
    const rows = table(name);
    return {
      id,
      async get() { return snapshot(name, id); },
      async set(value, options = {}) { rows.set(id, options.merge ? { ...(rows.get(id) || {}), ...value } : { ...value }); },
      async update(value) { if (!rows.has(id)) throw new Error("NOT_FOUND"); rows.set(id, { ...rows.get(id), ...value }); },
      async delete() { rows.delete(id); },
    };
  }
  function query(name, filters = [], order = null, max = null, after = null) {
    const api = {
      where: (field, op, value) => query(name, [...filters, [field, op, value]], order, max, after),
      orderBy: (field, dir = "asc") => query(name, filters, [field, dir], max, after),
      limit: (n) => query(name, filters, order, n, after),
      startAfter: (value) => query(name, filters, order, max, value),
      async get() {
        let docs = [...table(name).entries()].filter(([, data]) => filters.every(([f, op, v]) => compare(op, getPath(data, f), v)));
        if (order) {
          const [field, dir] = order;
          docs.sort(([, x], [, y]) => (millis(getPath(x, field)) > millis(getPath(y, field)) ? 1 : -1) * (dir === "desc" ? -1 : 1));
          if (after != null) docs = docs.filter(([, d]) => (dir === "desc" ? millis(getPath(d, field)) < after : millis(getPath(d, field)) > after));
        }
        if (max != null) docs = docs.slice(0, max);
        const result = docs.map(([id]) => snapshot(name, id));
        return { docs: result, size: result.length, empty: result.length === 0 };
      },
      count: () => ({ async get() { const { size } = await api.get(); return { data: () => ({ count: size }) }; } }),
    };
    return api;
  }
  const db = {
    store,
    collection(name) {
      return {
        ...query(name),
        doc: (id = `${name}-${++sequence}`) => docRef(name, id),
        async add(value) { const ref = docRef(name, `${name}-${++sequence}`); await ref.set(value); return ref; },
      };
    },
    batch() {
      const ops = [];
      return {
        set: (ref, value, options) => { ops.push(() => ref.set(value, options)); },
        update: (ref, value) => { ops.push(() => ref.update(value)); },
        delete: (ref) => { ops.push(() => ref.delete()); },
        async commit() { for (const op of ops) await op(); },
      };
    },
    async runTransaction(fn) {
      return fn({
        get: (ref) => ref.get(),
        set: (ref, value, options) => ref.set(value, options),
        update: (ref, value) => ref.update(value),
        delete: (ref) => ref.delete(),
        create: (ref, value) => ref.set(value),
      });
    },
    rows: (name) => Object.fromEntries(table(name)),
  };
  return db;
}

module.exports = { createTestDb };
