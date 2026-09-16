import Joi from 'joi';

// Deliberately CLOSED schemas (no trailing .unknown(true)). Joi resolves
// `.unknown(true)` as overriding the `stripUnknown: true` that
// middleware/validation.js passes, so the previous `.unknown(true)` version
// let every extra request-body key flow straight through to the handler.

export const fileLeaveSchema = Joi.object({
  empId: Joi.string().required().messages({
    'any.required': 'Employee ID is required',
  }),
  // Leave types are company-configured (models/LeaveType.js) and validated
  // against the database in the handler, so this only checks the shape.
  type: Joi.string().max(40).required().messages({
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
  reason: Joi.string().max(1000).allow('').optional(),
  isHalfDay: Joi.boolean().optional(),
  halfDayTiming: Joi.string().valid('first-half', 'second-half', '').optional(),
  attachment: Joi.string().max(2000).allow('').optional(),
  // Accepted and ignored: the handler always takes these from the employee
  // record so a request can't carry someone else's name into approvals,
  // notifications and the audit trail.
  name: Joi.string().allow('').optional(),
  dept: Joi.string().allow('').optional(),
});

// `status`, `currentStage`, `workingDays`, `empId` and `company` are
// intentionally absent: flipping status here would skip every approval stage,
// the balance deduction and the attendance marking. Decisions go through
// /approve and /decline.
export const patchLeaveSchema = Joi.object({
  reason: Joi.string().max(1000).allow('').optional(),
  attachment: Joi.string().max(2000).allow('').optional(),
  halfDayTiming: Joi.string().valid('first-half', 'second-half', '').optional(),
}).min(1);

export const decisionSchema = Joi.object({
  note: Joi.string().max(1000).allow('').optional(),
});
