const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getCsp } = require('./index');

const aws = getCsp('AWS');

test('getCsp throws for an unknown provider, including inherited property names', () => {
  assert.throws(() => getCsp('ORACLE'), { message: 'Unsupported CSP: ORACLE' });
  assert.throws(() => getCsp(undefined), /Unsupported CSP/);
  assert.throws(() => getCsp('aws'), { message: 'Unsupported CSP: aws' });
  assert.throws(() => getCsp('constructor'), /Unsupported CSP/);
});

test('maps an AWS credential payload onto AWS CLI env vars and nothing else', async () => {
  const env = await aws.buildEnv({
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret-value',
    sessionToken: 'not-in-the-data-model',
  });

  assert.deepEqual(env, {
    AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'secret-value',
  });
});

test('rejects a missing or incomplete AWS credential payload', async () => {
  await assert.rejects(() => aws.buildEnv(null), /Missing credential payload/);
  await assert.rejects(() => aws.buildEnv({ accessKeyId: 'a' }), {
    message: 'Incomplete AWS credential payload',
  });
});

test('the AWS credential schema requires both key fields', () => {
  const full = { accessKeyId: 'a', secretAccessKey: 'b' };
  assert.equal(aws.credentialSchema.safeParse(full).success, true);
  assert.equal(aws.credentialSchema.safeParse({ accessKeyId: 'a' }).success, false);
});
