import { Directory, File, Paths } from 'expo-file-system';
import { getContentUriAsync } from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import * as Print from 'expo-print';
import { authorizedSource, ensureFreshToken } from '../services/api';
import { formatINR, payrollStatus } from './format';
import { formatMonth } from './date';
import type { HrDocument, Payroll } from '../types';

const FLAG_GRANT_READ_URI_PERMISSION = 1;

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function mimeOf(uri: string) {
  const ext = uri.split('.').pop()?.toLowerCase() ?? '';
  return MIME[ext] ?? 'application/octet-stream';
}

/** Opens a local file in whichever installed app handles its type. */
export async function openFile(uri: string): Promise<void> {
  const type = mimeOf(uri);
  try {
    const contentUri = await getContentUriAsync(uri);
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      type,
      flags: FLAG_GRANT_READ_URI_PERMISSION,
    });
  } catch {
    // No viewer installed for this type: let the user pick where to send it.
    await shareFile(uri);
  }
}

export async function shareFile(uri: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device.');
  await Sharing.shareAsync(uri, { mimeType: mimeOf(uri) });
}

/**
 * Downloads a document through the authenticated API route
 * (GET /documents/:id/download). The server re-checks visibility for this
 * user on every download; the file lands in the app's private cache, never in
 * shared storage, and there is no public URL for it.
 */
export async function downloadDocument(doc: HrDocument): Promise<string> {
  await ensureFreshToken();
  const dir = new Directory(Paths.cache, 'documents', doc.id);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const source = authorizedSource(`/documents/${doc.id}/download`);
  const file = await File.downloadFileAsync(source.uri, dir, { headers: source.headers, idempotent: true });
  return file.uri;
}

/** Removes downloaded documents and generated payslips; called on sign-out. */
export function clearDownloadedFiles() {
  try {
    const dir = new Directory(Paths.cache, 'documents');
    if (dir.exists) dir.delete();
  } catch {
    // Cache is cleared by the OS in any case.
  }
}

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Same content and wording as the web payslip (client/src/lib/payslip.js).
function payslipHtml(slip: Payroll) {
  const earnings = slip.components?.earnings?.length
    ? slip.components.earnings.map((e) => [e.name || 'Earning', e.amount] as const)
    : [['Gross salary', slip.gross] as const];
  const deductionItems = slip.components?.deductions ?? [];
  const deductions: (readonly [string, number])[] = deductionItems.length
    ? deductionItems.map((d) => [d.category && d.category !== 'Other' ? `${d.name || d.category} (${d.category})` : d.name || 'Deduction', d.amount] as const)
    : [['Deductions', slip.deductions] as const];
  if ((slip.lopDays ?? 0) > 0) {
    deductions.push([`Loss of pay (${slip.lopDays} day${slip.lopDays === 1 ? '' : 's'})`, slip.lopAmount ?? 0]);
  }
  const rows = (items: readonly (readonly [string, number])[]) =>
    items.map(([name, amount]) => `<tr><td>${esc(name)}</td><td class="amt">${esc(formatINR(amount))}</td></tr>`).join('');
  const hasTds = deductionItems.some((d) => d.category === 'TDS');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Helvetica,Arial,sans-serif;color:#1B2638;padding:32px;font-size:12px}
    h1{font-size:20px;margin:0 0 6px} .muted{color:#6B7A90}
    table{width:100%;border-collapse:collapse;margin-top:18px}
    th{text-align:left;background:#3B7DDD;color:#fff;padding:8px} th.d{background:#6B7A90}
    td{padding:8px;border-bottom:1px solid #DCE3EE} .amt{text-align:right}
    .net td{font-size:14px;font-weight:bold;border:none} .note{margin-top:24px;font-size:9px;color:#6B7A90}
  </style></head><body>
    <h1>Payslip</h1>
    <div>${esc(slip.name)}</div>
    <div class="muted">${esc([slip.dept, formatMonth(slip.cycle)].filter(Boolean).join('  |  '))}</div>
    <table><tr><th>Earnings</th><th class="amt">Amount</th></tr>${rows(earnings)}</table>
    <table><tr><th class="d">Deductions</th><th class="d amt">Amount</th></tr>${rows(deductions)}</table>
    <table class="net"><tr><td>Net payout</td><td class="amt">${esc(formatINR(slip.net))}</td></tr>
    <tr><td>Status</td><td class="amt">${esc(payrollStatus(slip.status).label)}</td></tr></table>
    <div class="note">Computer-generated payslip. PF, ESI and Professional Tax are computed from your salary structure and state.
    ${hasTds ? '<br>TDS shown is an estimate projected from salary income and excludes investment declarations and other income.' : ''}</div>
  </body></html>`;
}

/** Renders a payroll row to a PDF in the app cache and returns its URI. */
export async function createPayslipPdf(slip: Payroll): Promise<string> {
  const { uri } = await Print.printToFileAsync({ html: payslipHtml(slip) });
  const safeName = String(slip.name || 'payslip').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const dir = new Directory(Paths.cache, 'documents', 'payslips');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const target = new File(dir, `${safeName}-${slip.cycle}.pdf`);
  if (target.exists) target.delete();
  new File(uri).move(target);
  return target.uri;
}
