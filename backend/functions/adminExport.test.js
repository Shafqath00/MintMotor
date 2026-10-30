const test = require("node:test");
const assert = require("node:assert/strict");
const { csvCell, toCsv, EXPORTS, pounds } = require("./adminExport");
const { PERMISSIONS } = require("./adminRoles");

test("quotes commas, quotes and newlines", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell("two\nlines"), '"two\nlines"');
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(0), "0");
});

test("neutralises spreadsheet formulas in user-controlled text", () => {
  for (const evil of ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\tcmd"]) assert.ok(csvCell(evil).replace(/^"/, "").startsWith("'"), evil);
  assert.equal(csvCell("a=b"), "a=b");
});

test("writes a header, a BOM for Excel and CRLF rows with computed columns", () => {
  const csv = toCsv([{ label: "Name", key: "name" }, { label: "Paid", value: (row) => pounds(row.pence) }], [{ name: "A, B", pence: 9900 }, { name: "C", pence: undefined }]);
  assert.equal(csv, "﻿Name,Paid\r\n\"A, B\",99.00\r\nC,\r\n");
});

test("every export names a real permission and has unique column labels", () => {
  for (const [type, definition] of Object.entries(EXPORTS)) {
    assert.ok(PERMISSIONS.includes(definition.permission), type);
    const labels = definition.columns.map((c) => c.label);
    assert.equal(new Set(labels).size, labels.length, type);
  }
  assert.deepEqual(Object.keys(EXPORTS).sort(), ["activity", "dealers", "listings", "payments", "subscriptions", "users"]);
});
