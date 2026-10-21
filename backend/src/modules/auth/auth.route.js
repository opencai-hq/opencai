const express = require('express');
const { validate } = require('../../middleware/validate');
const { requireAuthAllowingPasswordChange } = require('../../middleware/auth');
const {
  loginLimiter,
  mfaLimiter,
  resetRequestLimiter,
  resetConfirmLimiter,
} = require('../../middleware/rateLimit');
const controller = require('./auth.controller');
const {
  loginSchema,
  mfaTokenSchema,
  confirmEnrollmentSchema,
  verifyMfaSchema,
  changePasswordSchema,
  requestPasswordResetSchema,
  confirmPasswordResetSchema,
} = require('./auth.schemas');

const router = express.Router();

router.post('/login', loginLimiter, validate(loginSchema), controller.login);
router.post('/mfa/enroll/start', validate(mfaTokenSchema), controller.startEnrollment);
router.post('/mfa/enroll/confirm', validate(confirmEnrollmentSchema), controller.confirmEnrollment);
router.post('/mfa/verify', mfaLimiter, validate(verifyMfaSchema), controller.verifyMfa);
router.post(
  '/change-password',
  requireAuthAllowingPasswordChange,
  validate(changePasswordSchema),
  controller.changePassword,
);

router.get('/password-reset/available', controller.passwordResetAvailable);
router.post(
  '/password-reset/request',
  resetRequestLimiter,
  validate(requestPasswordResetSchema),
  controller.requestPasswordReset,
);
router.post(
  '/password-reset/confirm',
  resetConfirmLimiter,
  validate(confirmPasswordResetSchema),
  controller.confirmPasswordReset,
);

module.exports = router;
