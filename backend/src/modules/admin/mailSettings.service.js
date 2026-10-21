const prisma = require('../../config/db');
const envelope = require('../../crypto/envelope');
const { AUDIT_ACTIONS, AUDIT_OUTCOMES } = require('../../constants/auditActions');

function toPublicShape(row) {
  if (!row) return null;
  const { passwordEncrypted, ...rest } = row;
  return { ...rest, hasPassword: Boolean(passwordEncrypted) };
}

function withPassword(row) {
  return {
    ...row,
    password: row.passwordEncrypted ? envelope.decrypt(row.passwordEncrypted) : null,
  };
}

async function getMailSettings() {
  const row = await prisma.mailSettings.findFirst({ orderBy: { updatedAt: 'desc' } });
  return toPublicShape(row);
}

async function updateMailSettings(actor, data) {
  const { password, ...rest } = data;
  const updateData = { ...rest };
  if (password) {
    updateData.passwordEncrypted = envelope.encrypt(password);
  }

  const existing = await prisma.mailSettings.findFirst();
  const row = existing
    ? await prisma.mailSettings.update({ where: { id: existing.id }, data: updateData })
    : await prisma.mailSettings.create({ data: updateData });

  await prisma.auditLog.create({
    data: {
      actorUserId: actor.id,
      action: AUDIT_ACTIONS.MAIL_SETTINGS_UPDATED,
      outcome: AUDIT_OUTCOMES.SUCCESS,
      metadata: { enabled: row.enabled },
    },
  });

  return toPublicShape(row);
}

/** The saved settings with the SMTP password decrypted, enabled or not -- for the test email. */
async function getSavedMailSettings() {
  const row = await prisma.mailSettings.findFirst({ orderBy: { updatedAt: 'desc' } });
  return row ? withPassword(row) : null;
}

/** What the mailer sends with: null unless mail is saved and switched on. */
async function getActiveMailSettings() {
  const row = await getSavedMailSettings();
  return row && row.enabled ? row : null;
}

module.exports = {
  getMailSettings,
  updateMailSettings,
  getSavedMailSettings,
  getActiveMailSettings,
};
