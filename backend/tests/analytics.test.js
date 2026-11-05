import test from "node:test";
import assert from "node:assert/strict";
import { answerLocally, buildCompactSheetContext, hashWorkbook, parseNumeric, summarizeSheet } from "../analytics.js";

const sales = { name: "Sales", rows: [
  { Region: "North", Revenue: 125, Profit: 25, Month: "Jan" },
  { Region: "South", Revenue: 90, Profit: 10, Month: "Feb" },
  { Region: "North", Revenue: 125, Profit: 25, Month: "Jan" },
  { Region: "West", Revenue: null, Profit: -5, Month: "Mar" }
] };

test("numeric parsing handles formatted and parenthesized values", () => {
  assert.equal(parseNumeric("$1,250.50"), 1250.5);
  assert.equal(parseNumeric("(25)"), -25);
  assert.equal(parseNumeric("n/a"), null);
});

test("sheet statistics and local deterministic analytics calculate complete rows", () => {
  const stats = summarizeSheet(sales);
  assert.equal(stats.rowCount, 4);
  assert.equal(stats.duplicateRows, 1);
  assert.equal(stats.columnStats.Revenue.sum, 340);
  assert.equal(stats.columnStats.Revenue.missing, 1);
  assert.match(answerLocally([sales], "What is the total Revenue?"), /340/);
  assert.match(answerLocally([sales], "What is the average Revenue?"), /113\.3333/);
  assert.match(answerLocally([sales], "Which region has the highest Revenue?"), /North/);
  assert.match(answerLocally([sales], "Show Revenue by Region"), /North: 250/);
  assert.match(answerLocally([sales], "How many duplicate rows?"), /1 duplicate/);
  assert.match(answerLocally([sales], "Are there missing values?"), /Revenue: 1/);
});

test("workbook hashes are stable for key ordering and change when data changes", () => {
  assert.equal(hashWorkbook([sales]), hashWorkbook([{ name: "Sales", rows: sales.rows.map(row => Object.fromEntries(Object.entries(row).reverse())) }]));
  assert.notEqual(hashWorkbook([sales]), hashWorkbook([{ ...sales, rows: [...sales.rows, { Region: "East", Revenue: 5, Profit: 1, Month: "Apr" }] }]));
});

test("compact context is bounded and carries full-sheet statistics", () => {
  const data = { name: "Sales", rows: Array.from({ length: 500 }, (_, i) => ({ Region: `Region ${i}`, Revenue: i })) };
  const built = buildCompactSheetContext([data], "Explain what the latest regional changes mean.", 20, 1800);
  assert.ok(built.context.length <= 1800);
  assert.equal(built.sheetKey, "all-sheets");
});
