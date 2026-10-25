const { ERROR_CODES, ERROR_MESSAGES } = require('../constants/errors');

class AppError extends Error {
  constructor(status, code, message) {
    super(message || ERROR_MESSAGES[code] || ERROR_MESSAGES[ERROR_CODES.INTERNAL_ERROR]);
    this.status = status;
    this.code = code;
  }
}

/**
 * What a client is told about an error: the AppError as it is, anything else
 * as a logged, generic 500. Shared by HTTP and the WebSocket.
 *
 * @returns {{ status: number, error: { code: string, message: string } }}
 */
function toErrorBody(err) {
  if (err instanceof AppError) {
    return { status: err.status, error: { code: err.code, message: err.message } };
  }

  console.error(err);
  return {
    status: 500,
    error: {
      code: ERROR_CODES.INTERNAL_ERROR,
      message: ERROR_MESSAGES[ERROR_CODES.INTERNAL_ERROR],
    },
  };
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const { status, error } = toErrorBody(err);
  return res.status(status).json({ error });
}

module.exports = { AppError, errorHandler, toErrorBody };
