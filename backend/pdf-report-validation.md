# Local PDF report validation — 14 November 2026

The Reports download uses PDFKit directly on A4 pages. It does not use HTML, browser printing or CSS. PDF creation is still called through `reports.js`, including the existing stored-worksheet export worker.

## Cause and changes

The old footer started at y=795 with a 42-point bottom margin. Its text extended below PDFKit's text boundary and implicitly added two pages per original page while the buffered pages were being numbered. For example, the three-page Sales report became nine physical pages with six footer-only pages, and its printed page totals were wrong.

`pdf-report.js` now owns the PDF layout. It derives its width and content boundary from the page dimensions, reserves space for running headers/footers, and temporarily removes the bottom text boundary while stamping fixed footer text. Charts and statistics no longer start on a new page unconditionally. Blocks are measured, headings stay with content, table pages repeat their headers, and exceptionally tall cells split into aligned continuation fragments. Short final groups of statistics stay together to avoid sparse final pages.

The report keeps the white/purple styling and presents executive summary, dataset and numeric KPIs, charts, calculated business insights, methodology and then **Data Quality & Key Statistics**. Statistics retain present/missing/distinct/invalid counts and sum/average/minimum/maximum. Explicit INR and percentage column labels supply units; numbers use Indian digit grouping and up to four decimals. Calculations and XLSX export implementation are unchanged.

## Actual workbook exports

Each worksheet was exported separately, matching the Reports worksheet selector. These are physical PDF page counts, including the old footer-only pages.

| Workbook / worksheet | Before | After |
| --- | ---: | ---: |
| Sample / Sales | 9 | 3 |
| Sample / Employees | 9 | 3 |
| Sample / Inventory | 9 | 3 |
| Sample / Expenses | 9 | 3 |
| Eveready / PURLIN | 18 | 7 |
| Eveready / CNC | 18 | 7 |
| Eveready / PTW & HAND SETTING | 24 | 10 |
| Eveready / DRILLING & PUNCHING | 24 | 10 |
| Eveready / STIFFENER (source retains trailing space) | 24 | 10 |
| Eveready / SETTING | 27 | 10 |
| Eveready / WELDING | 27 | 11 |
| Eveready / LATHE | 21 | 8 |
| Eveready / CLEANING | 15 | 5 |
| Eveready / PAINTING | 15 | 6 |
| Eveready / DISPACHED | 24 | 9 |
| **Total across 15 separate exports** | **273** | **105** |

The sample contains 361 normalized records across four worksheets; Eveready contains 13,610 across eleven. The final exports run through the same bounded worker and complete stored NDJSON worksheet loading as production exports, without contacting production services. All 105 pages were rendered to PNG, checked for body text and pixel content, checked for text outside the safe page bounds, and checked for consistent running headers and correct page numbers. Contact sheets covering every page were visually inspected, with individual pages also inspected at full resolution. No blank, nearly empty or visibly clipped pages remained. The baseline had 182 footer-only pages.

The local artifacts are under `.data/pdf-report-validation/`: source parser manifests/NDJSON, baseline and final PDFs, per-page PNGs, contact sheets, and `before.json` / `after.json` measurements. They are ignored by Git. Neither original workbook was modified.

## Verification

- `npm test`: **66 passed, 0 failed**, including PDF layout/unit/pagination regressions, XLSX round-trips, authenticated report endpoints, streaming parser tests, MongoDB/GridFS recovery tests and workspace isolation.
- `node tests/pdf-report.test.js`: four focused cases cover footer-only page regression, executive ordering, INR/percentage formatting and numeric values, all 73 columns in a wide profile, oversized cell continuation, empty worksheets and page bounds.
- `npm run build` in `frontend`, with the repository's documented `VITE_API_URL=https://technovalens.onrender.com`: passed. Vite retains its existing warning for a minified JavaScript chunk over 500 kB.
- `git diff --check`: passed.

From `backend`, the diagnostic can capture a baseline before an implementation change and compare the result afterward:

```powershell
node validate-pdf-reports.mjs before 'C:/Users/Admin/Downloads/TECHNOVALENS_Sample_Business_Data.xlsx' 'C:/Users/Admin/Downloads/EVEREADY PRODUCTION TRACKER -31.10.2026.xlsx'
node validate-pdf-reports.mjs after 'C:/Users/Admin/Downloads/TECHNOVALENS_Sample_Business_Data.xlsx' 'C:/Users/Admin/Downloads/EVEREADY PRODUCTION TRACKER -31.10.2026.xlsx'
```

The `before` phase snapshots the current implementation. Do not rerun it over a baseline you want to retain. The `after` phase reuses its isolated normalized data and writes the current worker exports.

## Limits

Formula results remain cached values; formulas are not recalculated. Currency is not assumed for unlabeled columns, and percentages are not rescaled from fractions. Existing parser metadata does not retain arbitrary Excel number formats. Charts retain the analytics layer's top-group and latest-24-month limits; very long chart titles/labels use explicit ellipses while profile column names remain complete. Findings come only from existing deterministic statistics. Pixel/text bounds checks and visual review cover these workbooks and the regression fixtures, not every possible workbook layout or Unicode font. Built-in Helvetica remains the report font.

No production resources, persistence records or dashboard code were modified. Nothing was pushed or deployed.
