"""Independently open exported workbooks and inspect their native Excel objects."""
import json
import pathlib
import re
import warnings
import openpyxl
from openpyxl.utils.cell import range_boundaries

root = pathlib.Path(__file__).parent / '.data' / 'xlsx-report-validation'
results = json.loads((root / 'results.json').read_text(encoding='utf-8'))
for result in results:
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('always')
        book = openpyxl.load_workbook(result['output'])
    assert not caught, [str(w.message) for w in caught]
    assert len(book.worksheets) == 6
    dashboard = book.worksheets[0]
    assert dashboard.title == 'Executive Dashboard'
    assert len(dashboard._charts) == result['charts']
    assert dashboard['A8'].value == result['records']
    assert dashboard['A1'].fill.fgColor.rgb == 'FF8052D6'
    assert all(not sheet.sheet_view.showGridLines for sheet in book.worksheets)
    assert all(sheet.print_area for sheet in book.worksheets)
    selected = book['Selected Data']
    assert selected.freeze_panes == 'A2'
    assert selected.max_row == result['records'] + 1
    assert selected.tables['SelectedRecords'].autoFilter.ref == selected.tables['SelectedRecords'].ref
    assert selected.tables['SelectedRecords'].tableStyleInfo.showRowStripes
    for sheet in book.worksheets:
        for table in sheet.tables.values():
            assert len(set(column.name.lower() for column in table.tableColumns)) == len(table.tableColumns)
    assert len(book['Column Statistics'].conditional_formatting) == 2
    for chart in dashboard._charts:
        series = chart.ser[0]
        for reference, cache in [(series.cat.strRef.f, series.cat.strRef.strCache), (series.val.numRef.f, series.val.numRef.numCache)]:
            name, address = reference.split('!')
            source = book[name.strip("'")]
            col, first, _, last = range_boundaries(address)
            points = [point.v for point in cache.pt]
            actual = [source.cell(row, col).value for row in range(first, last + 1)]
            assert points == actual, (reference, points, actual)
        assert chart.anchor._from.col < chart.anchor.to.col
        assert chart.anchor._from.row < chart.anchor.to.row
    print(json.dumps({'worksheet': result['worksheet'], 'charts': len(dashboard._charts), 'records': selected.max_row - 1, 'independent_open_passed': True}))
print(f'Opened all {len(results)} XLSX reports, including native charts, tables, filters, styles and print areas.')
