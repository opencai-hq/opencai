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
const service = require('./administrators.service');
const { ROLES } = require('../../constants/roles');
const { MASTER_ADMIN_USERNAME } = require('../../constants/admin');

/* -------------------------------------------------------------------------- */
/* Mock helpers -- direct require() + reassignment, restored in `finally`,    */
/* same style as personas.service.test.js.                                    */
/* -------------------------------------------------------------------------- */

const originals = {
  userFindUnique: prisma.user.findUnique,
  userFindMany: prisma.user.findMany,
  userUpdate: prisma.user.update,
};

function restoreAll() {
  prisma.user.findUnique = originals.userFindUnique;
  prisma.user.findMany = originals.userFindMany;
  prisma.user.update = originals.userUpdate;
}

const MASTER = { id: 'admin-0', username: MASTER_ADMIN_USERNAME };
const OTHER_ADMIN = { id: 'admin-2', username: 'second-admin' };

function mockTarget(role = ROLES.ADMIN) {
  const updates = [];
  prisma.user.findUnique = async ({ where }) => ({ id: where.id, role });
  prisma.user.update = async (args) => {
    updates.push(args);
  };
  return updates;
}

test('resetAdministratorMfa: the master admin can reset another admin', async () => {
  const updates = mockTarget();
  try {
    await service.resetAdministratorMfa(MASTER, OTHER_ADMIN.id);
    assert.deepEqual(updates, [
      {
        where: { id: OTHER_ADMIN.id },
        data: { totpSecretEncrypted: null, backupCodesHashed: [] },
      },
    ]);
  } finally {
    restoreAll();
  }
});

test('resetAdministratorMfa: the master admin can reset their own MFA', async () => {
  const updates = mockTarget();
  try {
    await service.resetAdministratorMfa(MASTER, MASTER.id);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].where.id, MASTER.id);
  } finally {
    restoreAll();
  }
});

test('resetAdministratorMfa: 403 for any other admin, even on themselves', async () => {
  const updates = mockTarget();
  try {
    for (const target of [MASTER.id, OTHER_ADMIN.id]) {
      await assert.rejects(service.resetAdministratorMfa(OTHER_ADMIN, target), { status: 403 });
    }
    assert.deepEqual(updates, []);
  } finally {
    restoreAll();
  }
});

test('resetAdministratorMfa: 404 when the target is not an admin', async () => {
  const updates = mockTarget(ROLES.OPERATOR);
  try {
    await assert.rejects(service.resetAdministratorMfa(MASTER, 'op-1'), { status: 404 });
    assert.deepEqual(updates, []);
  } finally {
    restoreAll();
  }
});

test('listAdministrators: reports mfaEnrolled and never returns the secret', async () => {
  prisma.user.findMany = async () => [
    { id: 'a', username: MASTER_ADMIN_USERNAME, totpSecretEncrypted: 'enc' },
    { id: 'b', username: 'x', totpSecretEncrypted: null },
  ];
  try {
    const admins = await service.listAdministrators();
    assert.deepEqual(
      admins.map((a) => [a.mfaEnrolled, a.isMasterAdmin, 'totpSecretEncrypted' in a]),
      [
        [true, true, false],
        [false, false, false],
      ],
    );
  } finally {
    restoreAll();
  }
});

/* -------------------------------------------------------------------------- */
/* resetAdministratorPassword                                                 */
/* -------------------------------------------------------------------------- */

function mockPasswordReset(role = ROLES.ADMIN) {
  const updates = mockTarget(role);
  const audits = [];
  const originalAudit = prisma.auditLog.create;
  prisma.auditLog.create = async (args) => {
    audits.push(args.data);
  };
  return { updates, audits, restore: () => (prisma.auditLog.create = originalAudit) };
}

test('resetAdministratorPassword: master admin resets another admin', async () => {
  const { updates, audits, restore } = mockPasswordReset();
  try {
    const { temporaryPassword } = await service.resetAdministratorPassword(MASTER, OTHER_ADMIN.id);
    assert.match(temporaryPassword, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(updates[0].data.mustChangePassword, true);
    assert.equal(audits[0].action, 'PASSWORD_RESET_BY_ADMIN');
    assert.equal(audits[0].actorUserId, MASTER.id);
    assert.deepEqual(audits[0].metadata, { targetUserId: OTHER_ADMIN.id });
  } finally {
    restore();
    restoreAll();
  }
});

test('resetAdministratorPassword: 403 for a non-master actor', async () => {
  const { updates, restore } = mockPasswordReset();
  try {
    await assert.rejects(service.resetAdministratorPassword(OTHER_ADMIN, 'admin-3'), {
      status: 403,
    });
    assert.deepEqual(updates, []);
  } finally {
    restore();
    restoreAll();
  }
});

test('resetAdministratorPassword: 400 for own account', async () => {
  const { updates, restore } = mockPasswordReset();
  try {
    await assert.rejects(service.resetAdministratorPassword(MASTER, MASTER.id), {
      status: 400,
      message: 'Use Change Password for your own account.',
    });
    assert.deepEqual(updates, []);
  } finally {
    restore();
    restoreAll();
  }
});

test('resetAdministratorPassword: 404 for an Operator id', async () => {
  const { updates, restore } = mockPasswordReset(ROLES.OPERATOR);
  try {
    await assert.rejects(service.resetAdministratorPassword(MASTER, 'op-1'), { status: 404 });
    assert.deepEqual(updates, []);
  } finally {
    restore();
    restoreAll();
  }
});

/* -------------------------------------------------------------------------- */
/* updateAdministrator                                                        */
/* -------------------------------------------------------------------------- */

test('updateAdministrator: 403 for a non-master actor', async () => {
  const updates = mockTarget();
  try {
    await assert.rejects(
      service.updateAdministrator(OTHER_ADMIN, 'admin-3', { email: 'x@example.com' }),
      { status: 403 },
    );
    assert.deepEqual(updates, []);
  } finally {
    restoreAll();
  }
});

test('updateAdministrator: master admin sets an email', async () => {
  const updates = [];
  prisma.user.findUnique = async ({ where }) =>
    where.id ? { id: where.id, role: ROLES.ADMIN } : null;
  prisma.user.update = async (args) => {
    updates.push(args);
    return {
      id: OTHER_ADMIN.id,
      username: OTHER_ADMIN.username,
      isActive: true,
      createdAt: new Date(0),
      totpSecretEncrypted: null,
      email: args.data.email,
    };
  };
  try {
    const result = await service.updateAdministrator(MASTER, OTHER_ADMIN.id, {
      email: 'second@example.com',
    });
    assert.equal(updates[0].data.email, 'second@example.com');
    assert.equal(result.email, 'second@example.com');
  } finally {
    restoreAll();
  }
});
