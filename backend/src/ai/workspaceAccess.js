const prisma = require('../config/db');
const envelope = require('../crypto/envelope');
const { AppError } = require('../middleware/errorHandler');
const { ERROR_CODES } = require('../constants/errors');

/**
 * The Workspace an Operator is asking to act on, once it is confirmed they may:
 * it exists, is active, and belongs to an Organisation they are assigned to.
 * Checked on every call, so access removed by an Administrator takes effect at
 * once.
 *
 * With `withCredential`, also returns the decrypted credential and when it was
 * last changed.
 */
async function loadWorkspaceForOperator(userId, workspaceId, { withCredential = true } = {}) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: { credential: withCredential },
  });
  if (!workspace) throw new AppError(404, ERROR_CODES.NOT_FOUND);

  const access = await prisma.userOrganisation.findUnique({
    where: { userId_organisationId: { userId, organisationId: workspace.organisationId } },
  });
  if (!access) throw new AppError(403, ERROR_CODES.FORBIDDEN);
  if (!workspace.isActive) throw new AppError(403, ERROR_CODES.WORKSPACE_INACTIVE);

  if (!withCredential) return { workspace };

  if (!workspace.credential) throw new AppError(422, ERROR_CODES.WORKSPACE_CREDENTIAL_MISSING);
  const { credential: row, ...rest } = workspace;
  return {
    workspace: rest,
    credential: JSON.parse(envelope.decrypt(row.encryptedCredentials)),
    credentialUpdatedAt: row.updatedAt,
  };
}

module.exports = { loadWorkspaceForOperator };
