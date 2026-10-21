// Resets a user's password from the server's shell -- the recovery path for
// the master admin, who has no one above them to reset it from the app.
//
//   npm run reset-password -- <username> [--reset-mfa]
//   docker compose exec backend npm run reset-password -- admin
//
// Prints a temporary password; the user must choose a new one at their next
// sign-in. --reset-mfa also clears their authenticator so they enrol again.
const prisma = require('../src/config/db');
const { issueTemporaryPassword } = require('../src/modules/auth/passwords');
const { clearMfa } = require('../src/modules/admin/mfa');
const { AUDIT_ACTIONS, AUDIT_OUTCOMES } = require('../src/constants/auditActions');

const USAGE = 'Usage: npm run reset-password -- <username> [--reset-mfa]';

function parseArgs(argv) {
  const resetMfa = argv.includes('--reset-mfa');
  const [username] = argv.filter((arg) => !arg.startsWith('--'));
  if (!username) {
    throw new Error(USAGE);
  }
  return { username, resetMfa };
}

async function main(argv) {
  const { username, resetMfa } = parseArgs(argv);

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    throw new Error(`No user named ${username}.`);
  }

  const temporaryPassword = await issueTemporaryPassword(user.id);
  if (resetMfa) {
    await clearMfa(user.id);
  }
  await prisma.auditLog.create({
    data: {
      action: AUDIT_ACTIONS.PASSWORD_RESET_BY_CLI,
      outcome: AUDIT_OUTCOMES.SUCCESS,
      metadata: { targetUserId: user.id, resetMfa },
    },
  });

  console.log(`Temporary password for "${username}": ${temporaryPassword}`);
  console.log('They will be asked to choose a new password at their next sign-in.');
  if (resetMfa) {
    console.log('MFA was reset: they will set up their authenticator again.');
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = { parseArgs, main };
