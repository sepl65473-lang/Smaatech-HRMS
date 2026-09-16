// Verifies the India statutory payroll engine against hand-worked examples
// taken from the published statutory rules (FY 2025-26). These are the
// calculations the app previously did NOT do at all — HR typed the amounts in
// by hand — so the numbers here are the actual evidence that the "PF/ESI/PT"
// claim is real rather than a set of identifier fields on a schema.
import { describe, it, expect } from 'vitest';
import {
  computePf, computeEsi, computeProfessionalTax, computeTds, taxOnSlabs,
  computeStatutoryDeductions, PF_RULES, ESI_RULES,
} from './statutory.js';

describe('EPF / EPS', () => {
  it('caps the contribution base at the statutory wage ceiling', () => {
    // Basic+DA ₹50,000 but the ceiling is ₹15,000, so both sides contribute
    // 12% of ₹15,000 = ₹1,800.
    const pf = computePf(50000);
    expect(pf.base).toBe(PF_RULES.wageCeiling);
    expect(pf.employee).toBe(1800);
    expect(pf.employerTotal).toBe(1800);
    // 8.33% of ₹15,000 = ₹1,249.5 -> ₹1,250 (the well-known EPS cap).
    expect(pf.employerEps).toBe(1250);
    expect(pf.employerEpf).toBe(550);
  });

  it('computes on actual wages when they are below the ceiling', () => {
    const pf = computePf(12000);
    expect(pf.base).toBe(12000);
    expect(pf.employee).toBe(1440); // 12%
    expect(pf.employerEps).toBe(1000); // 8.33% of 12,000
    expect(pf.employerEpf).toBe(440);
  });

  it('supports the employer option to contribute on full wages, EPS still capped', () => {
    const pf = computePf(50000, { contributeOnFullWages: true });
    expect(pf.base).toBe(50000);
    expect(pf.employee).toBe(6000);
    // EPS never exceeds the ceiling-based ₹1,250 even on full-wage EPF.
    expect(pf.employerEps).toBe(1250);
    expect(pf.employerEpf).toBe(4750);
  });

  it('returns nothing when PF is not applicable', () => {
    expect(computePf(50000, { applicable: false }).applicable).toBe(false);
    expect(computePf(0).employee).toBe(0);
  });
});

describe('ESI', () => {
  it('applies at or below the wage limit', () => {
    const esi = computeEsi(20000);
    expect(esi.applicable).toBe(true);
    expect(esi.employee).toBe(150); // 0.75%
    expect(esi.employer).toBe(650); // 3.25%
  });

  it('is exactly at the boundary of the wage limit', () => {
    expect(computeEsi(ESI_RULES.wageLimit).applicable).toBe(true);
    expect(computeEsi(ESI_RULES.wageLimit + 1).applicable).toBe(false);
  });

  it('does not apply above the wage limit', () => {
    const esi = computeEsi(45000);
    expect(esi.applicable).toBe(false);
    expect(esi.employee).toBe(0);
    expect(esi.employer).toBe(0);
  });

  it('stays applicable when the contribution period forces it', () => {
    // An employee crossing the limit mid-period keeps contributing.
    const esi = computeEsi(24000, { forceApplicable: true });
    expect(esi.applicable).toBe(true);
    expect(esi.employee).toBe(180);
  });
});

describe('Professional Tax', () => {
  it('Karnataka: nil below the exemption, flat above it', () => {
    expect(computeProfessionalTax(24000, 'Karnataka').amount).toBe(0);
    expect(computeProfessionalTax(25000, 'Karnataka').amount).toBe(0);
    expect(computeProfessionalTax(30000, 'Karnataka').amount).toBe(200);
  });

  it('Karnataka: February carries the annual top-up', () => {
    expect(computeProfessionalTax(30000, 'Karnataka', { month: 2 }).amount).toBe(300);
    // 11 x 200 + 300 = the 2,500 annual cap.
    expect(200 * 11 + 300).toBe(2500);
  });

  it('Maharashtra: gendered slabs', () => {
    expect(computeProfessionalTax(20000, 'Maharashtra', { gender: 'female' }).amount).toBe(0);
    expect(computeProfessionalTax(20000, 'Maharashtra', { gender: 'male' }).amount).toBe(200);
    expect(computeProfessionalTax(9000, 'Maharashtra', { gender: 'male' }).amount).toBe(175);
    expect(computeProfessionalTax(7000, 'Maharashtra', { gender: 'male' }).amount).toBe(0);
  });

  it('reports an unmodelled or missing state instead of silently returning zero', () => {
    const none = computeProfessionalTax(50000, null);
    expect(none.applicable).toBe(false);
    expect(none.reason).toBe('STATE_NOT_SET');

    const unknown = computeProfessionalTax(50000, 'Atlantis');
    expect(unknown.applicable).toBe(false);
    expect(unknown.reason).toBe('STATE_NOT_MODELLED');
  });
});

describe('TDS (new regime, estimate)', () => {
  it('is zero for a salary the 87A rebate fully covers', () => {
    // ₹12,75,000 gross - ₹75,000 standard deduction = ₹12,00,000 taxable,
    // on which the ₹60,000 rebate exactly wipes out the liability.
    const tds = computeTds(0, { annualOverride: 1275000 });
    expect(tds.taxableIncome).toBe(1200000);
    expect(tds.annualTax).toBe(0);
    expect(tds.monthly).toBe(0);
    expect(tds.applicable).toBe(false);
  });

  it('applies the slab stack correctly above the rebate threshold', () => {
    // Taxable ₹12,00,000: 0 on first 4L, 5% on next 4L = 20,000,
    // 10% on next 4L = 40,000 -> 60,000 before rebate.
    expect(taxOnSlabs(1200000)).toBe(60000);
    // Taxable ₹16,00,000: 60,000 + 15% of 4L = 1,20,000.
    expect(taxOnSlabs(1600000)).toBe(120000);
  });

  it('charges tax plus 4% cess once past the rebate', () => {
    // ₹20,00,000 gross - 75,000 = 19,25,000 taxable.
    // 0 + 20,000 + 40,000 + 60,000 (15% of 4L) + 65,000 (20% of 3.25L)
    // = 1,85,000, +4% cess = 1,92,400.
    const tds = computeTds(0, { annualOverride: 2000000 });
    expect(tds.taxableIncome).toBe(1925000);
    expect(tds.annualTax).toBe(192400);
    expect(tds.monthly).toBe(Math.round(192400 / 12));
    expect(tds.estimateOnly).toBe(true);
  });

  it('spreads the remaining liability over the months left in the year', () => {
    const tds = computeTds(0, { annualOverride: 2000000, monthsRemaining: 4, taxAlreadyDeducted: 100000 });
    expect(tds.monthly).toBe(Math.round((192400 - 100000) / 4));
  });

  it('refuses to guess for old-regime employees', () => {
    const tds = computeTds(200000, { regime: 'old' });
    expect(tds.applicable).toBe(false);
    expect(tds.reason).toBe('OLD_REGIME_NOT_MODELLED');
    expect(tds.monthly).toBe(0);
  });

  it('never presents itself as a filed figure', () => {
    expect(computeTds(100000).estimateOnly).toBe(true);
  });
});

describe('computeStatutoryDeductions (full cycle)', () => {
  it('builds a complete payslip deduction set for a low-wage ESI-covered employee', () => {
    const result = computeStatutoryDeductions({
      gross: 20000, basic: 10000, state: 'Karnataka', month: 7,
      uan: '100200300400', esiNumber: '31001234560000001', pan: 'ABCDE1234F',
    });
    const byCategory = Object.fromEntries(result.deductions.map((d) => [d.category, d.amount]));
    expect(byCategory.PF).toBe(1200); // 12% of 10,000
    expect(byCategory.ESI).toBe(150); // 0.75% of 20,000
    expect(byCategory.PT).toBeUndefined(); // Karnataka nil below 25,000
    expect(byCategory.TDS).toBeUndefined(); // 87A rebate covers 2.4L/yr
    expect(result.employeeTotal).toBe(1350);
    expect(result.employerCost.esi).toBe(650);
    expect(result.warnings).not.toContain('PF_COMPUTED_BUT_UAN_MISSING');
  });

  it('drops ESI and adds PT/TDS for a higher-paid employee', () => {
    const result = computeStatutoryDeductions({
      gross: 180000, basic: 90000, state: 'Karnataka', month: 7,
      uan: '1', esiNumber: '', pan: 'ABCDE1234F',
    });
    const byCategory = Object.fromEntries(result.deductions.map((d) => [d.category, d.amount]));
    expect(byCategory.PF).toBe(1800); // ceiling-capped
    expect(byCategory.ESI).toBeUndefined(); // above the 21,000 limit
    expect(byCategory.PT).toBe(200);
    expect(byCategory.TDS).toBeGreaterThan(0);
  });

  it('warns loudly rather than silently returning zero for missing inputs', () => {
    const result = computeStatutoryDeductions({ gross: 60000 });
    // No basic on file -> assumed, and flagged as an assumption.
    expect(result.warnings).toContain('BASIC_ASSUMED_50_PERCENT_OF_GROSS');
    expect(result.basic).toBe(30000);
    // No state -> PT is not computed, and says so.
    expect(result.warnings).toContain('PT_NOT_COMPUTED_STATE_NOT_SET');
    // PF computed without a UAN on file is a filing problem worth surfacing.
    expect(result.warnings).toContain('PF_COMPUTED_BUT_UAN_MISSING');
  });

  it('flags old-regime employees as unmodelled for TDS', () => {
    const result = computeStatutoryDeductions({ gross: 200000, basic: 100000, taxRegime: 'old', state: 'Karnataka' });
    expect(result.warnings).toContain('TDS_NOT_COMPUTED_OLD_REGIME_NOT_MODELLED');
    expect(result.deductions.find((d) => d.category === 'TDS')).toBeUndefined();
  });
});
