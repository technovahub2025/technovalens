// Wall-clock spans intentionally overlap: XML callbacks perform storage writes,
// and normalization includes reading/decoding rows and writing normalized rows.
// Do not add these spans together to derive total elapsed time.
export function createParserTimings(clock = () => performance.now()) {
  const fields = ['xmlMs', 'storageWriteMs', 'storageReadMs', 'normalizationMs', 'worksheetLoadMs', 'analysisMs', 'hashingMs', 'validationMs'];
  const totals = Object.fromEntries(fields.map(field => [field, 0]));
  const sheets = new Map();
  function span(field, worksheetIndex) {
    const started = clock();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const elapsed = Math.max(0, clock() - started);
      totals[field] = (totals[field] || 0) + elapsed;
      if (worksheetIndex !== undefined) {
        if (!sheets.has(worksheetIndex)) sheets.set(worksheetIndex, { worksheetIndex });
        const sheet = sheets.get(worksheetIndex);
        sheet[field] = (sheet[field] || 0) + elapsed;
      }
    };
  }
  function sync(field, callback, worksheetIndex) {
    const finish = span(field, worksheetIndex);
    try { return callback(); } finally { finish(); }
  }
  const rounded = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, key === 'worksheetIndex' ? value : Math.round(value * 100) / 100]));
  return { span, sync, snapshot: () => ({ ...rounded(totals), worksheets: [...sheets.values()].map(rounded) }) };
}
