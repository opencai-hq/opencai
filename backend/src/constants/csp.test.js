const test = require('node:test');
const assert = require('node:assert/strict');
const { CSP, ON_PREM_CSPS, isOnPrem } = require('./csp');

test('isOnPrem is true for on-prem providers', () => {
  for (const c of ['VSPHERE', 'SSH', 'KUBERNETES']) assert.equal(isOnPrem(c), true);
  assert.equal(ON_PREM_CSPS.size, 3);
});

test('isOnPrem is false for clouds and unknown values', () => {
  assert.equal(isOnPrem('AWS'), false);
  assert.equal(isOnPrem('nope'), false);
});

test('CSP keys', () => {
  assert.deepEqual(Object.keys(CSP), ['AWS', 'AZURE', 'GCP', 'VSPHERE', 'SSH', 'KUBERNETES']);
});
