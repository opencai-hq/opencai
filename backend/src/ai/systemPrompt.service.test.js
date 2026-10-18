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

const db = require('../config/db');
const { AGENT_PREAMBLE } = require('./prompts/preamble');
const { DEFAULT_PERSONAS } = require('./prompts/defaults');
const { getPersona, allowedBinariesForMode } = require('./systemPrompt.service');

const originalFindUnique = db.agentPersona.findUnique;

function mockFindUnique(impl) {
  db.agentPersona.findUnique = impl;
}

function restoreFindUnique() {
  db.agentPersona.findUnique = originalFindUnique;
}

test('DB row found: systemPrompt is preamble + row text, other fields pass through unchanged', async () => {
  const row = {
    modeKey: 'CLOUDOPS',
    systemPrompt: 'Custom admin-edited persona text.',
    allowedBinaries: ['aws', 'kubectl'],
    mutatingCommandCap: 3,
    docLookupAllowed: false,
  };
  mockFindUnique(async () => row);

  try {
    const result = await getPersona('CLOUDOPS', null);

    assert.ok(result.systemPrompt.startsWith(AGENT_PREAMBLE));
    assert.equal(result.systemPrompt, `${AGENT_PREAMBLE}\n\n${row.systemPrompt}`);
    assert.deepEqual(result.allowedBinaries, row.allowedBinaries);
    assert.equal(result.mutatingCommandCap, row.mutatingCommandCap);
    assert.equal(result.docLookupAllowed, row.docLookupAllowed);
  } finally {
    restoreFindUnique();
  }
});

test('no DB row: falls back to DEFAULT_PERSONAS, mutatingCommandCap null, docLookupAllowed true, and warns', async () => {
  mockFindUnique(async () => null);

  const originalWarn = console.warn;
  let warnCalls = [];
  console.warn = (...args) => {
    warnCalls.push(args);
  };

  try {
    const result = await getPersona('FINOPS', 'COST_ANALYTICS');
    const fallback = DEFAULT_PERSONAS.find((p) => p.modeKey === 'FINOPS_COST_ANALYTICS');

    assert.equal(result.systemPrompt, `${AGENT_PREAMBLE}\n\n${fallback.systemPrompt}`);
    assert.deepEqual(result.allowedBinaries, fallback.allowedBinaries);
    assert.equal(result.mutatingCommandCap, null);
    assert.equal(result.docLookupAllowed, true);
    assert.equal(warnCalls.length, 1);
    assert.match(warnCalls[0][0], /No AgentPersona row for modeKey "FINOPS_COST_ANALYTICS"/);
  } finally {
    console.warn = originalWarn;
    restoreFindUnique();
  }
});

test('modeKey computation: CLOUDOPS with null subMode and with undefined subMode both resolve to "CLOUDOPS"', async () => {
  let capturedWhere;
  mockFindUnique(async (args) => {
    capturedWhere = args.where;
    return null;
  });

  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    await getPersona('CLOUDOPS', null);
    assert.deepEqual(capturedWhere, { modeKey: 'CLOUDOPS' });

    await getPersona('CLOUDOPS', undefined);
    assert.deepEqual(capturedWhere, { modeKey: 'CLOUDOPS' });
  } finally {
    console.warn = originalWarn;
    restoreFindUnique();
  }
});

test('FinOps sub-mode: getPersona("FINOPS", "COST_ANALYTICS") looks up modeKey "FINOPS_COST_ANALYTICS"', async () => {
  const row = {
    modeKey: 'FINOPS_COST_ANALYTICS',
    systemPrompt: 'Cost analytics persona text.',
    allowedBinaries: ['aws'],
    mutatingCommandCap: 0,
    docLookupAllowed: true,
  };
  let capturedWhere;
  mockFindUnique(async (args) => {
    capturedWhere = args.where;
    return row;
  });

  try {
    const result = await getPersona('FINOPS', 'COST_ANALYTICS');
    assert.deepEqual(capturedWhere, { modeKey: 'FINOPS_COST_ANALYTICS' });
    assert.equal(result.systemPrompt, `${AGENT_PREAMBLE}\n\n${row.systemPrompt}`);
  } finally {
    restoreFindUnique();
  }
});

test('unreachable modeKey: neither a DB row nor a DEFAULT_PERSONAS entry throws', async () => {
  mockFindUnique(async () => null);

  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    await assert.rejects(
      () => getPersona('CLOUDOPS', 'NOT_A_REAL_SUBMODE'),
      /No persona or default found for modeKey "CLOUDOPS_NOT_A_REAL_SUBMODE"/,
    );
  } finally {
    console.warn = originalWarn;
    restoreFindUnique();
  }
});

test('allowedBinariesForMode: unions the binaries of every persona of the mode', async () => {
  const originalFindMany = db.agentPersona.findMany;
  let capturedWhere;
  db.agentPersona.findMany = async (args) => {
    capturedWhere = args.where;
    return [{ allowedBinaries: ['aws'] }, { allowedBinaries: ['aws', 'az'] }];
  };

  try {
    assert.deepEqual(await allowedBinariesForMode('FINOPS'), ['aws', 'az']);
    assert.deepEqual(capturedWhere, { mode: 'FINOPS' });
  } finally {
    db.agentPersona.findMany = originalFindMany;
  }
});

test('allowedBinariesForMode: falls back to the default personas of the mode', async () => {
  const originalFindMany = db.agentPersona.findMany;
  db.agentPersona.findMany = async () => [];

  try {
    const expected = [
      ...new Set(
        DEFAULT_PERSONAS.filter((p) => p.mode === 'FINOPS').flatMap((p) => p.allowedBinaries),
      ),
    ];
    assert.ok(expected.length > 0);
    assert.deepEqual(await allowedBinariesForMode('FINOPS'), expected);
    assert.deepEqual(await allowedBinariesForMode('NOT_A_MODE'), []);
  } finally {
    db.agentPersona.findMany = originalFindMany;
  }
});
