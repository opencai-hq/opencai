const service = require('./administrators.service');

async function list(req, res, next) {
  try {
    res.json(await service.listAdministrators());
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const { username, password, email } = req.body;
    res.status(201).json(await service.createAdministrator(username, password, email));
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    res.json(await service.updateAdministrator(req.user, req.params.id, req.body));
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await service.deleteAdministrator(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

async function resetMfa(req, res, next) {
  try {
    await service.resetAdministratorMfa(req.user, req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    res.json(await service.resetAdministratorPassword(req.user, req.params.id));
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, update, remove, resetMfa, resetPassword };
