const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.MASTER_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
process.env.TOTP_ISSUER_NAME ||= 'OpenCAI Test';
process.env.S3_ENDPOINT ||= 'http://localhost:9000';
process.env.S3_ACCESS_KEY ||= 'test';
process.env.S3_SECRET_KEY ||= 'test';
process.env.S3_BUCKET ||= 'test';

const mailer = require('./mailer');
const mailSettingsService = require('../modules/admin/mailSettings.service');
const { ERROR_CODES } = require('../constants/errors');

const BASE = { host: 'smtp.example.test', port: 587, username: 'mailer', password: 'pw' };

test('transportOptions: maps each security mode', () => {
  assert.deepEqual(mailer.transportOptions({ ...BASE, security: 'NONE' }), {
    host: 'smtp.example.test',
    port: 587,
    secure: false,
    ignoreTLS: true,
    auth: { user: 'mailer', pass: 'pw' },
  });
  assert.deepEqual(mailer.transportOptions({ ...BASE, security: 'STARTTLS' }), {
    host: 'smtp.example.test',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: 'mailer', pass: 'pw' },
  });
  assert.deepEqual(mailer.transportOptions({ ...BASE, security: 'TLS' }), {
    host: 'smtp.example.test',
    port: 587,
    secure: true,
    auth: { user: 'mailer', pass: 'pw' },
  });
});

test('transportOptions: omits auth without a username', () => {
  const options = mailer.transportOptions({ ...BASE, username: null, security: 'TLS' });
  assert.equal('auth' in options, false);
});

test('sendMail: throws MAIL_NOT_CONFIGURED when mail is off', async () => {
  const original = mailSettingsService.getActiveMailSettings;
  mailSettingsService.getActiveMailSettings = async () => null;
  try {
    await assert.rejects(
      mailer.sendMail({ to: 'a@example.test', subject: 's', text: 't', html: '<p>t</p>' }),
      { status: 409, code: ERROR_CODES.MAIL_NOT_CONFIGURED },
    );
  } finally {
    mailSettingsService.getActiveMailSettings = original;
  }
});
