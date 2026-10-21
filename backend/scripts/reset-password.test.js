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

const { parseArgs } = require('./reset-password');

test('parseArgs: reads username and --reset-mfa', () => {
  assert.deepEqual(parseArgs(['admin', '--reset-mfa']), { username: 'admin', resetMfa: true });
  assert.deepEqual(parseArgs(['ann']), { username: 'ann', resetMfa: false });
});

test('parseArgs: usage error without a username', () => {
  assert.throws(() => parseArgs([]), /Usage: npm run reset-password -- <username> \[--reset-mfa\]/);
  assert.throws(() => parseArgs(['--reset-mfa']), /Usage/);
});
