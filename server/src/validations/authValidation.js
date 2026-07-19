import Joi from 'joi';

export const loginSchema = Joi.object({
  email: Joi.string().email().required().trim().messages({
    'string.email': 'Please provide a valid email address',
    'any.required': 'Email is required',
  }),
  password: Joi.string().required().messages({
    'any.required': 'Password is required',
  }),
});

export const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().required().trim(),
});

export const resetPasswordSchema = Joi.object({
  email: Joi.string().email().required().trim(),
  otp: Joi.string().required().length(6),
  newPassword: Joi.string().min(6).required(),
});
