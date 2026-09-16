import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatINR } from './helpers';

const STATUS_LABEL = { ready: 'Ready', processing: 'Processing', paid: 'Paid' };

/**
 * Generates a real PDF payslip.
 *
 * The previous implementation built an HTML string, wrapped it in a
 * `text/html` Blob and saved it as `<name>-<cycle>.html`. Nothing about it was
 * a PDF: an employee who forwarded it to a bank or a landlord sent a web page,
 * and any "payslip PDF" claim about this product was simply untrue. jsPDF and
 * jspdf-autotable were already dependencies (lib/exportPdf.js uses them) and
 * already in the bundle, so this costs nothing extra to ship.
 */
export const downloadPayslip = (slip) => {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const left = 40;

  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('Payslip', left, 50);

  doc.setFontSize(11);
  doc.setFont('helvetica', 'normal');
  doc.text(String(slip.name || ''), left, 72);
  doc.setTextColor(107, 122, 144);
  doc.text([slip.dept, slip.cycle].filter(Boolean).join('  |  '), left, 88);
  doc.setTextColor(37, 32, 25);

  doc.setDrawColor(221, 214, 200);
  doc.line(left, 100, pageWidth - left, 100);

  const earnings = slip.components?.earnings?.length
    ? slip.components.earnings.map((e) => [e.name || 'Earning', formatINR(e.amount)])
    : [['Gross salary', formatINR(slip.gross)]];

  autoTable(doc, {
    startY: 116,
    head: [['Earnings', 'Amount']],
    body: earnings,
    theme: 'striped',
    styles: { fontSize: 10, cellPadding: 6 },
    headStyles: { fillColor: [184, 84, 31] },
    columnStyles: { 1: { halign: 'right' } },
    margin: { left, right: left },
  });

  const deductionItems = slip.components?.deductions || [];
  const deductionRows = deductionItems.length
    ? deductionItems.map((d) => [
      d.category && d.category !== 'Other' ? `${d.name || d.category} (${d.category})` : (d.name || 'Deduction'),
      formatINR(d.amount),
    ])
    : [['Deductions', formatINR(slip.deductions)]];

  if (slip.lopDays > 0) {
    deductionRows.push([`Loss of pay (${slip.lopDays} day${slip.lopDays === 1 ? '' : 's'})`, formatINR(slip.lopAmount || 0)]);
  }

  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 20,
    head: [['Deductions', 'Amount']],
    body: deductionRows,
    theme: 'striped',
    styles: { fontSize: 10, cellPadding: 6 },
    headStyles: { fillColor: [107, 122, 144] },
    columnStyles: { 1: { halign: 'right' } },
    margin: { left, right: left },
  });

  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 20,
    body: [
      ['Net payout', formatINR(slip.net)],
      ['Status', STATUS_LABEL[slip.status] || slip.status || ''],
    ],
    theme: 'plain',
    styles: { fontSize: 12, cellPadding: 6, fontStyle: 'bold' },
    columnStyles: { 1: { halign: 'right' } },
    margin: { left, right: left },
  });

  // Statutory deductions here are computed by the server (server/src/lib/
  // statutory.js). TDS in particular is a projection from salary income under
  // the new regime, so the document says so rather than letting a reader treat
  // it as a filed figure.
  const hasTds = deductionItems.some((d) => d.category === 'TDS');
  doc.setFontSize(8);
  doc.setTextColor(107, 122, 144);
  const noteY = doc.lastAutoTable.finalY + 28;
  doc.text('Computer-generated payslip. PF, ESI and Professional Tax are computed from your salary structure and state.', left, noteY);
  if (hasTds) {
    doc.text('TDS shown is an estimate projected from salary income and excludes investment declarations and other income.', left, noteY + 12);
  }

  const safeName = String(slip.name || 'payslip').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  doc.save(`${safeName}-${slip.cycle || 'payslip'}.pdf`);
};
