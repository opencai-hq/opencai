const jwt = require('jsonwebtoken');
const config = require('../config/env');
const prisma = require('../config/db');
const { AppError } = require('./errorHandler');
const { ERROR_CODES } = require('../constants/errors');

// Verifies a session JWT (issued by modules/auth on successful login + MFA)
// shaped { sub, username, role, sv }, and attaches the user to req.user.
//
// The user is loaded on every request so a session ends as soon as the user
// is deactivated or deleted, or their password changes (sessionVersion moves
// past the token's `sv`). Tokens issued before `sv` existed read as 0.
//
// The same check guards the WebSocket (see realtime/socketServer.js), where
// the token arrives in the first frame instead of a header.

/**
 * The signed-in user a session token belongs to.
 *
 * @returns {Promise<{ id: string, username: string, role: string }>}
 * @throws {AppError} 401 for a missing, invalid or revoked token; 403 when the
 *   user must choose a new password first.
 */
async function verifySessionToken(token, { allowPasswordChangeRequired = false } = {}) {
  if (!token) throw new AppError(401, ERROR_CODES.UNAUTHENTICATED);

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    throw new AppError(401, ERROR_CODES.UNAUTHENTICATED);
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || !user.isActive || (payload.sv ?? 0) !== user.sessionVersion) {
    throw new AppError(401, ERROR_CODES.UNAUTHENTICATED);
  }
  if (user.mustChangePassword && !allowPasswordChangeRequired) {
    throw new AppError(403, ERROR_CODES.PASSWORD_CHANGE_REQUIRED);
  }
  return { id: user.id, username: user.username, role: user.role };
}

function authenticate({ allowPasswordChangeRequired = false } = {}) {
  return async function (req, res, next) {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      return next(new AppError(401, ERROR_CODES.UNAUTHENTICATED));
    }

    try {
      req.user = await verifySessionToken(token, { allowPasswordChangeRequired });
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

const requireAuth = authenticate();

// Only for the change-password route: the one thing a user who must choose a
// new password is allowed to do.
const requireAuthAllowingPasswordChange = authenticate({ allowPasswordChangeRequired: true });

module.exports = {
  authenticate,
  verifySessionToken,
  requireAuth,
  requireAuthAllowingPasswordChange,
};
