const STATUTORY_LEDGER_NAMES = {
  PF: 'Provident Fund Payable',
  ESI: 'ESI Payable',
  PT: 'Professional Tax Payable',
  TDS: 'TDS Payable',
  Other: 'Other Statutory Liabilities',
};

// Minimal Tally-compatible XML export for a payroll cycle's journal entries.
// Real Tally imports expect XML in this VOUCHER/TALLYMESSAGE shape — this is a
// simplified version covering the salary expense, statutory liability and
// bank/cash ledger lines so it can be hand-mapped or adjusted on import.
export function buildTallyXML(cycle, rows) {
  const gross = rows.reduce((sum, r) => sum + Number(r.gross || 0), 0);
  const net = rows.reduce((sum, r) => sum + Number(r.net || 0), 0);

  // Sum deductions by statutory category across every row. Rows without
  // typed components (older records, or ones never opened in the Salary
  // Structure editor) fall back to their aggregate `deductions` figure
  // bucketed as "Other" — still balances the voucher, just not itemized.
  const byCategory = { PF: 0, ESI: 0, PT: 0, TDS: 0, Other: 0 };
  rows.forEach((r) => {
    const items = r.components?.deductions;
    if (items?.length) {
      items.forEach((d) => { byCategory[d.category || 'Other'] += Number(d.amount || 0); });
    } else {
      byCategory.Other += Number(r.deductions || 0);
    }
  });

  const deductionLedgerEntries = Object.entries(byCategory)
    .filter(([, amount]) => amount > 0)
    .map(([cat, amount]) => `
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${STATUTORY_LEDGER_NAMES[cat]}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${amount}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>`)
    .join('');

  const date = cycle.replace('-', '');

  return `<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Journal" ACTION="Create">
            <DATE>${date}</DATE>
            <NARRATION>Payroll journal for ${cycle} (${rows.length} employees)</NARRATION>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Salary Expense</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${gross}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>${deductionLedgerEntries}
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Bank Account</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${net}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

export function downloadTallyXML(cycle, rows) {
  const xml = buildTallyXML(cycle, rows);
  const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tally-payroll-${cycle}.xml`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
