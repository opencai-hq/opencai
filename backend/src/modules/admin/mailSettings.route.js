const express = require('express');
const { validate } = require('../../middleware/validate');
const controller = require('./mailSettings.controller');
const { updateMailSettingsSchema, sendTestEmailSchema } = require('./mailSettings.schemas');

const router = express.Router();

router.get('/', controller.get);
router.put('/', validate(updateMailSettingsSchema), controller.update);
router.post('/test', validate(sendTestEmailSchema), controller.sendTest);

module.exports = router;
