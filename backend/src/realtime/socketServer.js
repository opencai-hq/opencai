// The Operator's WebSocket: chat turns and graph building run over it, and
// every step they take is pushed to the browser as it happens (see
// progress.js). The HTTP routes for the same actions remain, and are what the
// browser falls back to when the socket cannot connect.
//
// Protocol, one JSON object per frame:
//   client -> { type: 'auth', token }                       first frame, within AUTH_TIMEOUT_MS
//   server -> { type: 'auth.ok', user } | { type: 'auth.error', error }
//   client -> { id, type: 'request', action, payload }
//   server -> { id, type: 'progress', event }               zero or more
//   server -> { id, type: 'result', data } | { id, type: 'error', error: { status, code, message } }
//
// A result is exactly what the matching HTTP route returns, and an error has
// the HTTP error's shape. The session token is checked again for every
// request, so signing out or a password change elsewhere stops the socket at
// its next request, as it would over HTTP.

const { WebSocketServer, WebSocket } = require('ws');
const { z } = require('zod');
const config = require('../config/env');
const { AppError, toErrorBody } = require('../middleware/errorHandler');
const { verifySessionToken } = require('../middleware/auth');
const { ERROR_CODES } = require('../constants/errors');
const { ROLES } = require('../constants/roles');
const { withProgress } = require('./progress');
const chatService = require('../modules/chat/chat.service');
const { sendMessageSchema } = require('../modules/chat/chat.schemas');
const dashboardService = require('../modules/dashboard/dashboard.service');
const {
  previewWidgetSchema,
  createWidgetSchema,
} = require('../modules/dashboard/dashboard.schemas');

const PATH = '/api/ws';
const MAX_FRAME_BYTES = 64 * 1024;
const AUTH_TIMEOUT_MS = 10 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const MAX_IN_FLIGHT = 4;
const MAX_ID_CHARS = 64;

// Close codes in the private range, so the browser can tell why it was closed.
const CLOSE = Object.freeze({ UNAUTHENTICATED: 4401, FORBIDDEN: 4403, BAD_FRAME: 4400 });

const pendingCommandSchema = z.object({
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
});

// action -> how its payload is checked, and the service call it makes.
const ACTIONS = {
  'chat.send': {
    schema: sendMessageSchema.extend({ sessionId: z.string().min(1) }),
    run: (userId, { sessionId, text }) => chatService.sendMessage(userId, sessionId, text),
  },
  'chat.confirm': {
    schema: pendingCommandSchema,
    run: (userId, { sessionId, messageId }) =>
      chatService.confirmPendingCommand(userId, sessionId, messageId),
  },
  'chat.cancel': {
    schema: pendingCommandSchema,
    run: (userId, { sessionId, messageId }) =>
      chatService.cancelPendingCommand(userId, sessionId, messageId),
  },
  'dashboard.preview': {
    schema: previewWidgetSchema,
    run: (userId, body) => dashboardService.previewWidget(userId, body),
  },
  'dashboard.create': {
    schema: createWidgetSchema,
    run: (userId, body) => dashboardService.createWidget(userId, body),
  },
};

/**
 * The same origins the HTTP API accepts (see app.js): the configured
 * CORS_ORIGIN, otherwise any origin in development and only the backend's own
 * host in production.
 */
function originAllowed(origin, host) {
  if (config.corsOrigin !== undefined) return origin === config.corsOrigin;
  if (config.nodeEnv !== 'production') return true;
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function operatorFor(token) {
  const user = await verifySessionToken(token);
  if (user.role !== ROLES.OPERATOR) throw new AppError(403, ERROR_CODES.FORBIDDEN);
  return user;
}

function closeCodeFor(status) {
  if (status === 401) return CLOSE.UNAUTHENTICATED;
  if (status === 403) return CLOSE.FORBIDDEN;
  return null;
}

function handleConnection(socket) {
  const state = { token: null, user: null, inFlight: 0, alive: true };

  const send = (frame) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };

  const authTimer = setTimeout(() => {
    if (!state.user) socket.close(CLOSE.UNAUTHENTICATED, 'No sign-in received');
  }, AUTH_TIMEOUT_MS);

  socket.on('pong', () => {
    state.alive = true;
  });
  socket.on('close', () => clearTimeout(authTimer));

  async function authenticate(token) {
    try {
      state.user = await operatorFor(typeof token === 'string' ? token : '');
      state.token = token;
      clearTimeout(authTimer);
      send({ type: 'auth.ok', user: { id: state.user.id, username: state.user.username } });
    } catch (err) {
      const { status, error } = toErrorBody(err);
      send({ type: 'auth.error', error: { status, ...error } });
      socket.close(closeCodeFor(status) ?? CLOSE.UNAUTHENTICATED, error.code);
    }
  }

  async function handleRequest({ id, action, payload }) {
    const reply = (frame) => send({ id, ...frame });
    const fail = (err) => {
      const { status, error } = toErrorBody(err);
      reply({ type: 'error', error: { status, ...error } });
      // Only a failed sign-in check ends the socket, not a 403 from a service.
      if (err.fromSessionCheck) socket.close(closeCodeFor(status) ?? CLOSE.UNAUTHENTICATED);
    };

    const handler = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
    if (!handler) {
      fail(new AppError(400, ERROR_CODES.VALIDATION_ERROR, `Unknown action "${action}".`));
      return;
    }
    if (state.inFlight >= MAX_IN_FLIGHT) {
      fail(
        new AppError(
          429,
          ERROR_CODES.RATE_LIMITED,
          'Too many requests are already running. Wait for one to finish.',
        ),
      );
      return;
    }

    state.inFlight += 1;
    try {
      let user;
      try {
        user = await operatorFor(state.token);
      } catch (err) {
        err.fromSessionCheck = true;
        throw err;
      }

      const parsed = handler.schema.safeParse(payload ?? {});
      if (!parsed.success) {
        throw new AppError(
          400,
          ERROR_CODES.VALIDATION_ERROR,
          parsed.error.issues.map((i) => i.message).join('; '),
        );
      }

      const data = await withProgress(
        (event) => reply({ type: 'progress', event }),
        () => handler.run(user.id, parsed.data),
      );
      reply({ type: 'result', data });
    } catch (err) {
      fail(err);
    } finally {
      state.inFlight -= 1;
    }
  }

  socket.on('message', (raw, isBinary) => {
    let frame;
    try {
      if (isBinary) throw new Error('binary');
      frame = JSON.parse(raw.toString('utf8'));
    } catch {
      socket.close(CLOSE.BAD_FRAME, 'Frames must be JSON text');
      return;
    }
    if (frame === null || typeof frame !== 'object') {
      socket.close(CLOSE.BAD_FRAME, 'Frames must be JSON objects');
      return;
    }

    if (!state.user) {
      if (frame.type === 'auth' && !state.authenticating) {
        state.authenticating = true;
        authenticate(frame.token);
      } else if (frame.type !== 'auth') {
        socket.close(CLOSE.UNAUTHENTICATED, 'Sign in first');
      }
      return;
    }

    if (
      frame.type !== 'request' ||
      typeof frame.id !== 'string' ||
      frame.id.length === 0 ||
      frame.id.length > MAX_ID_CHARS ||
      typeof frame.action !== 'string'
    ) {
      socket.close(CLOSE.BAD_FRAME, 'Malformed request');
      return;
    }
    handleRequest(frame);
  });

  return state;
}

/**
 * Serve the Operator WebSocket on `httpServer`, next to the Express app.
 *
 * @returns {WebSocketServer}
 */
function attachSocketServer(httpServer, { heartbeatMs = HEARTBEAT_MS } = {}) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: PATH,
    maxPayload: MAX_FRAME_BYTES,
    verifyClient: ({ origin, req }) => originAllowed(origin, req.headers.host),
  });
  const states = new Map();

  wss.on('connection', (socket) => {
    states.set(socket, handleConnection(socket));
    socket.on('close', () => states.delete(socket));
  });

  // A socket that missed a whole heartbeat is gone (a laptop closed, a proxy
  // dropped it); its work carries on and is saved, only the socket is closed.
  const heartbeat = setInterval(() => {
    for (const [socket, state] of states) {
      if (!state.alive) {
        socket.terminate();
        continue;
      }
      state.alive = false;
      socket.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

module.exports = { attachSocketServer, PATH, CLOSE, MAX_IN_FLIGHT };
