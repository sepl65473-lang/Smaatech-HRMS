// Minimal Tally-compatible XML export for a payroll cycle's journal entries.
// Real Tally imports expect XML in this VOUCHER/TALLYMESSAGE shape — this is a
// simplified version covering the salary expense, statutory liability and
// bank/cash ledger lines so it can be hand-mapped or adjusted on import.
export function buildTallyXML(cycle, rows) {
  const gross = rows.reduce((sum, r) => sum + Number(r.gross || 0), 0);
  const deductions = rows.reduce((sum, r) => sum + Number(r.deductions || 0), 0);
  const net = rows.reduce((sum, r) => sum + Number(r.net || 0), 0);
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
            </ALLLEDGERENTRIES.LIST>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Statutory Liabilities (PF/ESI/PT/TDS)</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${deductions}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
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
