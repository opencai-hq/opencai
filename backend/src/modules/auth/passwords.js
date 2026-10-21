const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../../config/db');

const BCRYPT_COST = 12;

// 12 random bytes -> exactly 16 base64url characters.
function generateTemporaryPassword() {
  return crypto.randomBytes(12).toString('base64url');
}

// The one place a password is replaced -- change, admin reset, CLI reset and
// email reset all come through here. Bumping sessionVersion signs the user
// out of every session issued before this call (see middleware/auth.js).
async function setUserPassword(userId, newPassword, { mustChangePassword }) {
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  return prisma.user.update({
    where: { id: userId },
    data: { passwordHash, mustChangePassword, sessionVersion: { increment: 1 } },
  });
}

/** Returns the plaintext once; only its hash is stored. */
async function issueTemporaryPassword(userId) {
  const temporaryPassword = generateTemporaryPassword();
  await setUserPassword(userId, temporaryPassword, { mustChangePassword: true });
  return temporaryPassword;
}

module.exports = {
  BCRYPT_COST,
  generateTemporaryPassword,
  setUserPassword,
  issueTemporaryPassword,
};
