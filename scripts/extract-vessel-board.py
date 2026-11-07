#!/usr/bin/env python3
"""Read one assignment sheet, including legacy cell notes, without loading archived tabs.

Usage: python3 scripts/extract-vessel-board.py workbook.xlsx 'FALL WKDY 26'
Prints operational labels/notes and N3:Q6 shuttle cells as JSON; excludes crew names.
"""
import json
import posixpath
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
RID = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'

def extract(filename, sheet_name, shuttle_end_row=6, include_summaries=False, operational_cells=()):
    with zipfile.ZipFile(filename) as archive:
        def xml(name):
            return ET.fromstring(archive.read(name))
        def target(base, value):
            return value.lstrip('/') if value.startswith('/') else posixpath.normpath(posixpath.join(base, value))
        sheets = xml('xl/workbook.xml').find('s:sheets', NS)
        sheet = next((s for s in sheets if s.attrib['name'] == sheet_name), None)
        if sheet is None:
            raise ValueError('No such sheet. Available: ' + ', '.join(s.attrib['name'] for s in sheets))
        relations = {r.attrib['Id']: r.attrib['Target'] for r in xml('xl/_rels/workbook.xml.rels')}
        path = target('xl', relations[sheet.attrib[RID]])
        strings = [''.join(t.text or '' for t in item.findall('.//s:t', NS))
                   for item in xml('xl/sharedStrings.xml')] if 'xl/sharedStrings.xml' in archive.namelist() else []
        cells = {}
        for cell in xml(path).findall('.//s:sheetData/s:row/s:c', NS):
            value = cell.find('s:v', NS)
            if cell.attrib.get('t') == 'inlineStr':
                cells[cell.attrib['r']] = ''.join(t.text or '' for t in cell.findall('.//s:t', NS))
            elif value is not None:
                cells[cell.attrib['r']] = strings[int(value.text)] if cell.attrib.get('t') == 's' else value.text
        notes = []
        relpath = posixpath.dirname(path) + '/_rels/' + posixpath.basename(path) + '.rels'
        if relpath in archive.namelist():
            for relation in xml(relpath):
                if relation.attrib['Type'].endswith('/comments'):
                    for comment in xml(target(posixpath.dirname(path), relation.attrib['Target'])).findall('.//s:comment', NS):
                        ref = comment.attrib['ref']
                        notes.append({'cell': ref, 'label': cells.get(ref, ''),
                                      'note': ''.join(t.text or '' for t in comment.findall('.//s:t', NS))})
        result = {'sheet': sheet_name, 'assignments': notes,
                'shuttleCells': {f'{col}{row}': cells.get(f'{col}{row}') for row in range(3, shuttle_end_row + 1) for col in 'NOPQ'}}
        if operational_cells:
            result['operationalCells'] = {cell: cells.get(cell) for cell in operational_cells}
        if include_summaries:
            result['summaryCells'] = {f'{col}{row}': cells.get(f'{col}{row}') for row in range(8, 11) for col in 'NOPQRS' if cells.get(f'{col}{row}')}
        return result

if __name__ == '__main__':
    print(json.dumps(extract(sys.argv[1], sys.argv[2]), indent=2))
