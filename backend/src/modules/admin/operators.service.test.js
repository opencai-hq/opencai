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
const service = require('./operators.service');
const { ROLES } = require('../../constants/roles');
const { ERROR_CODES } = require('../../constants/errors');

/* -------------------------------------------------------------------------- */
/* Mock helpers -- direct require() + reassignment, restored in `finally`,    */
/* same style as personas.service.test.js.                                    */
/* -------------------------------------------------------------------------- */

const originals = {
  userFindUnique: prisma.user.findUnique,
  userDelete: prisma.user.delete,
  chatSessionCount: prisma.chatSession.count,
};

function restoreAll() {
  prisma.user.findUnique = originals.userFindUnique;
  prisma.user.delete = originals.userDelete;
  prisma.chatSession.count = originals.chatSessionCount;
}

const USER_ID = 'op-1';

function mockUser({ role = ROLES.OPERATOR, chats = 0 } = {}) {
  const deleted = [];
  prisma.user.findUnique = async () => ({ id: USER_ID, role });
  prisma.chatSession.count = async () => chats;
  prisma.user.delete = async (args) => {
    deleted.push(args.where.id);
  };
  return deleted;
}

test('deleteOperator: deletes an Operator with no chat sessions', async () => {
  const deleted = mockUser();
  try {
    await service.deleteOperator(USER_ID);
    assert.deepEqual(deleted, [USER_ID]);
  } finally {
    restoreAll();
  }
});

test('deleteOperator: refuses with 409 while chat sessions exist', async () => {
  const deleted = mockUser({ chats: 1 });
  try {
    await assert.rejects(service.deleteOperator(USER_ID), (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, ERROR_CODES.OPERATOR_HAS_CHATS);
      assert.match(err.message, /1 chat session and/);
      return true;
    });
    assert.deepEqual(deleted, []);
  } finally {
    restoreAll();
  }
});

test('deleteOperator: 404 for a user who is not an Operator', async () => {
  const deleted = mockUser({ role: ROLES.ADMIN });
  try {
    await assert.rejects(service.deleteOperator(USER_ID), { status: 404 });
    assert.deepEqual(deleted, []);
  } finally {
    restoreAll();
  }
});

test('resetOperatorMfa: clears the TOTP secret and backup codes', async () => {
  const originalUpdate = prisma.user.update;
  let capturedArgs;
  mockUser();
  prisma.user.update = async (args) => {
    capturedArgs = args;
  };
  try {
    await service.resetOperatorMfa(USER_ID);
    assert.deepEqual(capturedArgs, {
      where: { id: USER_ID },
      data: { totpSecretEncrypted: null, backupCodesHashed: [] },
    });
  } finally {
    prisma.user.update = originalUpdate;
    restoreAll();
  }
});

test('resetOperatorMfa: 404 for a user who is not an Operator', async () => {
  const originalUpdate = prisma.user.update;
  let updated = false;
  mockUser({ role: ROLES.ADMIN });
  prisma.user.update = async () => {
    updated = true;
  };
  try {
    await assert.rejects(service.resetOperatorMfa(USER_ID), { status: 404 });
    assert.equal(updated, false);
  } finally {
    prisma.user.update = originalUpdate;
    restoreAll();
  }
});

/* -------------------------------------------------------------------------- */
/* resetOperatorPassword                                                      */
/* -------------------------------------------------------------------------- */

const ADMIN_ACTOR = { id: 'admin-1', username: 'some-admin' };

function mockPasswordReset({ role = ROLES.OPERATOR } = {}) {
  const updates = [];
  const audits = [];
  const originalUpdate = prisma.user.update;
  const originalAudit = prisma.auditLog.create;
  prisma.user.findUnique = async () => ({ id: USER_ID, role });
  prisma.user.update = async (args) => {
    updates.push(args);
  };
  prisma.auditLog.create = async (args) => {
    audits.push(args.data);
  };
  return {
    updates,
    audits,
    restore: () => {
      prisma.user.update = originalUpdate;
      prisma.auditLog.create = originalAudit;
      restoreAll();
    },
  };
}

test('resetOperatorPassword: returns a temporary password and audits', async () => {
  const { updates, audits, restore } = mockPasswordReset();
  try {
    const { temporaryPassword } = await service.resetOperatorPassword(ADMIN_ACTOR, USER_ID);
    assert.equal(temporaryPassword.length, 16);
    assert.equal(updates[0].data.mustChangePassword, true);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'PASSWORD_RESET_BY_ADMIN');
    assert.equal(audits[0].actorUserId, ADMIN_ACTOR.id);
    assert.equal(audits[0].metadata.targetUserId, USER_ID);
  } finally {
    restore();
  }
});

test('resetOperatorPassword: 404 for a non-Operator', async () => {
  const { updates, restore } = mockPasswordReset({ role: ROLES.ADMIN });
  try {
    await assert.rejects(service.resetOperatorPassword(ADMIN_ACTOR, USER_ID), { status: 404 });
    assert.deepEqual(updates, []);
  } finally {
    restore();
  }
});
