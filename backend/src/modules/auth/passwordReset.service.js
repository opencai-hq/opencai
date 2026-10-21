const crypto = require('crypto');
const prisma = require('../../config/db');
const mailer = require('../../mail/mailer');
const mailSettingsService = require('../admin/mailSettings.service');
const { passwordResetEmail, passwordChangedEmail } = require('../../mail/templates');
const { setUserPassword } = require('./passwords');
const { AppError } = require('../../middleware/errorHandler');
const { ERROR_CODES } = require('../../constants/errors');
const { AUDIT_ACTIONS, AUDIT_OUTCOMES } = require('../../constants/auditActions');

const RESET_TOKEN_TTL_MINUTES = 30;

// Only this hash is stored: a database leak doesn't hand out working links.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function buildResetLink(publicAppUrl, token) {
  return `${publicAppUrl.replace(/\/+$/, '')}/reset-password?token=${token}`;
}

async function isAvailable() {
  return Boolean(await mailSettingsService.getActiveMailSettings());
}

// Mail goes out without being awaited, so a request for a real account takes
// no longer to answer than one for an unknown name -- and an SMTP failure is
// logged, never surfaced to the requester.
function sendInBackground(message) {
  mailer.sendMail(message).catch((err) => {
    console.error('[password-reset] mail failed:', err.message);
  });
}

/** Never reveals whether the account exists: resolves the same way either way. */
async function requestReset(identifier) {
  const mail = await mailSettingsService.getActiveMailSettings();
  if (!mail) return;

  const trimmed = identifier.trim();
  const where = trimmed.includes('@') ? { email: trimmed.toLowerCase() } : { username: trimmed };
  const user = await prisma.user.findUnique({ where });
  if (!user || !user.isActive || !user.email) return;

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

  // A new link replaces any the user asked for earlier.
  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } }),
    prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hashToken(token), expiresAt },
    }),
  ]);
  await prisma.auditLog.create({
    data: {
      actorUserId: user.id,
      action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
      outcome: AUDIT_OUTCOMES.SUCCESS,
    },
  });

  sendInBackground({
    to: user.email,
    ...passwordResetEmail({
      username: user.username,
      link: buildResetLink(mail.publicAppUrl, token),
      expiresMinutes: RESET_TOKEN_TTL_MINUTES,
    }),
  });
}

// Sets the new password but does not sign the user in: they go back to the
// login page and still pass MFA.
async function confirmReset(token, newPassword) {
  const invalid = () => new AppError(400, ERROR_CODES.PASSWORD_RESET_TOKEN_INVALID);

  const stored = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!stored || stored.usedAt || stored.expiresAt <= new Date() || !stored.user.isActive) {
    throw invalid();
  }

  // Claiming the token and checking the count makes two simultaneous uses of
  // the same link succeed only once.
  const { count } = await prisma.passwordResetToken.updateMany({
    where: { id: stored.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (count !== 1) {
    throw invalid();
  }

  await setUserPassword(stored.userId, newPassword, { mustChangePassword: false });
  await prisma.auditLog.create({
    data: {
      actorUserId: stored.userId,
      action: AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED,
      outcome: AUDIT_OUTCOMES.SUCCESS,
    },
  });

  if (stored.user.email) {
    sendInBackground({
      to: stored.user.email,
      ...passwordChangedEmail({ username: stored.user.username }),
    });
  }
}

module.exports = {
  RESET_TOKEN_TTL_MINUTES,
  hashToken,
  buildResetLink,
  isAvailable,
  requestReset,
  confirmReset,
};
