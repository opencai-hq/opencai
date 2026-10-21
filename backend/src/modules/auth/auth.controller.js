const authService = require('./auth.service');
const passwordResetService = require('./passwordReset.service');

async function login(req, res, next) {
  try {
    const { username, password } = req.body;
    const result = await authService.login(username, password);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

async function startEnrollment(req, res, next) {
  try {
    const { mfaToken } = req.body;
    const result = await authService.startEnrollment(mfaToken);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

async function confirmEnrollment(req, res, next) {
  try {
    const { enrollmentToken, code } = req.body;
    const result = await authService.confirmEnrollment(enrollmentToken, code);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

async function verifyMfa(req, res, next) {
  try {
    const { mfaToken, code } = req.body;
    const result = await authService.verifyMfa(mfaToken, code);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body;
    const { token } = await authService.changePassword(req.user.id, currentPassword, newPassword);
    res.status(200).json({ success: true, token });
  } catch (err) {
    next(err);
  }
}

async function passwordResetAvailable(req, res, next) {
  try {
    res.json({ available: await passwordResetService.isAvailable() });
  } catch (err) {
    next(err);
  }
}

// Always 202 with an empty body, whether or not the account exists.
async function requestPasswordReset(req, res, next) {
  try {
    await passwordResetService.requestReset(req.body.identifier);
    res.status(202).json({});
  } catch (err) {
    next(err);
  }
}

async function confirmPasswordReset(req, res, next) {
  try {
    const { token, newPassword } = req.body;
    await passwordResetService.confirmReset(token, newPassword);
    res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  login,
  startEnrollment,
  confirmEnrollment,
  verifyMfa,
  changePassword,
  passwordResetAvailable,
  requestPasswordReset,
  confirmPasswordReset,
};
