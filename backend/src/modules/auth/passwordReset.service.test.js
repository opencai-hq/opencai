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
const mailer = require('../../mail/mailer');
const mailSettingsService = require('../admin/mailSettings.service');
const service = require('./passwordReset.service');
const { ERROR_CODES } = require('../../constants/errors');
const { AUDIT_ACTIONS } = require('../../constants/auditActions');

/* -------------------------------------------------------------------------- */
/* Mock helpers -- direct reassignment, restored in `finally`.                */
/* -------------------------------------------------------------------------- */

const originals = {
  userFindUnique: prisma.user.findUnique,
  userUpdate: prisma.user.update,
  tokenDeleteMany: prisma.passwordResetToken.deleteMany,
  tokenCreate: prisma.passwordResetToken.create,
  tokenFindUnique: prisma.passwordResetToken.findUnique,
  tokenUpdateMany: prisma.passwordResetToken.updateMany,
  auditLogCreate: prisma.auditLog.create,
  transaction: prisma.$transaction,
  sendMail: mailer.sendMail,
  getActiveMailSettings: mailSettingsService.getActiveMailSettings,
};

function restoreAll() {
  prisma.user.findUnique = originals.userFindUnique;
  prisma.user.update = originals.userUpdate;
  prisma.passwordResetToken.deleteMany = originals.tokenDeleteMany;
  prisma.passwordResetToken.create = originals.tokenCreate;
  prisma.passwordResetToken.findUnique = originals.tokenFindUnique;
  prisma.passwordResetToken.updateMany = originals.tokenUpdateMany;
  prisma.auditLog.create = originals.auditLogCreate;
  prisma.$transaction = originals.transaction;
  mailer.sendMail = originals.sendMail;
  mailSettingsService.getActiveMailSettings = originals.getActiveMailSettings;
}

const MAIL = { enabled: true, publicAppUrl: 'https://opencai.test' };
const USER = { id: 'u-1', username: 'ann', email: 'ann@example.com', isActive: true };

// Records every call in order into `calls` and every mail into `mails`.
function mockRequest({ user = USER, mail = MAIL, sendMail } = {}) {
  const calls = [];
  const mails = [];
  mailSettingsService.getActiveMailSettings = async () => mail;
  prisma.user.findUnique = async (args) => {
    calls.push(['user.findUnique', args]);
    return user;
  };
  prisma.passwordResetToken.deleteMany = async (args) => {
    calls.push(['token.deleteMany', args]);
    return { count: 0 };
  };
  prisma.passwordResetToken.create = async (args) => {
    calls.push(['token.create', args]);
    return { id: 't-1', ...args.data };
  };
  prisma.auditLog.create = async (args) => {
    calls.push(['auditLog.create', args]);
  };
  prisma.$transaction = async (ops) => Promise.all(ops);
  mailer.sendMail =
    sendMail ||
    (async (message) => {
      mails.push(message);
    });
  return { calls, mails };
}

// Issuing the link runs after requestReset has answered; let it finish.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const tokenFromLink = (text) => /reset-password\?token=([A-Za-z0-9_-]+)/.exec(text)[1];

/* -------------------------------------------------------------------------- */
/* requestReset                                                               */
/* -------------------------------------------------------------------------- */

test('requestReset: matches email case-insensitively and trims', async () => {
  const { calls, mails } = mockRequest();
  try {
    await service.requestReset('  Ann@Example.com ');
    await settle();
    assert.deepEqual(calls[0], ['user.findUnique', { where: { email: 'ann@example.com' } }]);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'ann@example.com');
    assert.match(mails[0].text, /https:\/\/opencai\.test\/reset-password\?token=/);
  } finally {
    restoreAll();
  }
});

test('requestReset: a username is looked up by username', async () => {
  const { calls } = mockRequest();
  try {
    await service.requestReset('ann');
    assert.deepEqual(calls[0], ['user.findUnique', { where: { username: 'ann' } }]);
  } finally {
    restoreAll();
  }
});

test('requestReset: sends nothing for an unknown user, an inactive user, or a user without email', async () => {
  for (const user of [null, { ...USER, isActive: false }, { ...USER, email: null }]) {
    const { calls, mails } = mockRequest({ user });
    try {
      await service.requestReset('ann');
      assert.deepEqual(mails, []);
      assert.equal(
        calls.some(([name]) => name === 'token.create'),
        false,
      );
    } finally {
      restoreAll();
    }
  }
});

test('requestReset: sends nothing while mail is off', async () => {
  const { calls, mails } = mockRequest({ mail: null });
  try {
    await service.requestReset('ann');
    assert.deepEqual(mails, []);
    assert.equal(
      calls.some(([name]) => name === 'token.create'),
      false,
    );
  } finally {
    restoreAll();
  }
});

test('requestReset: deletes earlier unused tokens before creating a new one', async () => {
  const { calls, mails } = mockRequest();
  try {
    await service.requestReset('ann');
    await settle();
    const names = calls.map(([name]) => name);
    assert.ok(names.indexOf('token.deleteMany') < names.indexOf('token.create'));
    const [, deleteArgs] = calls.find(([name]) => name === 'token.deleteMany');
    assert.deepEqual(deleteArgs, { where: { userId: USER.id, usedAt: null } });

    const [, createArgs] = calls.find(([name]) => name === 'token.create');
    const token = tokenFromLink(mails[0].text);
    assert.equal(createArgs.data.tokenHash, service.hashToken(token));
    assert.notEqual(createArgs.data.tokenHash, token);
    const lifetimeMs = createArgs.data.expiresAt.getTime() - Date.now();
    assert.ok(lifetimeMs > 29 * 60 * 1000 && lifetimeMs <= 30 * 60 * 1000);

    const [, auditArgs] = calls.find(([name]) => name === 'auditLog.create');
    assert.equal(auditArgs.data.action, AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED);
  } finally {
    restoreAll();
  }
});

test('requestReset: resolves even when sending fails', async () => {
  let unhandled = null;
  const onUnhandled = (reason) => {
    unhandled = reason;
  };
  process.once('unhandledRejection', onUnhandled);
  const originalConsoleError = console.error;
  console.error = () => {};
  mockRequest({ sendMail: () => Promise.reject(new Error('SMTP down')) });
  try {
    await service.requestReset('ann');
    await settle();
    assert.equal(unhandled, null);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    console.error = originalConsoleError;
    restoreAll();
  }
});

test('requestReset: answers before the link is issued, so timing does not reveal the account', async () => {
  mockRequest();
  // The database writes for a real account never finish here...
  prisma.$transaction = () => new Promise(() => {});
  try {
    // ...yet the request still answers straight after the lookup, as for an unknown name.
    const answered = await Promise.race([
      service.requestReset('ann').then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    assert.equal(answered, true);
  } finally {
    restoreAll();
  }
});

/* -------------------------------------------------------------------------- */
/* confirmReset                                                               */
/* -------------------------------------------------------------------------- */

const VALID_TOKEN = {
  id: 't-1',
  userId: USER.id,
  usedAt: null,
  expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  user: USER,
};

function mockConfirm({ stored = VALID_TOKEN, claimed = 1 } = {}) {
  const userUpdates = [];
  const audits = [];
  const mails = [];
  mailSettingsService.getActiveMailSettings = async () => MAIL;
  prisma.passwordResetToken.findUnique = async () => stored;
  prisma.passwordResetToken.updateMany = async () => ({ count: claimed });
  prisma.user.update = async (args) => {
    userUpdates.push(args);
    return { ...USER, sessionVersion: 1 };
  };
  prisma.auditLog.create = async (args) => {
    audits.push(args.data);
  };
  mailer.sendMail = async (message) => {
    mails.push(message);
  };
  return { userUpdates, audits, mails };
}

test('confirmReset: sets the password and audits', async () => {
  const { userUpdates, audits, mails } = mockConfirm();
  try {
    await service.confirmReset('raw-token', 'new-password');
    assert.equal(userUpdates.length, 1);
    assert.equal(userUpdates[0].data.mustChangePassword, false);
    assert.deepEqual(userUpdates[0].data.sessionVersion, { increment: 1 });
    assert.equal(audits[0].action, AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED);
    await new Promise(setImmediate);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, USER.email);
  } finally {
    restoreAll();
  }
});

test('confirmReset: rejects expired, used and unknown tokens', async () => {
  const cases = [
    { ...VALID_TOKEN, expiresAt: new Date(Date.now() - 1000) },
    { ...VALID_TOKEN, usedAt: new Date() },
    null,
    { ...VALID_TOKEN, user: { ...USER, isActive: false } },
  ];
  for (const stored of cases) {
    const { userUpdates } = mockConfirm({ stored });
    try {
      await assert.rejects(service.confirmReset('raw-token', 'new-password'), {
        status: 400,
        code: ERROR_CODES.PASSWORD_RESET_TOKEN_INVALID,
      });
      assert.deepEqual(userUpdates, []);
    } finally {
      restoreAll();
    }
  }
});

test('confirmReset: second concurrent use fails', async () => {
  const { userUpdates } = mockConfirm({ claimed: 0 });
  try {
    await assert.rejects(service.confirmReset('raw-token', 'new-password'), {
      status: 400,
      code: ERROR_CODES.PASSWORD_RESET_TOKEN_INVALID,
    });
    assert.deepEqual(userUpdates, []);
  } finally {
    restoreAll();
  }
});

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

test('buildResetLink: no double slash', () => {
  assert.equal(
    service.buildResetLink('https://x.test/', 'abc'),
    'https://x.test/reset-password?token=abc',
  );
  assert.equal(
    service.buildResetLink('https://x.test/opencai//', 'abc'),
    'https://x.test/opencai/reset-password?token=abc',
  );
});

test('isAvailable: follows whether mail is switched on', async () => {
  try {
    mailSettingsService.getActiveMailSettings = async () => null;
    assert.equal(await service.isAvailable(), false);
    mailSettingsService.getActiveMailSettings = async () => MAIL;
    assert.equal(await service.isAvailable(), true);
  } finally {
    restoreAll();
  }
});
