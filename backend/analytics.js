import crypto from "crypto";

export function normalizeQuestion(question) {
  return String(question || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function hashWorkbook(sheets) {
  const normalized = sheets.map(sheet => ({
    name: String(sheet.name || ""),
    rows: sheet.rows.map(row => Object.fromEntries(Object.entries(row)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value])))
  }));
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function parseNumeric(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const negative = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed.replace(/[(),$€£₹%\s]/g, "").replace(/,/g, "");
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const number = Number(cleaned) * (negative ? -1 : 1);
  return Number.isFinite(number) ? number : null;
}

export function summarizeSheet(sheet) {
  const columns = Object.keys(sheet.rows[0] || {});
  const columnStats = Object.fromEntries(columns.map(column => {
    const values = sheet.rows.map(row => row[column]);
    const numericValues = values.map(parseNumeric).filter(value => value !== null);
    const present = values.filter(value => value !== null && value !== undefined && String(value).trim() !== "");
    const sum = numericValues.reduce((total, value) => total + value, 0);
    return [column, {
      type: numericValues.length && numericValues.length >= present.length * 0.7 ? "numeric" : "categorical",
      count: values.length,
      missing: values.length - present.length,
      unique: new Set(present.map(value => String(value).trim().toLocaleLowerCase())).size,
      numericCount: numericValues.length,
      sum: numericValues.length ? sum : null,
      average: numericValues.length ? sum / numericValues.length : null,
      min: numericValues.length ? numericValues.reduce((best, value) => Math.min(best, value), Infinity) : null,
      max: numericValues.length ? numericValues.reduce((best, value) => Math.max(best, value), -Infinity) : null
    }];
  }));
  const serialized = new Set();
  let duplicateRows = 0;
  for (const row of sheet.rows) {
    const key = JSON.stringify(row, columns);
    if (serialized.has(key)) duplicateRows++;
    serialized.add(key);
  }
  return { sheetName: sheet.name, rowCount: sheet.rows.length, columnCount: columns.length, duplicateRows, columnStats };
}

function findColumn(sheet, query, predicate = () => true) {
  const columns = Object.keys(sheet.rows[0] || {}).filter(predicate);
  const lower = query.toLocaleLowerCase();
  return columns.find(column => lower.includes(column.toLocaleLowerCase()))
    || columns.find(column => column.toLocaleLowerCase().split(/\W+/).some(word => word.length > 2 && lower.includes(word)))
    || null;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
}

export function answerLocally(sheets, question) {
  const q = normalizeQuestion(question);
  const targetSheet = sheets.find(sheet => q.includes(sheet.name.toLocaleLowerCase())) || sheets[0];
  if (!targetSheet) return null;
  if (/\b(recommendations?|comprehensive analysis|full analysis|trends? and anomalies)\b/.test(q)) return null;
  const stats = summarizeSheet(targetSheet);
  const rows = targetSheet.rows;
  if (/\b(duplicate|duplicated)\b/.test(q)) return `There are ${stats.duplicateRows} duplicate rows in ${targetSheet.name}.`;
  if (/\b(how many|number of|count of)\b.*\b(rows?|records?)\b|\b(row|record) count\b/.test(q)) {
    return `There are ${stats.rowCount} data rows in ${targetSheet.name}.`;
  }
  if (/\b(missing|null|blank|empty)\b/.test(q)) {
    const columns = Object.entries(stats.columnStats).filter(([, value]) => value.missing > 0).map(([name, value]) => `${name}: ${value.missing}`);
    return columns.length ? `Missing values in ${targetSheet.name}: ${columns.join(", ")}.` : `There are no missing values in ${targetSheet.name}.`;
  }
  const numericColumns = Object.keys(stats.columnStats).filter(column => stats.columnStats[column].type === "numeric");
  const metricColumn = findColumn(targetSheet, q, column => stats.columnStats[column].type === "numeric")
    || (numericColumns.length && /\b(value|amount|total|sum|average|avg|mean|highest|lowest|maximum|minimum)\b/.test(q) ? numericColumns[0] : null);
  if (/\b(rank|ranking|sort|sorted|top)\b/.test(q) && metricColumn) {
    const categoryColumn = findColumn(targetSheet, q, column => column !== metricColumn && stats.columnStats[column].type === "categorical");
    const rankedRows = rows.map(row => ({ row, value: parseNumeric(row[metricColumn]) })).filter(item => item.value !== null).sort((a, b) => b.value - a.value).slice(0, 10);
    if (rankedRows.length) return `Ranking by ${metricColumn} in ${targetSheet.name}: ${rankedRows.map((item, index) => `${index + 1}. ${categoryColumn ? item.row[categoryColumn] : `Row ${rows.indexOf(item.row) + 1}`} (${formatNumber(item.value)})`).join("; ")}.`;
  }
  if (/\b(percent(?:age)?|share|proportion)\b/.test(q) && metricColumn && /\b(total|overall|each|by|per|category)\b/.test(q)) {
    const total = stats.columnStats[metricColumn].sum;
    const categoryColumn = findColumn(targetSheet, q, column => column !== metricColumn && stats.columnStats[column].type === "categorical");
    if (total && categoryColumn) {
      const groups = new Map();
      for (const row of rows) {
        const value = parseNumeric(row[metricColumn]);
        if (value !== null) groups.set(String(row[categoryColumn] ?? "(blank)"), (groups.get(String(row[categoryColumn] ?? "(blank)")) || 0) + value);
      }
      return `Share of total ${metricColumn} by ${categoryColumn}: ${[...groups].map(([name, value]) => `${name}: ${formatNumber(value / total * 100)}%`).join("; ")}.`;
    }
    if (total) return `${metricColumn} totals ${formatNumber(total)}; 100% of the recorded total.`;
  }
  if (/\b(growth|growth rate|percent(?:age)? change|increased by|decreased by)\b/.test(q) && metricColumn) {
    const periodColumn = findColumn(targetSheet, q, column => /date|month|period|quarter|year/i.test(column) && stats.columnStats[column].type === "categorical");
    if (periodColumn) {
      const points = new Map();
      for (const row of rows) {
        const value = parseNumeric(row[metricColumn]);
        if (value === null) continue;
        const period = String(row[periodColumn] ?? "(blank)");
        points.set(period, (points.get(period) || 0) + value);
      }
      const series = [...points];
      if (series.length >= 2 && series[0][1] !== 0) {
        const change = (series.at(-1)[1] - series[0][1]) / Math.abs(series[0][1]) * 100;
        return `${metricColumn} changed ${change >= 0 ? "by" : "by"} ${formatNumber(change)}% from ${series[0][0]} (${formatNumber(series[0][1])}) to ${series.at(-1)[0]} (${formatNumber(series.at(-1)[1])}) in ${targetSheet.name}.`;
      }
    }
  }
  if (/\b(profit|loss)\b/.test(q)) {
    const profitColumn = findColumn(targetSheet, q, column => /profit|loss/i.test(column) && stats.columnStats[column].type === "numeric");
    if (profitColumn) return `${profitColumn} totals ${formatNumber(stats.columnStats[profitColumn].sum)} across ${stats.columnStats[profitColumn].numericCount} numeric values in ${targetSheet.name}.`;
  }
  if (/\b(trend|monthly|month|compare|comparison|over time)\b/.test(q) && metricColumn) {
    const periodColumn = findColumn(targetSheet, q, column => /date|month|period|year/i.test(column) && stats.columnStats[column].type === "categorical");
    if (periodColumn) {
      const points = new Map();
      for (const row of rows) {
        const value = parseNumeric(row[metricColumn]);
        if (value === null) continue;
        const period = String(row[periodColumn] ?? "(blank)");
        points.set(period, (points.get(period) || 0) + value);
      }
      const series = [...points].slice(-12);
      if (series.length) return `${metricColumn} trend in ${targetSheet.name}: ${series.map(([period, value]) => `${period} ${formatNumber(value)}`).join("; ")}.`;
    }
  }
  if (/\b(average|avg|mean)\b/.test(q) && metricColumn) return `The average ${metricColumn} is ${formatNumber(stats.columnStats[metricColumn].average)} in ${targetSheet.name}.`;
  if (/\b(sum|total|combined)\b/.test(q) && metricColumn && !/\b(by|per|category|grouped|group)\b/.test(q)) return `The total ${metricColumn} is ${formatNumber(stats.columnStats[metricColumn].sum)} in ${targetSheet.name}.`;
  if (/\b(by|per|category|grouped|group)\b/.test(q) && metricColumn) {
    const categoryColumn = findColumn(targetSheet, q, column => stats.columnStats[column].type === "categorical");
    if (categoryColumn) {
      const groups = new Map();
      for (const row of rows) {
        const name = String(row[categoryColumn] ?? "(blank)");
        const value = parseNumeric(row[metricColumn]);
        const group = groups.get(name) || { count: 0, sum: 0 };
        group.count++;
        if (value !== null) group.sum += value;
        groups.set(name, group);
      }
      const report = [...groups].map(([name, group]) => `${name}: ${formatNumber(group.sum)} (${group.count} rows)`).join("; ");
      return `Total ${metricColumn} by ${categoryColumn} in ${targetSheet.name}: ${report}.`;
    }
  }
  if (/\b(highest|maximum|max|largest|most)\b/.test(q) && metricColumn) {
    const value = rows.reduce((best, row) => Math.max(best, parseNumeric(row[metricColumn]) ?? -Infinity), -Infinity);
    const row = rows.find(item => parseNumeric(item[metricColumn]) === value);
    return row ? `The highest ${metricColumn} is ${formatNumber(value)}${Object.entries(row).filter(([key]) => key !== metricColumn).slice(0, 2).map(([key, cell]) => ` (${key}: ${cell})`).join("")}.` : null;
  }
  if (/\b(lowest|minimum|min|smallest|least)\b/.test(q) && metricColumn) {
    const value = rows.reduce((best, row) => Math.min(best, parseNumeric(row[metricColumn]) ?? Infinity), Infinity);
    const row = rows.find(item => parseNumeric(item[metricColumn]) === value);
    return row ? `The lowest ${metricColumn} is ${formatNumber(value)}${Object.entries(row).filter(([key]) => key !== metricColumn).slice(0, 2).map(([key, cell]) => ` (${key}: ${cell})`).join("")}.` : null;
  }
  if (/\b(columns?|fields?)\b/.test(q) && /\b(how many|number|list|what|which)\b/.test(q)) return `There are ${stats.columnCount} columns: ${Object.keys(stats.columnStats).join(", ")}.`;
  if (/\b(outlier|anomal|unusual)\w*\b/.test(q)) {
    const columns = numericColumns.map(column => {
      const values = rows.map(row => parseNumeric(row[column])).filter(value => value !== null).sort((a, b) => a - b);
      if (values.length < 4) return null;
      const q1 = values[Math.floor((values.length - 1) * 0.25)];
      const q3 = values[Math.floor((values.length - 1) * 0.75)];
      const spread = q3 - q1;
      const low = q1 - 1.5 * spread, high = q3 + 1.5 * spread;
      const outliers = rows.filter(row => { const value = parseNumeric(row[column]); return value !== null && (value < low || value > high); });
      return outliers.length ? `${column}: ${outliers.length} outlier(s)` : null;
    }).filter(Boolean);
    return columns.length ? `Potential outliers in ${targetSheet.name}: ${columns.join("; ")}.` : `No IQR outliers were detected in ${targetSheet.name}.`;
  }
  if (/\b(summary|summarize|summarise|overview|key metrics|financial summary)\b/.test(q) && !/\brecommendations?\b/.test(q)) {
    const numeric = Object.entries(stats.columnStats).filter(([, value]) => value.type === "numeric");
    return `${targetSheet.name} has ${stats.rowCount} rows and ${stats.columnCount} columns. ${numeric.slice(0, 5).map(([name, value]) => `${name}: total ${formatNumber(value.sum)}, average ${formatNumber(value.average)}, range ${formatNumber(value.min)} to ${formatNumber(value.max)}`).join(". ")}. ${stats.duplicateRows} duplicate rows were found.`;
  }
  return null;
}

export function buildCompactSheetContext(sheets, question, maxRows = 30, maxChars = 14000) {
  const q = normalizeQuestion(question);
  const requestedSheet = sheets.find(sheet => q.includes(sheet.name.toLocaleLowerCase()));
  const chosen = requestedSheet ? [requestedSheet] : sheets;
  const result = chosen.map(sheet => {
    const stats = summarizeSheet(sheet);
    const terms = q.match(/[\p{L}\p{N}]{3,}/gu) || [];
    const rankedRows = sheet.rows.map((row, index) => ({ row, index, score: terms.reduce((score, term) => score + (JSON.stringify(row).toLocaleLowerCase().includes(term) ? 1 : 0), 0) }))
      .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, maxRows).sort((a, b) => a.index - b.index).map(item => item.row);
    return { sheet: sheet.name, statistics: stats, relevantRows: rankedRows };
  });
  let context = JSON.stringify(result);
  while (context.length > maxChars && maxRows > 3) {
    maxRows = Math.floor(maxRows / 2);
    for (const item of result) item.relevantRows = item.relevantRows.slice(0, maxRows);
    context = JSON.stringify(result);
  }
  return { context: context.slice(0, maxChars), sheetKey: requestedSheet?.name || "all-sheets" };
}
