const express = require('express');
const { validate } = require('../../middleware/validate');
const controller = require('./administrators.controller');
const {
  createAdministratorSchema,
  updateAdministratorSchema,
} = require('./administrators.schemas');

const router = express.Router();

router.get('/', controller.list);
router.post('/', validate(createAdministratorSchema), controller.create);
router.patch('/:id', validate(updateAdministratorSchema), controller.update);
router.delete('/:id', controller.remove);
router.post('/:id/reset-mfa', controller.resetMfa);
router.post('/:id/reset-password', controller.resetPassword);

module.exports = router;
