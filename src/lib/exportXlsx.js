import * as XLSX from 'xlsx';

// Write-only usage — we only ever build sheets from our own in-memory data
// and trigger a download. We never call XLSX.read()/parse() on user-supplied
// files, so the parser-side CVEs in this package (prototype pollution, ReDoS)
// aren't reachable through this code path.

// rows: array of objects; columns: [{ key, label }]
export function downloadXLSX(filename, rows, columns) {
  const data = rows.map((row) => {
    const record = {};
    columns.forEach((c) => { record[c.label] = row[c.key] ?? ''; });
    return record;
  });
  const worksheet = XLSX.utils.json_to_sheet(data, { header: columns.map((c) => c.label) });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
  XLSX.writeFile(workbook, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
}
