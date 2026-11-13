import crypto from "crypto";

export function normalizeQuestion(question) {
  return String(question || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function hashWorkbook(sheets) {
  const hash=crypto.createHash('sha256');
  for(const sheet of sheets){
    const part=crypto.createHash('sha256');
    if(sheet.contentHash)hash.update(sheet.contentHash);
    else {
      part.update(String(sheet.name||''));
      for(const row of sheet.rows)part.update(JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a],[b])=>a.localeCompare(b)))));
      hash.update(part.digest('hex'));
    }
  }
  return hash.digest('hex');
}

export function parseNumeric(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const negative = /^\(.*\)$/.test(trimmed);
  const unwrapped = negative ? trimmed.slice(1, -1).trim() : trimmed;
  // Currency at the start, percent at the end, standard comma grouping only.
  const numericText = unwrapped.replace(/^([$\u20ac\u00a3\u20b9])\s*/, '').replace(/\s*%$/, '');
  if (!/^[+-]?(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(numericText)) return null;
  if (negative && /^[+-]/.test(numericText)) return null;
  const cleaned = numericText.replace(/,/g, '');
  const number = Number(cleaned) * (negative ? -1 : 1);
  return Number.isFinite(number) ? number : null;
}

export const isBlank = value => value === null || value === undefined || (typeof value === "string" && !value.trim());
const dateLike = value => {
  if (value instanceof Date) return !Number.isNaN(value.valueOf());
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(value)) return false;
  const prefix = value.slice(0, 10), date = Date.parse(`${prefix}T00:00:00.000Z`);
  return Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === prefix && Number.isFinite(Date.parse(value));
};
const groupValue = value => isBlank(value) ? "(blank)" : String(value);

export function filterDataset(sheet, options = {}) {
  const columns = sheet.columns || Object.keys(sheet.rows[0] || {});
  const search = String(options.search || "").trim().toLocaleLowerCase();
  const categoryColumn = columns.includes(options.categoryColumn) ? options.categoryColumn : "";
  if(!search&&(!categoryColumn||options.categoryValue===undefined||options.categoryValue===''))return sheet.rows;
  return sheet.rows.filter(row => (!search || columns.some(c => String(row[c] ?? "").toLocaleLowerCase().includes(search))) &&
    (!categoryColumn || options.categoryValue === undefined || options.categoryValue === "" || groupValue(row[categoryColumn]) === options.categoryValue));
}

export function previewDataset(sheet, options = {}) {
  const columns = sheet.columns || Object.keys(sheet.rows[0] || {});
  let rows = filterDataset(sheet, options);
  if(columns.includes(options.sort))rows=rows.slice();
  if (columns.includes(options.sort)) rows.sort((a, b) => {
    const left = a[options.sort], right = b[options.sort];
    const ln = parseNumeric(left), rn = parseNumeric(right);
    const comparison = isBlank(left) ? (isBlank(right) ? 0 : 1) : isBlank(right) ? -1 : ln !== null && rn !== null ? ln - rn : String(left).localeCompare(String(right), undefined, { numeric: true });
    return comparison * (options.direction === 'desc' ? -1 : 1);
  });
  const pageSize = Math.min(100, Math.max(1, parseInt(options.pageSize, 10) || 25));
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(totalPages, Math.max(1, parseInt(options.page, 10) || 1));
  return { columns, rows: rows.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: rows.length, totalPages };
}

export function analyzeDataset(sheet, options = {}) {
  const columns = sheet.columns || Object.keys(sheet.rows[0] || {});
  const rows = filterDataset(sheet, options);
  const profile = source => Object.fromEntries(columns.map(column => {
    let present=0,numeric=0,dates=0;const values=new Set();
    for(const row of source){const value=row[column];if(isBlank(value))continue;present++;if(parseNumeric(value)!==null)numeric++;if(dateLike(value))dates++;values.add(String(value));}
    const unique=values.size;
    const type = !present ? 'text' : dates / present >= .8 ? 'date' : numeric / present >= .8 ? 'numeric' : unique <= Math.min(30, Math.max(2, Math.ceil(present * .25))) ? 'category' : 'text';
    return [column, { type, unique }];
  }));
  // Detect types from the full sheet, so filtering does not change chart columns.
  const schema = sheet.analytics?.columnStats ? Object.fromEntries(columns.map(column=>[column,{type:sheet.analytics.columnStats[column].type,unique:sheet.analytics.columnStats[column].unique}])) : profile(sheet.rows);
  const columnStats = Object.fromEntries(columns.map(column => {
    let missing = 0, numericCount = 0, sum = 0, min = Infinity, max = -Infinity, invalid = 0;
    const unique = new Set(); const type = schema[column].type;
    for (const row of rows) {
      const value = row[column];
      if (isBlank(value)) { missing++; continue; }
      unique.add(String(value));
      const n = parseNumeric(value);
      if (type === 'numeric' && n !== null) { numericCount++; sum += n; min = Math.min(min, n); max = Math.max(max, n); }
      else if ((type === 'numeric' && n === null) || (type === 'date' && !dateLike(value))) invalid++;
    }
    return [column, { type, count: rows.length, missing, unique: unique.size, invalid, numericCount, sum: numericCount ? sum : null, average: numericCount ? sum / numericCount : null, min: numericCount ? min : null, max: numericCount ? max : null }];
  }));
  const seen = new Set(); let duplicateRows = 0;
  for (const row of rows) { const key = crypto.createHash('sha256').update(JSON.stringify(columns.map(c => isBlank(row[c]) ? null : row[c]))).digest('hex'); if (seen.has(key)) duplicateRows++; else seen.add(key); }
  // Options always come from the original data, so a filtered value can be changed.
  const categories = sheet.analytics?.categories || Object.fromEntries(columns.filter(c => ['category', 'text'].includes(schema[c].type)).map(c => {const values=new Set();for(const row of sheet.rows){values.add(groupValue(row[c]));if(values.size===200)break;}return [c,[...values]];}));
  const numeric = columns.filter(c => schema[c].type === 'numeric');
  const category = columns.filter(c => schema[c].type === 'category');
  const dates = columns.filter(c => schema[c].type === 'date');
  const groupColumn = category[0] || columns.find(c => schema[c].type === 'text' && schema[c].unique <= 30);
  const grouped = groupColumn ? [...rows.reduce((map, row) => { const key = groupValue(row[groupColumn]); map.set(key, (map.get(key) || 0) + 1); return map; }, new Map())].map(([name, count]) => ({ name, count })).sort((a,b) => b.count-a.count) : [];
  const barData = grouped.slice(0, 12);
  const pie = grouped.slice(0, 6);
  const other = grouped.slice(6).reduce((sum, item) => sum + item.count, 0);
  if (other) pie.push({ name: 'Other groups (combined)', count: other });
  const metric = numeric.find(c => !/(^id$|[ _]id$|code|postal|zip|year)/i.test(c)) || numeric[0];
  const periodColumn = dates[0];
  const trend = periodColumn && metric ? [...rows.reduce((map, row) => {
    const n = parseNumeric(row[metric]);
    if (dateLike(row[periodColumn]) && n !== null) { const period = new Date(row[periodColumn]).toISOString().slice(0, 7); map.set(period, (map.get(period) || 0) + n); }
    return map;
  }, new Map())].sort(([a], [b]) => a.localeCompare(b)).slice(-24).map(([period, value]) => ({ period, value })) : [];
  const missingValues = Object.values(columnStats).reduce((sum, s) => sum + s.missing, 0);
  const findings = [`${rows.length} records match the selected worksheet and filters.`, `${missingValues} missing cells; ${duplicateRows} duplicate rows beyond their first occurrence.`];
  const kpis = numeric.filter(c => !/(^id$|[ _]id$|code|postal|zip|year)/i.test(c)).slice(0, 3).map(column => ({ column, label: `Average ${column}`, value: columnStats[column].average, hint: `${columnStats[column].numericCount} numeric values` }));
  for (const { column } of kpis) { const s = columnStats[column]; if (s.numericCount) findings.push(`${column}: average ${s.average.toLocaleString('en', { maximumFractionDigits: 4 })}; range ${s.min} to ${s.max} (${s.numericCount} numeric values).`); }
  if (grouped[0]) findings.push(`${grouped[0].name} is the largest ${groupColumn} group: ${grouped[0].count} records (${rows.length ? (grouped[0].count / rows.length * 100).toFixed(1) : 0}%).`);
  const warnings = [];
  if(sheet.headerRow>1) warnings.push(`Headers detected on Excel row ${sheet.headerRow}; preceding title/blank rows are excluded from records.`);
  if (sheet.formulaCount) warnings.push(`${sheet.formulaCount} formula cells: cached results only; formulas were not recalculated. ${sheet.uncachedFormulas || 0} cells without cached results are missing.`);
  const invalidValues = Object.values(columnStats).reduce((n, s) => n + s.invalid, 0);
  if (invalidValues) warnings.push(`${invalidValues} values do not match their inferred numeric/date column type and are excluded from those calculations.`);
  warnings.push('Types inferred from nonblank values (80% threshold). Dates use ISO YYYY-MM-DD. Numeric text retains its displayed units; percentages are percentage points. Blank physical Excel rows are excluded.');
  return { sheetName: sheet.name, rowCount: rows.length, totalRowCount: sheet.rows.length, columnCount: columns.length, duplicateRows, missingValues, invalidValues, completeness: rows.length * columns.length ? (1 - missingValues / (rows.length * columns.length)) * 100 : null, columnStats, columns, types: { numeric, category, date: dates, text: columns.filter(c => schema[c].type === 'text') }, categories, kpis, findings, warnings,
    charts: { bar: { title: groupColumn ? `Records by ${groupColumn}` : 'Records by category', data: barData, omittedGroups: Math.max(0, grouped.length - 12) }, pie, trend: { title: periodColumn && metric ? `${metric} by month` : 'Monthly trend', data: trend, valueColumn: metric || null, dateColumn: periodColumn || null } }, filteredRows: rows };
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
