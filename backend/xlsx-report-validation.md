# XLSX analytics report validation — 14 November 2026

The export keeps ExcelJS 4.4 and its row-committing streaming writer. `reports.js` now delegates XLSX work to `excel-report.js`; the PDF renderer and frontend dashboard are unchanged.

## Report changes

The first worksheet is **Executive Dashboard**, with workbook/worksheet scope, merged purple headings, four quality/count KPI cards, available numeric KPIs, editable Excel-native bar/doughnut/line charts and deterministic findings. The existing Dataset Overview, Column Statistics, Findings, Chart Data and Selected Data worksheets remain available. Charts are created only when verified analytics contains suitable data, and their live ranges and cached values point to visible Chart Data tables.

Dataset Overview has compact metadata and method sections. Column Statistics retains the original eleven statistics and exact numeric values, with wide labels, native table filtering and conditional formatting on missing/invalid counts. Findings distinguishes calculated observations from method notes. Selected Data is a banded native Excel table with filtering, frozen headers, bounded data-driven widths and complete records. Presentation worksheets hide gridlines; all sheets have bounded print areas, landscape settings and consistent headers/footers. Very wide raw tables print over multiple horizontal pages instead of becoming unreadably small.

Explicit INR labels receive currency formats. Percentage-point values use a literal `%` suffix, avoiding accidental multiplication by one hundred. Generated metadata is a native Excel date. Source ISO date strings, numeric strings, leading zeros and other original cell values are preserved rather than coerced. If source headers differ only by case (such as Qty/QTY), Excel table headers receive unique suffixes and Dataset Overview records the mapping; Column Statistics retains the original labels.

ExcelJS does not implement native charts or streaming tables. `xlsx-report-parts.js` adds the small OOXML chart/drawing/table parts and relationships directly to the existing output archive. It does not buffer/reload/rewrite the entire ZIP or materialize a second set of raw data rows. Its limited ExcelJS serialization hooks are covered by document/streaming round-trip and XML tests; this compatibility must be checked on a future ExcelJS upgrade.

## Actual exports and independent inspection

- Generated reports through the existing 256 MiB bounded export worker for all **4 sample worksheets (361 records)** and **11 Eveready worksheets (13,610 records)**.
- Reopened all **15 files / 90 worksheets** with ExcelJS, checked every source cell against its complete stored NDJSON worksheet, and checked all eleven statistics for every source column. **13,971 records**, including zeros, missing cells and source strings, retained their exact values.
- Independently reopened all files with openpyxl 3.1.5 without warnings. Checked **33 native charts**, their chart types/anchors and every cached category/value against the referenced worksheet cells. Checked table references, filters, case-insensitive header uniqueness, freeze panes, merged titles, fills, conditional formatting and print areas.
- Visually reviewed local previews of all fifteen executive dashboards and representative overview/statistics/findings/chart-data/raw-data sheets from Sales and SETTING. Previews read the reopened XLSX cells/styles and native chart caches, rather than using invented chart data.
- SETTING retains 3,810 records across 80 columns; WELDING retains all 89 columns. No production data, PDF export code or frontend dashboard was changed.

There is no Microsoft Excel/LibreOffice installation or connected spreadsheet session available here. The visual previews are local canvas approximations, not screenshots from an Office rendering engine; pixel-perfect Office layout and printing still need a desktop smoke check. Native chart/table objects were independently parsed and verified, not replaced by bitmap images in the workbook.

## Checks and artifacts

The combined XLSX/PDF-chat backend suite passes **74 tests, 0 failures**. The frontend production build passes using the repository's documented HTTPS backend URL; the existing >500 kB bundle warning remains. `git diff --check` passes.

All local outputs are ignored under `.data/xlsx-report-validation/`, including `results.json`, all fifteen `report-NN.xlsx` files, reopened worksheet previews and dashboard contact sheets. Reproduce from `backend`:

```powershell
node validate-xlsx-reports.mjs 'C:/Users/Admin/Downloads/TECHNOVALENS_Sample_Business_Data.xlsx' 'C:/Users/Admin/Downloads/EVEREADY PRODUCTION TRACKER -31.10.2026.xlsx'
python validate-xlsx-openpyxl.py
node render-xlsx-previews.mjs
npm test
```

The Python check and canvas previews are developer diagnostics only; production exports require no new dependencies. Formulas still use cached results and source number-format metadata is not invented. Nothing was committed, pushed or deployed.
