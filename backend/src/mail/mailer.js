const nodemailer = require('nodemailer');
const mailSettingsService = require('../modules/admin/mailSettings.service');
const { AppError } = require('../middleware/errorHandler');
const { ERROR_CODES } = require('../constants/errors');

// Plain SMTP covers SES, SendGrid, Microsoft 365, Gmail and a self-hosted
// relay alike, so no provider SDK is tied in.
const SECURITY_OPTIONS = {
  NONE: { secure: false, ignoreTLS: true },
  STARTTLS: { secure: false, requireTLS: true },
  TLS: { secure: true },
};

function transportOptions(settings) {
  const options = {
    host: settings.host,
    port: settings.port,
    ...SECURITY_OPTIONS[settings.security],
  };
  if (settings.username) {
    options.auth = { user: settings.username, pass: settings.password };
  }
  return options;
}

function fromHeader(settings) {
  return settings.fromName
    ? `"${settings.fromName}" <${settings.fromAddress}>`
    : settings.fromAddress;
}

// `settings` defaults to the active (enabled) mail settings; the test-email
// action passes the saved ones so an admin can try them before switching on.
async function sendMail({ to, subject, text, html }, settings) {
  const resolved = settings || (await mailSettingsService.getActiveMailSettings());
  if (!resolved) {
    throw new AppError(409, ERROR_CODES.MAIL_NOT_CONFIGURED);
  }

  try {
    await nodemailer
      .createTransport(transportOptions(resolved))
      .sendMail({ from: fromHeader(resolved), to, subject, text, html });
  } catch (err) {
    throw new AppError(
      502,
      ERROR_CODES.MAIL_SEND_FAILED,
      `The email could not be sent: ${err.message}`,
    );
  }
}

module.exports = { transportOptions, sendMail };
