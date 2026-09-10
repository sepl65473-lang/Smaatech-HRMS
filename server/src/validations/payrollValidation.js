import Joi from 'joi';

export const createPayrollSchema = Joi.object({
  empId: Joi.string().required().messages({
    'any.required': 'Employee ID is required',
  }),
  cycle: Joi.string().pattern(/^\d{4}-\d{2}$/).required().messages({
    'string.pattern.base': 'Cycle must be in YYYY-MM format',
    'any.required': 'Cycle is required',
  }),
  name: Joi.string().allow('').optional(),
  dept: Joi.string().allow('').optional(),
  gross: Joi.number().min(0).optional(),
  deductions: Joi.number().min(0).optional(),
  net: Joi.number().min(0).optional(),
  status: Joi.string().valid('ready', 'processing', 'paid').optional(),
  lopDays: Joi.number().min(0).optional(),
  lopAmount: Joi.number().min(0).optional(),
  components: Joi.object().unknown(true).optional(),
}).unknown(true);
