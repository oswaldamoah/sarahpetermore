import Papa from 'papaparse';

export function downloadFile(name: string, content: string, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function toCSV(rows: Record<string, unknown>[], columns?: string[]) {
  return Papa.unparse({ fields: columns ?? Object.keys(rows[0] ?? {}), data: rows.map((r) => (columns ?? Object.keys(r)).map((c) => r[c] ?? '')) });
}

export function parseCSV(file: File): Promise<Record<string, string>[]> {
  return new Promise((resolve, reject) =>
    Papa.parse<Record<string, string>>(file, { header: true, skipEmptyLines: 'greedy', complete: (r) => resolve(r.data), error: reject }));
}

export const STOCK_COLUMNS = ['Product Name', 'Category', 'Cost Price', 'Selling Price', 'Stock Quantity', 'Unit'];
export const STOCK_DIST_COLUMNS = ['Product Name', 'Category', 'Distributor', 'Institution', 'Hostel', 'Cost Price', 'Selling Price', 'Stock Quantity', 'Unit'];
