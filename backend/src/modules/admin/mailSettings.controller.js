const service = require('./mailSettings.service');
const mailer = require('../../mail/mailer');
const { testEmail } = require('../../mail/templates');

async function get(req, res, next) {
  try {
    res.json(await service.getMailSettings());
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    res.json(await service.updateMailSettings(req.user, req.body));
  } catch (err) {
    next(err);
  }
}

// Sends with the saved settings even while mail is switched off, so they can
// be checked before users rely on them.
async function sendTest(req, res, next) {
  try {
    const settings = await service.getSavedMailSettings();
    await mailer.sendMail({ to: req.body.to, ...testEmail() }, settings || undefined);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

module.exports = { get, update, sendTest };
