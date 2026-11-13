const count = value => Number.isInteger(value) && value >= 0;
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateFileMetadata(data) {
  const invalid = () => { throw new Error('The backend returned incomplete file metadata. Upload the original file again; if this continues, update the backend.'); };
  if (!object(data) || typeof data.fileId !== 'string' || !data.fileId || typeof (data.fileName || data.name) !== 'string') invalid();
  if (data.kind === 'spreadsheet') {
    if (!strings(data.sheetNames) || !data.sheetNames.length || !data.sheetNames.includes(data.sheetName) || !count(data.rowCount) || !count(data.columnCount)) invalid();
    if (data.sheetCount !== undefined && data.sheetCount !== data.sheetNames.length) invalid();
    if (data.totalRowCount !== undefined && (!count(data.totalRowCount) || data.totalRowCount < data.rowCount)) invalid();
  } else if (data.kind === 'pdf') {
    if (!count(data.pageCount) || data.pageCount < 1) invalid();
  } else invalid();
  return data;
}

export function validateUpload(data) {
  validateFileMetadata(data);
  if (typeof data.conversationId !== 'string' || !data.conversationId ||
      (data.kind === 'spreadsheet' && (!strings(data.columns) || data.columns.length !== data.columnCount || !Array.isArray(data.preview)))) {
    throw new Error('The backend did not return a complete upload result. Please retry the upload.');
  }
  return data;
}

export function validateAnalysis(data) {
  const valid = object(data) && count(data.rowCount) && count(data.totalRowCount) && count(data.columnCount) &&
    strings(data.sheetNames) && data.sheetNames.includes(data.sheetName) && data.sheetCount === data.sheetNames.length &&
    object(data.types) && ['numeric', 'date', 'category', 'text'].every(key => strings(data.types[key])) &&
    object(data.categories) && Object.values(data.categories).every(Array.isArray) && object(data.columnStats) &&
    Array.isArray(data.kpis) && strings(data.findings) && strings(data.warnings) && object(data.charts) &&
    object(data.charts.trend) && Array.isArray(data.charts.trend.data) && object(data.charts.bar) && Array.isArray(data.charts.bar.data) && Array.isArray(data.charts.pie);
  if (!valid) throw new Error('The backend returned incomplete worksheet analytics. Retry or update the backend.');
  return data;
}

export function validatePreview(data) {
  if (!object(data) || !strings(data.columns) || !Array.isArray(data.rows) || !data.rows.every(object) ||
      !count(data.total) || !count(data.page) || data.page < 1 || !count(data.totalPages) || data.totalPages < 1) {
    throw new Error('The backend returned an incomplete worksheet preview. Please retry.');
  }
  return data;
}

export function fileDimensions(data) {
  if (data.kind === 'pdf') return `${data.pageCount} pages`;
  return `${data.totalRowCount ?? data.rowCount} rows · ${data.sheetCount ?? data.sheetNames.length} worksheets · ${data.columnCount} columns in first worksheet`;
}
