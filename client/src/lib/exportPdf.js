import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

// rows: array of objects; columns: [{ key, label }]
export function downloadPDF(filename, title, rows, columns) {
  const doc = new jsPDF();
  doc.setFontSize(14);
  doc.text(title, 14, 16);
  autoTable(doc, {
    startY: 22,
    head: [columns.map((c) => c.label)],
    body: rows.map((row) => columns.map((c) => String(row[c.key] ?? ''))),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [184, 84, 31] },
  });
  doc.save(filename.endsWith('.pdf') ? filename : `${filename}.pdf`);
}
