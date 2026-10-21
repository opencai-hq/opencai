const prisma = require('../../config/db');
const { AppError } = require('../../middleware/errorHandler');
const { ERROR_CODES } = require('../../constants/errors');

// Emails are unique across all users; a clear 409 beats the database's
// unique-constraint error. `userId` is the user being edited, if any.
async function assertEmailAvailable(email, userId) {
  if (!email) return;
  const owner = await prisma.user.findUnique({ where: { email } });
  if (owner && owner.id !== userId) {
    throw new AppError(409, ERROR_CODES.VALIDATION_ERROR, 'That email is already in use.');
  }
}

module.exports = { assertEmailAvailable };
