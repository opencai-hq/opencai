const bcrypt = require('bcryptjs');
const prisma = require('../../config/db');
const { ROLES } = require('../../constants/roles');
const { MASTER_ADMIN_USERNAME } = require('../../constants/admin');
const { AppError } = require('../../middleware/errorHandler');
const { ERROR_CODES } = require('../../constants/errors');
const { AUDIT_ACTIONS, AUDIT_OUTCOMES } = require('../../constants/auditActions');
const { clearMfa, mfaEnrolled } = require('./mfa');
const { issueTemporaryPassword } = require('../auth/passwords');
const { assertEmailAvailable } = require('./userEmail');

const BCRYPT_COST = 12;

const ADMIN_SELECT = {
  id: true,
  username: true,
  email: true,
  isActive: true,
  createdAt: true,
  totpSecretEncrypted: true,
};

function serialize({ totpSecretEncrypted, ...user }) {
  return {
    ...user,
    isMasterAdmin: user.username === MASTER_ADMIN_USERNAME,
    mfaEnrolled: mfaEnrolled({ totpSecretEncrypted }),
  };
}

async function listAdministrators() {
  const admins = await prisma.user.findMany({
    where: { role: ROLES.ADMIN },
    select: ADMIN_SELECT,
    orderBy: { createdAt: 'asc' },
  });
  return admins.map(serialize);
}

async function createAdministrator(username, password, email) {
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    throw new AppError(409, ERROR_CODES.VALIDATION_ERROR, 'That username is already taken.');
  }
  await assertEmailAvailable(email);

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const admin = await prisma.user.create({
    data: { username, passwordHash, email, role: ROLES.ADMIN },
    select: ADMIN_SELECT,
  });
  return serialize(admin);
}

// Only the master admin edits an Administrator's email (their own included):
// it decides where that account's password reset links go.
async function updateAdministrator(actor, userId, { email }) {
  if (actor.username !== MASTER_ADMIN_USERNAME) {
    throw new AppError(
      403,
      ERROR_CODES.FORBIDDEN,
      "Only the master admin can change an administrator's email.",
    );
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.role !== ROLES.ADMIN) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }
  await assertEmailAvailable(email, userId);

  const admin = await prisma.user.update({
    where: { id: userId },
    data: { email },
    select: ADMIN_SELECT,
  });
  return serialize(admin);
}

async function deleteAdministrator(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.role !== ROLES.ADMIN) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }
  if (user.username === MASTER_ADMIN_USERNAME) {
    throw new AppError(403, ERROR_CODES.FORBIDDEN, 'The master admin account cannot be deleted.');
  }
  await prisma.user.delete({ where: { id: userId } });
}

// Only the master admin may reset an Administrator's MFA -- any other admin's
// and their own. Other admins can still reset Operators' MFA.
async function resetAdministratorMfa(actor, userId) {
  if (actor.username !== MASTER_ADMIN_USERNAME) {
    throw new AppError(
      403,
      ERROR_CODES.FORBIDDEN,
      "Only the master admin can reset an administrator's MFA.",
    );
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.role !== ROLES.ADMIN) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }
  await clearMfa(userId);
}

// Only the master admin may reset an Administrator's password, and never their
// own here (they know it: Change Password). A forgotten master admin password
// is reset from the server with `npm run reset-password`.
async function resetAdministratorPassword(actor, userId) {
  if (actor.username !== MASTER_ADMIN_USERNAME) {
    throw new AppError(
      403,
      ERROR_CODES.FORBIDDEN,
      "Only the master admin can reset an administrator's password.",
    );
  }
  if (actor.id === userId) {
    throw new AppError(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      'Use Change Password for your own account.',
    );
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.role !== ROLES.ADMIN) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }

  const temporaryPassword = await issueTemporaryPassword(userId);
  await prisma.auditLog.create({
    data: {
      actorUserId: actor.id,
      action: AUDIT_ACTIONS.PASSWORD_RESET_BY_ADMIN,
      outcome: AUDIT_OUTCOMES.SUCCESS,
      metadata: { targetUserId: userId },
    },
  });
  return { temporaryPassword };
}

module.exports = {
  listAdministrators,
  createAdministrator,
  updateAdministrator,
  deleteAdministrator,
  resetAdministratorMfa,
  resetAdministratorPassword,
};
