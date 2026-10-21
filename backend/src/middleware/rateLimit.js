const { rateLimit } = require('express-rate-limit');
const { ERROR_CODES, ERROR_MESSAGES } = require('../constants/errors');

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

// Per-IP, in-memory limits for the unauthenticated auth endpoints -- slows
// password and MFA-code guessing and stops reset-email floods. Counts reset
// when the backend restarts, which is acceptable for a single instance.
function makeLimiter({ limit, windowMs = FIFTEEN_MINUTES_MS }) {
  return rateLimit({
    windowMs,
    limit,
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

const loginLimiter = makeLimiter({ limit: 20 });
const mfaLimiter = makeLimiter({ limit: 20 });
const resetRequestLimiter = makeLimiter({ limit: 5 });
const resetConfirmLimiter = makeLimiter({ limit: 20 });

module.exports = {
  makeLimiter,
  loginLimiter,
  mfaLimiter,
  resetRequestLimiter,
  resetConfirmLimiter,
};
