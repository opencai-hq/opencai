const express = require('express');
const { validate } = require('../../middleware/validate');
const controller = require('./organisations.controller');
const {
  createOrganisationSchema,
  updateOrganisationSchema,
  createWorkspaceSchema,
  updateWorkspaceSchema,
} = require('./organisations.schemas');

const router = express.Router();

router.get('/', controller.list);
router.post('/', validate(createOrganisationSchema), controller.create);
router.get('/:id', controller.getOne);
router.patch('/:id', validate(updateOrganisationSchema), controller.update);

router.post('/:id/workspaces', validate(createWorkspaceSchema), controller.createWorkspace);
router.patch(
  '/:id/workspaces/:workspaceId',
  validate(updateWorkspaceSchema),
  controller.updateWorkspace,
);
router.delete('/:id/workspaces/:workspaceId', controller.deleteWorkspace);
// No route-level schema: the credential fields depend on the Workspace's CSP,
// so the service validates them once it has loaded the Workspace.
router.put('/:id/workspaces/:workspaceId/credential', controller.setWorkspaceCredential);

module.exports = router;
