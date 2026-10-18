const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function inject(request, exports) {
  const resolved = require.resolve(request);
  require.cache[resolved] = new Module(resolved, null);
  require.cache[resolved].filename = resolved;
  require.cache[resolved].loaded = true;
  require.cache[resolved].exports = exports;
}

const S = {};

function reset() {
  S.workspace = {
    id: 'ws-1',
    organisationId: 'org-1',
    csp: 'AWS',
    isActive: true,
    credential: {
      encryptedCredentials: 'enc',
      updatedAt: new Date('2026-03-01T00:00:00Z'),
    },
  };
  S.member = true;
  S.workspaceArgs = null;
  S.accessWhere = null;
}

inject('../config/db', {
  workspace: {
    async findUnique(args) {
      S.workspaceArgs = args;
      if (!S.workspace) return null;
      return args.include.credential ? S.workspace : { ...S.workspace, credential: undefined };
    },
  },
  userOrganisation: {
    async findUnique({ where }) {
      S.accessWhere = where;
      return S.member ? { id: 'uo-1' } : null;
    },
  },
});
inject('../crypto/envelope', {
  decrypt: (value) => JSON.stringify({ accessKeyId: 'AKIATEST', from: value }),
});

const { loadWorkspaceForOperator } = require('./workspaceAccess');
const { ERROR_CODES } = require('../constants/errors');

const fails = (status, code) => (err) => err.status === status && err.code === code;

test('returns the workspace, the decrypted credential and when it last changed', async () => {
  reset();

  const access = await loadWorkspaceForOperator('user-1', 'ws-1');

  assert.equal(access.workspace.id, 'ws-1');
  assert.ok(
    !('credential' in access.workspace),
    'the encrypted row does not travel with the workspace',
  );
  assert.deepEqual(access.credential, { accessKeyId: 'AKIATEST', from: 'enc' });
  assert.deepEqual(access.credentialUpdatedAt, new Date('2026-03-01T00:00:00Z'));
  assert.deepEqual(S.accessWhere, {
    userId_organisationId: { userId: 'user-1', organisationId: 'org-1' },
  });
});

test('withCredential: false checks access without loading the credential', async () => {
  reset();

  const access = await loadWorkspaceForOperator('user-1', 'ws-1', { withCredential: false });

  assert.deepEqual(Object.keys(access), ['workspace']);
  assert.equal(S.workspaceArgs.include.credential, false);
});

test('404 for a Workspace that does not exist', async () => {
  reset();
  S.workspace = null;
  await assert.rejects(
    loadWorkspaceForOperator('user-1', 'nope'),
    fails(404, ERROR_CODES.NOT_FOUND),
  );
});

test('403 when the Operator is not assigned to the Organisation', async () => {
  reset();
  S.member = false;
  await assert.rejects(
    loadWorkspaceForOperator('user-1', 'ws-1'),
    fails(403, ERROR_CODES.FORBIDDEN),
  );
});

test('403 when the Workspace has been deactivated', async () => {
  reset();
  S.workspace.isActive = false;
  await assert.rejects(
    loadWorkspaceForOperator('user-1', 'ws-1'),
    fails(403, ERROR_CODES.WORKSPACE_INACTIVE),
  );
});

test('422 when the Workspace has no credential', async () => {
  reset();
  S.workspace.credential = null;
  await assert.rejects(
    loadWorkspaceForOperator('user-1', 'ws-1'),
    fails(422, ERROR_CODES.WORKSPACE_CREDENTIAL_MISSING),
  );
});
