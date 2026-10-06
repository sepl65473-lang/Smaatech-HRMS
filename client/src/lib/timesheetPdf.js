import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { TIMESHEET_COLUMNS, timesheetBody, timesheetTotalRow, timesheetFilename } from './timesheet';

// Report colours, shared with the Excel writer.
export const NAVY = [23, 43, 77];
export const HEADER_BLUE = [31, 58, 110];
export const ZEBRA = [244, 247, 252];
export const TOTAL_FILL = [221, 230, 244];
export const BORDER = [176, 188, 208];

// Relative column widths, in the locked column order. They are scaled to the
// printable width, so the proportions hold on every page.
const WIDTHS = [11, 46, 26, 18, 18, 25, 21, 19, 19, 25, 24];
const MARGIN = 10;
const BANNER_HEIGHT = 16;

/** Builds the landscape A4 PDF and returns the jsPDF document. */
export function buildTimesheetPdf(sheet) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const usable = pageWidth - MARGIN * 2;
  const scale = usable / WIDTHS.reduce((a, b) => a + b, 0);

  // Title banner and the employee / month line: first page only.
  doc.setFillColor(...NAVY);
  doc.roundedRect(MARGIN, MARGIN, usable, BANNER_HEIGHT, 2.5, 2.5, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(sheet.title, pageWidth / 2, MARGIN + BANNER_HEIGHT / 2 + 0.4, { align: 'center', baseline: 'middle' });

  const infoY = MARGIN + BANNER_HEIGHT + 8;
  doc.setTextColor(...NAVY);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Employee Name:', MARGIN, infoY);
  const nameX = MARGIN + doc.getTextWidth('Employee Name: ') + 1;
  doc.setFont('helvetica', 'normal');
  doc.text(String(sheet.employeeLabel), nameX, infoY);
  doc.setFont('helvetica', 'normal');
  const monthValueWidth = doc.getTextWidth(sheet.monthLabel);
  doc.text(sheet.monthLabel, pageWidth - MARGIN, infoY, { align: 'right' });
  doc.setFont('helvetica', 'bold');
  doc.text('Month:', pageWidth - MARGIN - monthValueWidth - 2, infoY, { align: 'right' });

  const columnStyles = {};
  TIMESHEET_COLUMNS.forEach((column, index) => {
    columnStyles[index] = { cellWidth: WIDTHS[index] * scale, halign: column.key === 'name' ? 'left' : 'center' };
  });

  autoTable(doc, {
    startY: infoY + 5,
    margin: { left: MARGIN, right: MARGIN, top: MARGIN, bottom: 12 },
    head: [TIMESHEET_COLUMNS.map((c) => c.label)],
    body: timesheetBody(sheet),
    foot: [timesheetTotalRow(sheet)],
    showHead: 'everyPage', // the column header repeats on every page
    showFoot: 'lastPage', // TOTAL once, at the end of the report
    theme: 'grid',
    tableWidth: usable,
    rowPageBreak: 'avoid', // a row is never split across pages
    styles: {
      font: 'helvetica', fontSize: 8.5, cellPadding: { top: 1.7, bottom: 1.7, left: 1.6, right: 1.6 },
      lineColor: BORDER, lineWidth: 0.15, textColor: [33, 37, 41], valign: 'middle', overflow: 'linebreak', minCellHeight: 6.4,
    },
    headStyles: {
      fillColor: HEADER_BLUE, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8, halign: 'center',
      lineColor: BORDER, lineWidth: 0.15, minCellHeight: 9,
    },
    alternateRowStyles: { fillColor: ZEBRA },
    footStyles: {
      fillColor: TOTAL_FILL, textColor: NAVY, fontStyle: 'bold', fontSize: 9, halign: 'center',
      lineColor: NAVY, lineWidth: 0.3, minCellHeight: 8,
    },
    columnStyles,
    didParseCell: (data) => {
      if (data.section === 'foot' && data.column.index === 1) data.cell.styles.halign = 'left';
    },
  });

  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(110, 118, 130);
    doc.text(`${sheet.title} · ${sheet.employeeLabel} · ${sheet.monthLabel}`, MARGIN, pageHeight - 6);
    doc.text(`Page ${page} of ${pages}`, pageWidth - MARGIN, pageHeight - 6, { align: 'right' });
  }
  return doc;
}

export function downloadTimesheetPdf(sheet) {
  buildTimesheetPdf(sheet).save(`${timesheetFilename(sheet)}.pdf`);
}
