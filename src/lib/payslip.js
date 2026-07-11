import { formatINR } from './helpers';

const STATUS_LABEL = { ready: 'Ready', processing: 'Processing', paid: 'Paid' };

export const downloadPayslip = (slip) => {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${slip.name} payslip</title>
    <style>
      body { font-family: Arial, sans-serif; color: #252019; padding: 32px; }
      h1 { margin-bottom: 8px; }
      .meta { color: #6b6457; margin-bottom: 24px; }
      .row { display: flex; justify-content: space-between; border-bottom: 1px solid #ddd6c8; padding: 12px 0; }
      .total { font-size: 20px; font-weight: 700; }
    </style>
  </head>
  <body>
    <h1>${slip.name} payslip</h1>
    <div class="meta">${slip.dept} | ${slip.cycle}</div>
    <div class="row"><span>Gross salary</span><strong>${formatINR(slip.gross)}</strong></div>
    <div class="row"><span>Deductions</span><strong>${formatINR(slip.deductions)}</strong></div>
    ${slip.lopDays > 0 ? `<div class="row"><span>LOP (${slip.lopDays} days)</span><strong>${formatINR(slip.lopAmount || 0)}</strong></div>` : ''}
    <div class="row total"><span>Net payout</span><strong>${formatINR(slip.net)}</strong></div>
    <div class="row"><span>Status</span><strong>${STATUS_LABEL[slip.status] || slip.status}</strong></div>
  </body>
</html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${slip.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${slip.cycle || 'payslip'}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};
