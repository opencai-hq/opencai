const express = require('express');
const { validate } = require('../../middleware/validate');
const controller = require('./dashboard.controller');
const {
  previewWidgetSchema,
  createWidgetSchema,
  updateWidgetSchema,
} = require('./dashboard.schemas');

const router = express.Router();

router.get('/widgets', controller.list);
router.post('/widgets/preview', validate(previewWidgetSchema), controller.preview);
router.post('/widgets', validate(createWidgetSchema), controller.create);
router.patch('/widgets/:id', validate(updateWidgetSchema), controller.update);
router.post('/widgets/:id/refresh', controller.refresh);
router.post('/widgets/:id/redraw', controller.redraw);
router.delete('/widgets/:id', controller.remove);

module.exports = router;
