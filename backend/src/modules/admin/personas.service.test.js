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
const service = require('./personas.service');
const { DEFAULT_PERSONAS } = require('../../ai/prompts/defaults');

/* -------------------------------------------------------------------------- */
/* Mock helpers -- direct require() + reassignment, restored in `finally`,    */
/* same style as chat.service.test.js.                                        */
/* -------------------------------------------------------------------------- */

const originals = {
  agentPersonaFindMany: prisma.agentPersona.findMany,
  agentPersonaUpsert: prisma.agentPersona.upsert,
};

function restoreAll() {
  prisma.agentPersona.findMany = originals.agentPersonaFindMany;
  prisma.agentPersona.upsert = originals.agentPersonaUpsert;
}

const USER_ID = 'admin-1';

/* -------------------------------------------------------------------------- */
/* upsertPersona                                                              */
/* -------------------------------------------------------------------------- */

test('upsertPersona: computes modeKey as the bare mode for CLOUDOPS (no subMode)', async () => {
  let capturedArgs;
  prisma.agentPersona.upsert = async (args) => {
    capturedArgs = args;
    return { modeKey: 'CLOUDOPS', ...args.update };
  };

  try {
    await service.upsertPersona(USER_ID, {
      mode: 'CLOUDOPS',
      systemPrompt: 'you are an cloudops agent',
      allowedBinaries: ['aws'],
    });

    assert.deepEqual(capturedArgs.where, { modeKey: 'CLOUDOPS' });
  } finally {
    restoreAll();
  }
});

test('upsertPersona: computes modeKey as MODE_SUBMODE for a FinOps sub-mode', async () => {
  let capturedArgs;
  prisma.agentPersona.upsert = async (args) => {
    capturedArgs = args;
    return { modeKey: 'FINOPS_COST_ANALYTICS', ...args.update };
  };

  try {
    await service.upsertPersona(USER_ID, {
      mode: 'FINOPS',
      subMode: 'COST_ANALYTICS',
      systemPrompt: 'you are a finops cost analytics agent',
      allowedBinaries: ['aws', 'jq'],
    });

    assert.deepEqual(capturedArgs.where, { modeKey: 'FINOPS_COST_ANALYTICS' });
  } finally {
    restoreAll();
  }
});

test('upsertPersona: uses Prisma upsert with where/update/create shaped for the unique modeKey', async () => {
  let capturedArgs;
  prisma.agentPersona.upsert = async (args) => {
    capturedArgs = args;
    return { modeKey: 'CLOUDOPS', ...args.update };
  };

  try {
    await service.upsertPersona(USER_ID, {
      mode: 'CLOUDOPS',
      systemPrompt: 'prompt text',
      allowedBinaries: ['aws'],
      mutatingCommandCap: 5,
      docLookupAllowed: false,
    });

    assert.deepEqual(Object.keys(capturedArgs).sort(), ['create', 'update', 'where']);
    assert.equal(capturedArgs.create.modeKey, 'CLOUDOPS');
    assert.equal(capturedArgs.update.updatedByUserId, USER_ID);
    assert.equal(capturedArgs.create.updatedByUserId, USER_ID);
  } finally {
    restoreAll();
  }
});

test('upsertPersona: omitting mutatingCommandCap/docLookupAllowed resets them to null/true in the update branch', async () => {
  let capturedArgs;
  prisma.agentPersona.upsert = async (args) => {
    capturedArgs = args;
    return { modeKey: 'CLOUDOPS', ...args.update };
  };

  try {
    await service.upsertPersona(USER_ID, {
      mode: 'CLOUDOPS',
      systemPrompt: 'prompt text',
      allowedBinaries: ['aws'],
      // mutatingCommandCap and docLookupAllowed intentionally omitted
    });

    assert.equal(capturedArgs.update.mutatingCommandCap, null);
    assert.equal(capturedArgs.update.docLookupAllowed, true);
  } finally {
    restoreAll();
  }
});

test('upsertPersona: omitting mutatingCommandCap/docLookupAllowed resets them to null/true in the create branch', async () => {
  let capturedArgs;
  prisma.agentPersona.upsert = async (args) => {
    capturedArgs = args;
    return { modeKey: 'CLOUDOPS', ...args.create };
  };

  try {
    await service.upsertPersona(USER_ID, {
      mode: 'CLOUDOPS',
      systemPrompt: 'prompt text',
      allowedBinaries: ['aws'],
    });

    assert.equal(capturedArgs.create.mutatingCommandCap, null);
    assert.equal(capturedArgs.create.docLookupAllowed, true);
  } finally {
    restoreAll();
  }
});

test('upsertPersona: providing mutatingCommandCap/docLookupAllowed passes them through unchanged (both branches)', async () => {
  let capturedArgs;
  prisma.agentPersona.upsert = async (args) => {
    capturedArgs = args;
    return { modeKey: 'FINOPS_TAG_COMPLIANCE', ...args.update };
  };

  try {
    await service.upsertPersona(USER_ID, {
      mode: 'FINOPS',
      subMode: 'TAG_COMPLIANCE',
      systemPrompt: 'prompt text',
      allowedBinaries: ['aws'],
      mutatingCommandCap: 42,
      docLookupAllowed: false,
    });

    assert.equal(capturedArgs.update.mutatingCommandCap, 42);
    assert.equal(capturedArgs.update.docLookupAllowed, false);
    assert.equal(capturedArgs.create.mutatingCommandCap, 42);
    assert.equal(capturedArgs.create.docLookupAllowed, false);
  } finally {
    restoreAll();
  }
});

/* -------------------------------------------------------------------------- */
/* listPersonas                                                              */
/* -------------------------------------------------------------------------- */

test('listPersonas: a stored row overrides the default prompt and keeps its own settings', async () => {
  prisma.agentPersona.findMany = async () => [
    {
      mode: 'CLOUDOPS',
      subMode: null,
      modeKey: 'CLOUDOPS',
      systemPrompt: 'edited prompt',
      allowedBinaries: ['aws'],
      mutatingCommandCap: 7,
      docLookupAllowed: false,
    },
  ];

  try {
    const result = await service.listPersonas();
    const cloudOps = result.find((p) => p.modeKey === 'CLOUDOPS');
    const fallback = DEFAULT_PERSONAS.find((p) => p.modeKey === 'CLOUDOPS');

    assert.equal(cloudOps.systemPrompt, 'edited prompt');
    assert.deepEqual(cloudOps.allowedBinaries, ['aws']);
    assert.equal(cloudOps.mutatingCommandCap, 7);
    assert.equal(cloudOps.docLookupAllowed, false);
    assert.equal(cloudOps.defaultSystemPrompt, fallback.systemPrompt);
  } finally {
    restoreAll();
  }
});

test('listPersonas: a mode with no stored row is returned with its default', async () => {
  prisma.agentPersona.findMany = async () => [];

  try {
    const result = await service.listPersonas();
    const fallback = DEFAULT_PERSONAS.find((p) => p.modeKey === 'FINOPS_COST_ANALYTICS');
    const persona = result.find((p) => p.modeKey === 'FINOPS_COST_ANALYTICS');

    assert.equal(persona.mode, 'FINOPS');
    assert.equal(persona.subMode, 'COST_ANALYTICS');
    assert.equal(persona.systemPrompt, fallback.systemPrompt);
    assert.equal(persona.defaultSystemPrompt, fallback.systemPrompt);
    assert.deepEqual(persona.allowedBinaries, fallback.allowedBinaries);
    assert.equal(persona.mutatingCommandCap, null);
    assert.equal(persona.docLookupAllowed, true);
  } finally {
    restoreAll();
  }
});

test('listPersonas: returns every default persona, in the defaults order', async () => {
  prisma.agentPersona.findMany = async () => [
    { mode: 'FINOPS', subMode: 'WASTE_MANAGEMENT', modeKey: 'FINOPS_WASTE_MANAGEMENT', systemPrompt: 'x' },
  ];

  try {
    const result = await service.listPersonas();

    assert.deepEqual(
      result.map((p) => p.modeKey),
      DEFAULT_PERSONAS.map((p) => p.modeKey),
    );
    assert.ok(result.every((p) => typeof p.defaultSystemPrompt === 'string'));
  } finally {
    restoreAll();
  }
});
