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

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const otplib = require('otplib');
const prisma = require('../../config/db');
const envelope = require('../../crypto/envelope');
const service = require('./auth.service');
const { ERROR_CODES } = require('../../constants/errors');
const { AUDIT_ACTIONS } = require('../../constants/auditActions');

const originals = {
  userFindUnique: prisma.user.findUnique,
  userUpdate: prisma.user.update,
  auditLogCreate: prisma.auditLog.create,
};

function restoreAll() {
  prisma.user.findUnique = originals.userFindUnique;
  prisma.user.update = originals.userUpdate;
  prisma.auditLog.create = originals.auditLogCreate;
}

const USER = {
  id: 'u-1',
  username: 'ann',
  role: 'OPERATOR',
  isActive: true,
  sessionVersion: 0,
  mustChangePassword: false,
};

const mfaPendingToken = (sv) =>
  jwt.sign({ sub: USER.id, purpose: 'mfa-pending', sv }, process.env.JWT_SECRET, {
    expiresIn: '10m',
  });

function mockEnrolledUser(overrides) {
  const secret = otplib.generateSecret({ length: 20 });
  prisma.user.findUnique = async () => ({
    ...USER,
    totpSecretEncrypted: envelope.encrypt(secret),
    backupCodesHashed: [],
    ...overrides,
  });
  return secret;
}

test('verifyMfa: rejects an mfa-pending token issued before a password reset', async () => {
  const secret = mockEnrolledUser({ sessionVersion: 1 });
  try {
    const code = await otplib.generate({ secret, strategy: 'totp' });
    await assert.rejects(service.verifyMfa(mfaPendingToken(0), code), {
      status: 401,
      code: ERROR_CODES.MFA_TOKEN_INVALID,
    });
  } finally {
    restoreAll();
  }
});

test('verifyMfa: returns mustChangePassword from the user', async () => {
  const secret = mockEnrolledUser({ mustChangePassword: true });
  try {
    const code = await otplib.generate({ secret, strategy: 'totp' });
    const result = await service.verifyMfa(mfaPendingToken(0), code);
    assert.equal(result.mustChangePassword, true);
    assert.equal(jwt.decode(result.token).sv, 0);
  } finally {
    restoreAll();
  }
});

test('changePassword: returns a token carrying the new sessionVersion', async () => {
  const passwordHash = await bcrypt.hash('old-pass', 4);
  const updates = [];
  const audits = [];
  prisma.user.findUnique = async () => ({ ...USER, passwordHash, sessionVersion: 2 });
  prisma.user.update = async (args) => {
    updates.push(args);
    return { ...USER, sessionVersion: 3 };
  };
  prisma.auditLog.create = async (args) => {
    audits.push(args.data);
  };
  try {
    const { token } = await service.changePassword(USER.id, 'old-pass', 'new-password');
    assert.equal(jwt.decode(token).sv, 3);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].data.mustChangePassword, false);
    assert.deepEqual(updates[0].data.sessionVersion, { increment: 1 });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, AUDIT_ACTIONS.PASSWORD_CHANGED);
    assert.equal(audits[0].actorUserId, USER.id);
  } finally {
    restoreAll();
  }
});

test('changePassword: wrong current password', async () => {
  const passwordHash = await bcrypt.hash('old-pass', 4);
  let updated = false;
  prisma.user.findUnique = async () => ({ ...USER, passwordHash });
  prisma.user.update = async () => {
    updated = true;
  };
  try {
    await assert.rejects(service.changePassword(USER.id, 'wrong', 'new-password'), {
      status: 401,
      code: ERROR_CODES.INVALID_CREDENTIALS,
    });
    assert.equal(updated, false);
  } finally {
    restoreAll();
  }
});
