import Joi from 'joi';

export const fileExpenseSchema = Joi.object({
  empId: Joi.string().required().messages({
    'any.required': 'Employee ID is required',
  }),
  category: Joi.string().required().trim().messages({
    'any.required': 'Expense category is required',
  }),
  amount: Joi.number().greater(0).required().messages({
    'number.greater': 'Amount must be greater than 0',
    'any.required': 'Amount is required',
  }),
  date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required().messages({
    'string.pattern.base': 'Date must be in YYYY-MM-DD format',
    'any.required': 'Date is required',
  }),
  name: Joi.string().allow('').optional(),
  description: Joi.string().allow('').optional(),
  receiptUrl: Joi.string().allow('').optional(),
}).unknown(true);
