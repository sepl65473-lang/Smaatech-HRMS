import Joi from 'joi';

// NOTE ON `.unknown()`: these schemas are deliberately CLOSED (Joi's default).
// The previous versions ended in `.unknown(true)`, which — as Joi resolves it —
// overrides the `stripUnknown: true` passed by middleware/validation.js, so
// every extra key in a request body flowed straight through into
// `Payroll.create(body)` / `findByIdAndUpdate(req.params.id, req.body)`.
// Closing them is what actually stops mass assignment here.

export const createPayrollSchema = Joi.object({
  empId: Joi.string().required().messages({
    'any.required': 'Employee ID is required',
  }),
  cycle: Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])$/).required().messages({
    'string.pattern.base': 'Cycle must be in YYYY-MM format',
    'any.required': 'Cycle is required',
  }),
  name: Joi.string().allow('').optional(),
  dept: Joi.string().allow('').optional(),
  gross: Joi.number().min(0).max(1e9).optional(),
  deductions: Joi.number().min(0).max(1e9).optional(),
  net: Joi.number().min(0).max(1e9).optional(),
  status: Joi.string().valid('ready', 'processing', 'paid').optional(),
  lopDays: Joi.number().min(0).max(31).optional(),
  lopAmount: Joi.number().min(0).max(1e9).optional(),
  components: Joi.object({
    earnings: Joi.array().items(Joi.object({
      name: Joi.string().max(120).required(),
      amount: Joi.number().min(0).max(1e9).required(),
    })).optional(),
    deductions: Joi.array().items(Joi.object({
      name: Joi.string().max(120).required(),
      amount: Joi.number().min(0).max(1e9).required(),
      category: Joi.string().valid('PF', 'ESI', 'PT', 'TDS', 'Other').optional(),
    })).optional(),
  }).optional(),
});

// A patch must never be able to move a payslip to another company or another
// employee, or forge an idempotency key / lock state — so none of those
// appear here at all.
export const patchPayrollSchema = Joi.object({
  name: Joi.string().allow('').optional(),
  dept: Joi.string().allow('').optional(),
  gross: Joi.number().min(0).max(1e9).optional(),
  deductions: Joi.number().min(0).max(1e9).optional(),
  net: Joi.number().min(0).max(1e9).optional(),
  status: Joi.string().valid('ready', 'processing', 'paid').optional(),
  lopDays: Joi.number().min(0).max(31).optional(),
  lopAmount: Joi.number().min(0).max(1e9).optional(),
  components: createPayrollSchema.extract('components'),
}).min(1);

// The whole-cycle run. Only the cycle is accepted — every figure is derived
// server-side from each employee's own record, so a caller cannot post the
// register's numbers.
export const runPayrollSchema = Joi.object({
  cycle: Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])$/).required().messages({
    'string.pattern.base': 'Cycle must be in YYYY-MM format',
    'any.required': 'Cycle is required',
  }),
});
