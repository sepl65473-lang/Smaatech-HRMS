// India statutory payroll computation — PF (EPF/EPS), ESI, Professional Tax
// and a projected-annual TDS estimate.
//
// Before this module existed the app carried PAN/UAN/ESI *identifier* fields
// but computed none of these amounts: HR typed deduction figures in by hand
// (see the note in models/Employee.js). Identifiers alone are not compliance.
//
// Rates and thresholds below are the statutory values in force for FY 2025-26
// and are declared as data, with an `effectiveFrom` marker, because they DO
// change — a rate revision is a data edit here plus a test update, not a hunt
// through route handlers.
//
// Sources (verified 2026-09):
//   EPF  — 12% employee + 12% employer of (basic + DA), employer share split
//          8.33% to EPS capped at the ₹15,000 wage ceiling (₹1,250/month) and
//          the balance to EPF.
//   ESI  — 0.75% employee + 3.25% employer of gross wages, applicable while
//          gross wages are at or below ₹21,000/month.
//   PT   — state subject; Karnataka nil below ₹25,000/month then ₹200
//          (₹300 in February); Maharashtra gendered slabs; annual cap ₹2,500.
//   TDS  — new regime (s.115BAC) slabs, ₹75,000 standard deduction,
//          s.87A rebate up to ₹60,000, 4% health & education cess.
//
// SCOPE LIMIT, stated plainly: the TDS figure here is a *projected* monthly
// deduction under the NEW regime from salary income only. It does not model
// old-regime chapter VI-A investment declarations, house-property loss, other
// income, surcharge above ₹50L, or mid-year joiners' prior-employer income.
// computeTds() returns `estimateOnly: true` and callers must not present it
// as a filed TDS figure. Old-regime employees fall back to no auto-TDS.

export const STATUTORY_VERSION = 'IN-FY2025-26';

export const PF_RULES = {
  effectiveFrom: '2014-09-01',
  employeeRate: 0.12,
  employerRate: 0.12,
  epsRate: 0.0833,
  wageCeiling: 15000,
  edliRate: 0.005,
  adminRate: 0.005,
};

export const ESI_RULES = {
  effectiveFrom: '2019-07-01',
  employeeRate: 0.0075,
  employerRate: 0.0325,
  wageLimit: 21000,
};

// Professional tax is levied by the state, so this is keyed by state and any
// state not listed here yields zero with `applicable: false` — an explicit
// "we do not model this state" rather than a silently-wrong ₹0.
export const PT_RULES = {
  effectiveFrom: '2025-04-01',
  annualCap: 2500,
  states: {
    Karnataka: {
      slabs: [
        { upTo: 25000, amount: 0 },
        { upTo: Infinity, amount: 200 },
      ],
      februaryAmount: 300,
    },
    Maharashtra: {
      // Gendered slabs are a feature of the Maharashtra Act itself.
      slabsByGender: {
        female: [
          { upTo: 25000, amount: 0 },
          { upTo: Infinity, amount: 200 },
        ],
        default: [
          { upTo: 7500, amount: 0 },
          { upTo: 10000, amount: 175 },
          { upTo: Infinity, amount: 200 },
        ],
      },
      februaryAmount: 300,
    },
    'West Bengal': {
      slabs: [
        { upTo: 10000, amount: 0 },
        { upTo: 15000, amount: 110 },
        { upTo: 25000, amount: 130 },
        { upTo: 40000, amount: 150 },
        { upTo: Infinity, amount: 200 },
      ],
    },
    'Tamil Nadu': {
      // Half-yearly levy in law; expressed here as its monthly equivalent.
      slabs: [
        { upTo: 21000, amount: 0 },
        { upTo: 30000, amount: 135 },
        { upTo: 45000, amount: 315 },
        { upTo: 60000, amount: 690 },
        { upTo: 75000, amount: 1025 },
        { upTo: Infinity, amount: 1250 },
      ],
      halfYearly: true,
    },
    Telangana: {
      slabs: [
        { upTo: 15000, amount: 0 },
        { upTo: 20000, amount: 150 },
        { upTo: Infinity, amount: 200 },
      ],
    },
    'Andhra Pradesh': {
      slabs: [
        { upTo: 15000, amount: 0 },
        { upTo: 20000, amount: 150 },
        { upTo: Infinity, amount: 200 },
      ],
    },
    Gujarat: {
      slabs: [
        { upTo: 12000, amount: 0 },
        { upTo: Infinity, amount: 200 },
      ],
    },
  },
};

// New regime, s.115BAC, FY 2025-26 (AY 2026-27).
export const TDS_RULES = {
  effectiveFrom: '2025-04-01',
  regime: 'new',
  standardDeduction: 75000,
  rebate87A: { maxTotalIncome: 1200000, maxRebate: 60000 },
  cessRate: 0.04,
  slabs: [
    { upTo: 400000, rate: 0 },
    { upTo: 800000, rate: 0.05 },
    { upTo: 1200000, rate: 0.10 },
    { upTo: 1600000, rate: 0.15 },
    { upTo: 2000000, rate: 0.20 },
    { upTo: 2400000, rate: 0.25 },
    { upTo: Infinity, rate: 0.30 },
  ],
};

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const rupees = (n) => Math.round(Number(n) || 0);

/**
 * EPF / EPS split.
 *
 * `pfWages` is basic + DA. The statutory ceiling caps the contribution base at
 * ₹15,000 unless the employer has opted to contribute on full wages, which is
 * a real and common arrangement — hence `contributeOnFullWages`.
 */
export function computePf(pfWages, { applicable = true, contributeOnFullWages = false } = {}) {
  const wages = Math.max(0, Number(pfWages) || 0);
  if (!applicable || wages <= 0) {
    return { applicable: false, base: 0, employee: 0, employerEps: 0, employerEpf: 0, employerTotal: 0 };
  }
  const base = contributeOnFullWages ? wages : Math.min(wages, PF_RULES.wageCeiling);
  const employee = rupees(base * PF_RULES.employeeRate);
  // EPS is always capped at the statutory ceiling even when EPF is on full wages.
  const employerEps = rupees(Math.min(base, PF_RULES.wageCeiling) * PF_RULES.epsRate);
  const employerTotal = rupees(base * PF_RULES.employerRate);
  return {
    applicable: true,
    base,
    employee,
    employerEps,
    employerEpf: employerTotal - employerEps,
    employerTotal,
    edli: rupees(Math.min(base, PF_RULES.wageCeiling) * PF_RULES.edliRate),
    admin: rupees(Math.min(base, PF_RULES.wageCeiling) * PF_RULES.adminRate),
  };
}

/**
 * ESI. Applicability is decided on gross wages against the ₹21,000 limit.
 *
 * Contribution-period stickiness is real ESIC behaviour: an employee who
 * crosses the limit mid-period keeps contributing until the period ends.
 * Pass `forceApplicable` when the caller knows that applies.
 */
export function computeEsi(grossWages, { forceApplicable = false } = {}) {
  const gross = Math.max(0, Number(grossWages) || 0);
  const applicable = forceApplicable || (gross > 0 && gross <= ESI_RULES.wageLimit);
  if (!applicable) {
    return { applicable: false, base: gross, employee: 0, employer: 0 };
  }
  return {
    applicable: true,
    base: gross,
    // ESIC rounds the employee share up to the next rupee.
    employee: Math.ceil(gross * ESI_RULES.employeeRate),
    employer: Math.ceil(gross * ESI_RULES.employerRate),
  };
}

/**
 * Professional tax for one month.
 * `month` is 1-12 and only matters for the February top-up some states apply.
 */
export function computeProfessionalTax(grossWages, state, { month = null, gender = null } = {}) {
  const gross = Math.max(0, Number(grossWages) || 0);
  const rule = PT_RULES.states[state];
  if (!state || !rule) {
    return { applicable: false, amount: 0, state: state || null, reason: state ? 'STATE_NOT_MODELLED' : 'STATE_NOT_SET' };
  }
  const slabs = rule.slabsByGender
    ? (rule.slabsByGender[String(gender || '').toLowerCase()] || rule.slabsByGender.default)
    : rule.slabs;
  const slab = slabs.find((s) => gross <= s.upTo);
  let amount = slab ? slab.amount : 0;
  if (amount > 0 && month === 2 && rule.februaryAmount) amount = rule.februaryAmount;
  return { applicable: true, amount, state, annualCap: PT_RULES.annualCap };
}

/** Annual income tax on a taxable figure, under the new-regime slabs. */
export function taxOnSlabs(taxableIncome) {
  let remaining = Math.max(0, Number(taxableIncome) || 0);
  let lastCeiling = 0;
  let tax = 0;
  for (const slab of TDS_RULES.slabs) {
    const width = slab.upTo - lastCeiling;
    const inSlab = Math.min(remaining, width);
    if (inSlab <= 0) break;
    tax += inSlab * slab.rate;
    remaining -= inSlab;
    lastCeiling = slab.upTo;
  }
  return tax;
}

/**
 * Projected monthly TDS under the new regime.
 *
 * ESTIMATE ONLY — see the scope limit at the top of this file. Returns
 * `estimateOnly: true` so no caller can present it as a filed figure, and
 * `applicable: false` for old-regime employees rather than guessing.
 */
export function computeTds(monthlyTaxableSalary, {
  regime = 'new',
  monthsRemaining = 12,
  taxAlreadyDeducted = 0,
  annualOverride = null,
} = {}) {
  if (regime !== 'new') {
    return {
      applicable: false, estimateOnly: true, monthly: 0, annualTax: 0,
      reason: 'OLD_REGIME_NOT_MODELLED',
    };
  }
  const annualGross = annualOverride != null
    ? Math.max(0, Number(annualOverride) || 0)
    : Math.max(0, Number(monthlyTaxableSalary) || 0) * 12;

  const taxableIncome = Math.max(0, annualGross - TDS_RULES.standardDeduction);
  let tax = taxOnSlabs(taxableIncome);

  // s.87A rebate wipes out the liability up to the threshold.
  if (taxableIncome <= TDS_RULES.rebate87A.maxTotalIncome) {
    tax = Math.max(0, tax - TDS_RULES.rebate87A.maxRebate);
  }
  const annualTax = tax > 0 ? tax * (1 + TDS_RULES.cessRate) : 0;

  const months = Math.max(1, Math.min(12, Number(monthsRemaining) || 12));
  const outstanding = Math.max(0, annualTax - (Number(taxAlreadyDeducted) || 0));

  return {
    applicable: annualTax > 0,
    estimateOnly: true,
    regime: 'new',
    annualGross: rupees(annualGross),
    taxableIncome: rupees(taxableIncome),
    annualTax: rupees(annualTax),
    monthly: rupees(outstanding / months),
    note: 'Projected from salary income under the new regime only — excludes investment declarations, other income and surcharge.',
  };
}

/**
 * Full statutory deduction set for one payroll cycle.
 *
 * Returns the employee-side deduction lines (what comes off the payslip), the
 * employer-side cost lines (what the company owes on top), and a `warnings`
 * array naming everything that could NOT be computed — a missing state, a
 * missing UAN, an old-regime employee. Silent zeros are how statutory
 * under-deduction happens, so nothing is silently zero here.
 */
export function computeStatutoryDeductions({
  gross,
  basic = null,
  da = 0,
  state = null,
  gender = null,
  month = null,
  pan = '',
  uan = '',
  esiNumber = '',
  taxRegime = 'new',
  pfApplicable = true,
  pfOnFullWages = false,
  esiForceApplicable = false,
  annualTaxableOverride = null,
  monthsRemaining = 12,
  taxAlreadyDeducted = 0,
} = {}) {
  const grossAmt = Math.max(0, Number(gross) || 0);
  const warnings = [];

  // Where no explicit basic is on file, fall back to the 50%-of-gross split
  // that the Code on Wages pushes toward. Flagged, because it is an
  // assumption about someone's real salary structure.
  let basicAmt = basic == null ? null : Math.max(0, Number(basic) || 0);
  if (basicAmt == null) {
    basicAmt = r2(grossAmt * 0.5);
    warnings.push('BASIC_ASSUMED_50_PERCENT_OF_GROSS');
  }
  const pfWages = basicAmt + (Number(da) || 0);

  const pf = computePf(pfWages, { applicable: pfApplicable, contributeOnFullWages: pfOnFullWages });
  if (pf.applicable && !uan) warnings.push('PF_COMPUTED_BUT_UAN_MISSING');

  const esi = computeEsi(grossAmt, { forceApplicable: esiForceApplicable });
  if (esi.applicable && !esiNumber) warnings.push('ESI_COMPUTED_BUT_ESI_NUMBER_MISSING');

  const pt = computeProfessionalTax(grossAmt, state, { month, gender });
  if (!pt.applicable) warnings.push(`PT_NOT_COMPUTED_${pt.reason}`);

  const tds = computeTds(grossAmt, {
    regime: taxRegime,
    monthsRemaining,
    taxAlreadyDeducted,
    annualOverride: annualTaxableOverride,
  });
  if (tds.applicable && !pan) warnings.push('TDS_COMPUTED_BUT_PAN_MISSING');
  if (taxRegime !== 'new') warnings.push('TDS_NOT_COMPUTED_OLD_REGIME_NOT_MODELLED');

  const deductions = [];
  if (pf.employee > 0) deductions.push({ name: 'Provident Fund (EPF)', amount: pf.employee, category: 'PF' });
  if (esi.employee > 0) deductions.push({ name: 'ESI', amount: esi.employee, category: 'ESI' });
  if (pt.amount > 0) deductions.push({ name: `Professional Tax (${pt.state})`, amount: pt.amount, category: 'PT' });
  if (tds.monthly > 0) deductions.push({ name: 'TDS (estimated)', amount: tds.monthly, category: 'TDS' });

  const employeeTotal = deductions.reduce((sum, d) => sum + d.amount, 0);

  return {
    version: STATUTORY_VERSION,
    basic: basicAmt,
    pfWages,
    deductions,
    employeeTotal,
    employerCost: {
      pfEpf: pf.employerEpf || 0,
      pfEps: pf.employerEps || 0,
      pfEdli: pf.edli || 0,
      pfAdmin: pf.admin || 0,
      esi: esi.employer || 0,
      total: (pf.employerTotal || 0) + (pf.edli || 0) + (pf.admin || 0) + (esi.employer || 0),
    },
    detail: { pf, esi, pt, tds },
    warnings,
  };
}
