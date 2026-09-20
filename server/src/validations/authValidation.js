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

// The same password, reached by the mobile number stored on the employee
// record. No new credential and no new factor — just a second identifier.
export const loginMobileSchema = Joi.object({
  mobile: Joi.string().required().trim().messages({
    'any.required': 'Mobile number is required',
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
  newPassword: Joi.string()
    .min(PASSWORD_MIN_LENGTH)
    .pattern(/^(?=.*[A-Za-z])(?=.*\d).+$/)
    .required()
    .messages({
      'string.min': PASSWORD_POLICY_MESSAGE,
      'string.pattern.base': PASSWORD_POLICY_MESSAGE,
    }),
});

export const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required().messages({
    'any.required': 'Current password is required',
  }),
  newPassword: Joi.string()
    .min(PASSWORD_MIN_LENGTH)
    .pattern(/^(?=.*[A-Za-z])(?=.*\d).+$/)
    .required()
    .messages({
      'string.min': PASSWORD_POLICY_MESSAGE,
      'string.pattern.base': PASSWORD_POLICY_MESSAGE,
    }),
});
