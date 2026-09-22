export type CsvCell = string | number | null | undefined

function escapeCell(value: CsvCell): string {
  let text = value == null || (typeof value === 'number' && !Number.isFinite(value)) ? '' : String(value)
  // Quoting alone does not stop spreadsheets from executing a formula.
  // Preserve numeric negatives; only text from API/CSV fields is prefixed.
  if (typeof value === 'string' && (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text))) {
    text = `'${text}`
  }
  return `"${text.replace(/"/g, '""')}"`
}

export function serializeCsv(headers: string[], rows: CsvCell[][]): string {
  // UTF-8 BOM keeps Korean labels readable when the file opens in Excel.
  return '\uFEFF' + [headers, ...rows].map((row) => row.map(escapeCell).join(',')).join('\r\n') + '\r\n'
}

export function downloadCsv(filename: string, headers: string[], rows: CsvCell[][]): void {
  const blob = new Blob([serializeCsv(headers, rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.hidden = true
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Let the browser start the download before releasing its backing blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
