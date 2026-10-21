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

// The "password changed" notice goes out without being awaited; an SMTP
// failure is logged and never undoes the reset.
function sendInBackground(message) {
  mailer.sendMail(message).catch((err) => {
    console.error('[password-reset] mail failed:', err.message);
  });
}

// Stores a fresh link (replacing any the user asked for earlier) and mails it.
async function issueResetLink(user, mail) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

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

  await mailer.sendMail({
    to: user.email,
    ...passwordResetEmail({
      username: user.username,
      link: buildResetLink(mail.publicAppUrl, token),
      expiresMinutes: RESET_TOKEN_TTL_MINUTES,
    }),
  });
}

/**
 * Never reveals whether the account exists: a real account and an unknown
 * name both answer straight after the lookup -- the link is issued and mailed
 * afterwards, so neither the response nor its timing differs. Failures there
 * are logged, never surfaced to the requester.
 */
async function requestReset(identifier) {
  const mail = await mailSettingsService.getActiveMailSettings();
  if (!mail) return;

  const trimmed = identifier.trim();
  const where = trimmed.includes('@') ? { email: trimmed.toLowerCase() } : { username: trimmed };
  const user = await prisma.user.findUnique({ where });
  if (!user || !user.isActive || !user.email) return;

  issueResetLink(user, mail).catch((err) => {
    console.error('[password-reset] could not issue a reset link:', err.message);
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
