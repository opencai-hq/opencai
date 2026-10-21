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

const jwt = require('jsonwebtoken');
const prisma = require('../config/db');
const { requireAuth, requireAuthAllowingPasswordChange } = require('./auth');
const { ERROR_CODES } = require('../constants/errors');

const originalFindUnique = prisma.user.findUnique;

const USER = {
  id: 'u-1',
  username: 'ann',
  role: 'OPERATOR',
  isActive: true,
  sessionVersion: 0,
  mustChangePassword: false,
};

function tokenFor(payload) {
  return jwt.sign(
    { sub: USER.id, username: USER.username, role: USER.role, ...payload },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// Runs the middleware and resolves with { err, req } once it calls next().
function run(middleware, token, user) {
  prisma.user.findUnique = async () => user;
  const req = { headers: { authorization: `Bearer ${token}` } };
  return new Promise((resolve) => {
    middleware(req, {}, (err) => resolve({ err, req }));
  }).finally(() => {
    prisma.user.findUnique = originalFindUnique;
  });
}

test('requireAuth: accepts a token whose sv matches', async () => {
  const { err, req } = await run(requireAuth, tokenFor({ sv: 2 }), { ...USER, sessionVersion: 2 });
  assert.equal(err, undefined);
  assert.deepEqual(req.user, { id: USER.id, username: USER.username, role: USER.role });
});

test('requireAuth: accepts a token without sv when sessionVersion is 0', async () => {
  const { err } = await run(requireAuth, tokenFor({}), USER);
  assert.equal(err, undefined);
});

test('requireAuth: rejects a token whose sv is stale', async () => {
  const { err } = await run(requireAuth, tokenFor({ sv: 0 }), { ...USER, sessionVersion: 1 });
  assert.equal(err.status, 401);
  assert.equal(err.code, ERROR_CODES.UNAUTHENTICATED);
});

test('requireAuth: rejects a deactivated or deleted user', async () => {
  const inactive = await run(requireAuth, tokenFor({ sv: 0 }), { ...USER, isActive: false });
  assert.equal(inactive.err.status, 401);
  const deleted = await run(requireAuth, tokenFor({ sv: 0 }), null);
  assert.equal(deleted.err.status, 401);
});

test('requireAuth: blocks a user who must change password', async () => {
  const { err } = await run(requireAuth, tokenFor({ sv: 0 }), {
    ...USER,
    mustChangePassword: true,
  });
  assert.equal(err.status, 403);
  assert.equal(err.code, ERROR_CODES.PASSWORD_CHANGE_REQUIRED);
});

test('requireAuthAllowingPasswordChange: lets that user through', async () => {
  const { err } = await run(requireAuthAllowingPasswordChange, tokenFor({ sv: 0 }), {
    ...USER,
    mustChangePassword: true,
  });
  assert.equal(err, undefined);
});
