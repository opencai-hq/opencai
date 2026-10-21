const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { ERROR_CODES, ERROR_MESSAGES } = require('../constants/errors');

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

// In-memory limits for the unauthenticated auth endpoints -- slows password
// and MFA-code guessing and stops reset-email floods. Counts reset when the
// backend restarts, which is acceptable for a single instance.
//
// Each count is per IP *and* per account (`keyField` names the request-body
// field that identifies it): behind a reverse proxy or Docker's NAT every
// user shares one IP, and an IP-only count would lock out the whole
// organisation once anyone hit it.
function makeLimiter({ limit, keyField, windowMs = FIFTEEN_MINUTES_MS }) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator: (req) => {
      const account = String(req.body?.[keyField] ?? '')
        .trim()
        .toLowerCase();
      return `${ipKeyGenerator(req.ip)}|${account}`;
    },
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({
        error: {
          code: ERROR_CODES.RATE_LIMITED,
          message: ERROR_MESSAGES[ERROR_CODES.RATE_LIMITED],
        },
      });
    },
  });
}

const loginLimiter = makeLimiter({ limit: 20, keyField: 'username' });
// The mfa-pending token is per sign-in, and sign-ins are limited per username.
const mfaLimiter = makeLimiter({ limit: 20, keyField: 'mfaToken' });
const resetRequestLimiter = makeLimiter({ limit: 5, keyField: 'identifier' });
const resetConfirmLimiter = makeLimiter({ limit: 20, keyField: 'token' });

module.exports = {
  makeLimiter,
  loginLimiter,
  mfaLimiter,
  resetRequestLimiter,
  resetConfirmLimiter,
};
