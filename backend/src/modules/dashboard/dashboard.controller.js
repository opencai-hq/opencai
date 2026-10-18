const service = require('./dashboard.service');
const { AppError } = require('../../middleware/errorHandler');
const { ERROR_CODES } = require('../../constants/errors');
const { listWidgetsSchema } = require('./dashboard.schemas');

async function list(req, res, next) {
  try {
    const query = listWidgetsSchema.safeParse(req.query);
    if (!query.success) {
      throw new AppError(
        400,
        ERROR_CODES.VALIDATION_ERROR,
        query.error.issues.map((i) => i.message).join('; '),
      );
    }
    res.json(await service.listWidgets(req.user.id, query.data));
  } catch (err) {
    next(err);
  }
}

async function preview(req, res, next) {
  try {
    res.json(await service.previewWidget(req.user.id, req.body));
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    res.status(201).json(await service.createWidget(req.user.id, req.body));
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    res.json(await service.updateWidget(req.user.id, req.params.id, req.body));
  } catch (err) {
    next(err);
  }
}

async function refresh(req, res, next) {
  try {
    res.json(await service.refreshWidget(req.user.id, req.params.id));
  } catch (err) {
    next(err);
  }
}

async function redraw(req, res, next) {
  try {
    res.json(await service.redrawWidget(req.user.id, req.params.id));
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await service.deleteWidget(req.user.id, req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

module.exports = { list, preview, create, update, refresh, redraw, remove };
