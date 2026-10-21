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
const prisma = require('../../config/db');
const passwords = require('./passwords');

const originalUpdate = prisma.user.update;

test('generateTemporaryPassword: 16 base64url characters, different each call', () => {
  const a = passwords.generateTemporaryPassword();
  const b = passwords.generateTemporaryPassword();
  assert.match(a, /^[A-Za-z0-9_-]{16}$/);
  assert.notEqual(a, b);
});

test('issueTemporaryPassword: stores only a hash and forces a change', async () => {
  const calls = [];
  prisma.user.update = async (args) => {
    calls.push(args);
    return { id: 'u-1' };
  };
  try {
    const temporary = await passwords.issueTemporaryPassword('u-1');
    assert.equal(calls.length, 1);
    const { where, data } = calls[0];
    assert.deepEqual(where, { id: 'u-1' });
    assert.equal(data.mustChangePassword, true);
    assert.deepEqual(data.sessionVersion, { increment: 1 });
    assert.notEqual(data.passwordHash, temporary);
    assert.equal(await bcrypt.compare(temporary, data.passwordHash), true);
  } finally {
    prisma.user.update = originalUpdate;
  }
});
