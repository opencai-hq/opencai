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

const prisma = require('../../config/db');
const envelope = require('../../crypto/envelope');
const service = require('./mailSettings.service');
const { updateMailSettingsSchema } = require('./mailSettings.schemas');
const { requireMasterAdmin } = require('../../middleware/rbac');
const { MASTER_ADMIN_USERNAME } = require('../../constants/admin');

const originals = {
  findFirst: prisma.mailSettings.findFirst,
  update: prisma.mailSettings.update,
  create: prisma.mailSettings.create,
  auditLogCreate: prisma.auditLog.create,
};

function restoreAll() {
  prisma.mailSettings.findFirst = originals.findFirst;
  prisma.mailSettings.update = originals.update;
  prisma.mailSettings.create = originals.create;
  prisma.auditLog.create = originals.auditLogCreate;
}

const ROW = {
  id: 'mail-1',
  enabled: true,
  host: 'smtp.example.test',
  port: 587,
  security: 'STARTTLS',
  username: 'mailer',
  passwordEncrypted: envelope.encrypt('stored-secret'),
  fromAddress: 'opencai@example.test',
  fromName: 'OpenCAI',
  publicAppUrl: 'https://opencai.example.test',
};

const MASTER = { id: 'admin-0', username: MASTER_ADMIN_USERNAME };

// Records the data handed to update() and echoes it back on top of ROW.
function mockExistingRow() {
  const updates = [];
  prisma.mailSettings.findFirst = async () => ROW;
  prisma.mailSettings.update = async (args) => {
    updates.push(args.data);
    return { ...ROW, ...args.data };
  };
  prisma.auditLog.create = async () => {};
  return updates;
}

test('getMailSettings: never returns the password', async () => {
  prisma.mailSettings.findFirst = async () => ROW;
  try {
    const settings = await service.getMailSettings();
    assert.equal('passwordEncrypted' in settings, false);
    assert.equal('password' in settings, false);
    assert.equal(settings.hasPassword, true);
    assert.equal(settings.host, ROW.host);
  } finally {
    restoreAll();
  }
});

test('updateMailSettings: keeps the stored password when none is sent', async () => {
  const updates = mockExistingRow();
  try {
    await service.updateMailSettings(MASTER, { enabled: false, security: 'NONE' });
    assert.equal('passwordEncrypted' in updates[0], false);
  } finally {
    restoreAll();
  }
});

test('updateMailSettings: encrypts a new password', async () => {
  const updates = mockExistingRow();
  try {
    const result = await service.updateMailSettings(MASTER, {
      enabled: false,
      security: 'NONE',
      password: 's3cret',
    });
    assert.equal(envelope.decrypt(updates[0].passwordEncrypted), 's3cret');
    assert.equal('passwordEncrypted' in result, false);
  } finally {
    restoreAll();
  }
});

test('getActiveMailSettings: null while mail is disabled, decrypted when enabled', async () => {
  try {
    prisma.mailSettings.findFirst = async () => ({ ...ROW, enabled: false });
    assert.equal(await service.getActiveMailSettings(), null);
    prisma.mailSettings.findFirst = async () => ROW;
    assert.equal((await service.getActiveMailSettings()).password, 'stored-secret');
  } finally {
    restoreAll();
  }
});

test('updateMailSettingsSchema: requires host, port, fromAddress, publicAppUrl when enabled', () => {
  const result = updateMailSettingsSchema.safeParse({ enabled: true, security: 'TLS' });
  assert.equal(result.success, false);
  const paths = result.error.issues.map((issue) => issue.path.join('.')).sort();
  assert.deepEqual(paths, ['fromAddress', 'host', 'port', 'publicAppUrl']);

  assert.equal(
    updateMailSettingsSchema.safeParse({ enabled: false, security: 'NONE' }).success,
    true,
  );
});

test('requireMasterAdmin: 403 for another admin', () => {
  let error;
  requireMasterAdmin({ user: { id: 'admin-2', username: 'second-admin' } }, {}, (err) => {
    error = err;
  });
  assert.equal(error.status, 403);

  let passed;
  requireMasterAdmin({ user: MASTER }, {}, (err) => {
    passed = err === undefined;
  });
  assert.equal(passed, true);
});
