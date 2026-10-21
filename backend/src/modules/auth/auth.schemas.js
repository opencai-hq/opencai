const { z } = require('zod');

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const mfaTokenSchema = z.object({
  mfaToken: z.string().min(1),
});

const confirmEnrollmentSchema = z.object({
  enrollmentToken: z.string().min(1),
  code: z.string().min(6).max(8),
});

const verifyMfaSchema = z.object({
  mfaToken: z.string().min(1),
  code: z.string().min(6).max(12),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

const requestPasswordResetSchema = z.object({
  identifier: z.string().trim().min(1).max(254), // username or email
});

const confirmPasswordResetSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});

module.exports = {
  loginSchema,
  mfaTokenSchema,
  confirmEnrollmentSchema,
  verifyMfaSchema,
  changePasswordSchema,
  requestPasswordResetSchema,
  confirmPasswordResetSchema,
};
