const { AppError } = require('./errorHandler');
const { ERROR_CODES } = require('../constants/errors');
const { MASTER_ADMIN_USERNAME } = require('../constants/admin');

// Usage: router.get('/admin-only', requireAuth, requireRole('ADMIN'), handler)
function requireRole(...allowedRoles) {
  return function (req, res, next) {
    if (!req.user) {
      return next(new AppError(401, ERROR_CODES.UNAUTHENTICATED));
    }
    if (!allowedRoles.includes(req.user.role)) {
      return next(new AppError(403, ERROR_CODES.FORBIDDEN));
    }
    return next();
  };
}

// Mail settings decide where password reset links go, so only the master
// admin may see or change them: another admin pointing SMTP at a server they
// control could otherwise capture the master admin's reset link.
function requireMasterAdmin(req, res, next) {
  if (req.user?.username !== MASTER_ADMIN_USERNAME) {
    return next(
      new AppError(403, ERROR_CODES.FORBIDDEN, 'Only the master admin can manage email settings.'),
    );
  }
  return next();
}

module.exports = { requireRole, requireMasterAdmin };
