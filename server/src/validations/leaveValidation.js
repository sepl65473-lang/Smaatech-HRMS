import Joi from 'joi';

export const fileLeaveSchema = Joi.object({
  empId: Joi.string().required().messages({
    'any.required': 'Employee ID is required',
  }),
  name: Joi.string().allow('').optional(),
  dept: Joi.string().allow('').optional(),
  type: Joi.string().valid('sick', 'casual', 'earned', 'unpaid', 'maternity', 'paternity').required().messages({
    'any.required': 'Leave type is required',
  }),
  start: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required().messages({
    'string.pattern.base': 'Start date must be in YYYY-MM-DD format',
    'any.required': 'Start date is required',
  }),
  end: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required().messages({
    'string.pattern.base': 'End date must be in YYYY-MM-DD format',
    'any.required': 'End date is required',
  }),
  reason: Joi.string().allow('').optional(),
  isHalfDay: Joi.boolean().optional(),
  halfDayTiming: Joi.string().valid('first-half', 'second-half', '').optional(),
  attachment: Joi.string().allow('').optional(),
}).unknown(true);
