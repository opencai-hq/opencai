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

const app = require('../app');

test('loginLimiter: the 21st sign-in attempt in the window is refused', async () => {
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/auth/login`;
    const attempt = () =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

    // An empty body fails validation (400) before the database is touched.
    for (let i = 0; i < 20; i += 1) {
      assert.equal((await attempt()).status, 400);
    }
    const refused = await attempt();
    assert.equal(refused.status, 429);
    assert.equal((await refused.json()).error.code, 'RATE_LIMITED');
  } finally {
    server.close();
  }
});
