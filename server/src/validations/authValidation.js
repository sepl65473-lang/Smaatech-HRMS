import Joi from 'joi';
import { PASSWORD_MIN_LENGTH, PASSWORD_POLICY_MESSAGE } from '../lib/passwordPolicy.js';

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

export const verifyTwoFactorSchema = Joi.object({
  email: Joi.string().email().required().trim(),
  otp: Joi.string().required().length(6),
});

export const resetPasswordSchema = Joi.object({
  email: Joi.string().email().required().trim(),
  otp: Joi.string().required().length(6),
  newPassword: Joi.string()
    .min(PASSWORD_MIN_LENGTH)
    .pattern(/^(?=.*[A-Za-z])(?=.*\d).+$/)
    .required()
    .messages({
      'string.min': PASSWORD_POLICY_MESSAGE,
      'string.pattern.base': PASSWORD_POLICY_MESSAGE,
    }),
});
