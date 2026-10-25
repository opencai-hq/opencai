const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');

process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.MASTER_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
process.env.TOTP_ISSUER_NAME ||= 'OpenCAI Test';
process.env.S3_ENDPOINT ||= 'http://localhost:9000';
process.env.S3_ACCESS_KEY ||= 'test';
process.env.S3_SECRET_KEY ||= 'test';
process.env.S3_BUCKET ||= 'test';

// The database and the two services are stubbed before socketServer.js loads
// them (same require.cache injection as orchestrator.test.js). The token
// check, the schemas and the WebSocket itself are the real ones.
function inject(request, exports) {
  const resolved = require.resolve(request);
  require.cache[resolved] = new Module(resolved, null);
  require.cache[resolved].filename = resolved;
  require.cache[resolved].loaded = true;
  require.cache[resolved].exports = exports;
}

const S = {};
function reset() {
  S.users = {
    'op-1': { id: 'op-1', username: 'ann', role: 'OPERATOR', isActive: true, sessionVersion: 0 },
    'admin-1': {
      id: 'admin-1',
      username: 'root',
      role: 'ADMIN',
      isActive: true,
      sessionVersion: 0,
    },
  };
  S.calls = [];
  S.gate = null;
}
reset();

inject('../config/db', {
  user: { findUnique: async ({ where }) => S.users[where.id] ?? null },
});
inject('../modules/chat/chat.service', {
  async sendMessage(userId, sessionId, text) {
    S.calls.push({ action: 'send', userId, sessionId, text });
    const { emitStatus, emitProgress } = require('./progress');
    emitStatus('Asking the AI');
    emitProgress({ kind: 'message', message: { id: 'm-1', content: 'hi' } });
    if (S.gate) await S.gate;
    if (text === 'boom') {
      const { AppError } = require('../middleware/errorHandler');
      throw new AppError(409, 'PENDING_COMMAND_EXISTS', 'A command is waiting.');
    }
    return { messages: [{ id: 'm-1', content: 'hi' }] };
  },
  async confirmPendingCommand(userId, sessionId, messageId) {
    S.calls.push({ action: 'confirm', userId, sessionId, messageId });
    return { messages: [] };
  },
  async cancelPendingCommand(userId, sessionId, messageId) {
    S.calls.push({ action: 'cancel', userId, sessionId, messageId });
    return { messages: [] };
  },
});
inject('../modules/dashboard/dashboard.service', {
  async previewWidget(userId, body) {
    S.calls.push({ action: 'preview', userId, body });
    return { draft: { title: 'T' } };
  },
  async createWidget() {
    return { id: 'w-1' };
  },
});

const jwt = require('jsonwebtoken');
const { WebSocket } = require('ws');
const { attachSocketServer, CLOSE, MAX_IN_FLIGHT } = require('./socketServer');

let server;
let wss;
let url;

before(async () => {
  server = http.createServer();
  wss = attachSocketServer(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `ws://127.0.0.1:${server.address().port}/api/ws`;
});

after(async () => {
  wss.close();
  await new Promise((resolve) => server.close(resolve));
});

const tokenFor = (sub, extra = {}) =>
  jwt.sign({ sub, sv: 0, ...extra }, process.env.JWT_SECRET, { expiresIn: '1h' });

/** A client that queues every frame it receives, and how it was closed. */
function connect() {
  const ws = new WebSocket(url);
  const frames = [];
  const waiters = [];
  ws.on('message', (raw) => {
    frames.push(JSON.parse(raw.toString()));
    waiters.splice(0).forEach((wake) => wake());
  });
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  async function next() {
    while (frames.length === 0) await new Promise((wake) => waiters.push(wake));
    return frames.shift();
  }
  const send = (frame) => ws.send(JSON.stringify(frame));
  return { ws, next, send, closed, opened };
}

async function signedIn(sub = 'op-1') {
  const client = connect();
  await client.opened;
  client.send({ type: 'auth', token: tokenFor(sub) });
  assert.equal((await client.next()).type, 'auth.ok');
  return client;
}

test('an Operator signs in and gets progress, then the result, tagged with the request id', async () => {
  reset();
  const client = await signedIn();

  client.send({
    id: 'r1',
    type: 'request',
    action: 'chat.send',
    payload: { sessionId: 's-1', text: 'hello' },
  });

  assert.deepEqual(await client.next(), {
    id: 'r1',
    type: 'progress',
    event: { kind: 'status', text: 'Asking the AI' },
  });
  assert.deepEqual(await client.next(), {
    id: 'r1',
    type: 'progress',
    event: { kind: 'message', message: { id: 'm-1', content: 'hi' } },
  });
  assert.deepEqual(await client.next(), {
    id: 'r1',
    type: 'result',
    data: { messages: [{ id: 'm-1', content: 'hi' }] },
  });
  assert.deepEqual(S.calls[0], { action: 'send', userId: 'op-1', sessionId: 's-1', text: 'hello' });
  client.ws.close();
});

test('every action reaches its service with the signed-in user', async () => {
  reset();
  const client = await signedIn();

  client.send({
    id: 'a',
    type: 'request',
    action: 'chat.confirm',
    payload: { sessionId: 's', messageId: 'm' },
  });
  assert.equal((await client.next()).type, 'result');
  client.send({
    id: 'b',
    type: 'request',
    action: 'chat.cancel',
    payload: { sessionId: 's', messageId: 'm' },
  });
  assert.equal((await client.next()).type, 'result');
  client.send({
    id: 'c',
    type: 'request',
    action: 'dashboard.preview',
    payload: { workspaceId: 'ws-1', mode: 'CLOUDOPS', query: 'volumes' },
  });
  assert.deepEqual(await client.next(), {
    id: 'c',
    type: 'result',
    data: { draft: { title: 'T' } },
  });

  assert.deepEqual(
    S.calls.map((c) => [c.action, c.userId]),
    [
      ['confirm', 'op-1'],
      ['cancel', 'op-1'],
      ['preview', 'op-1'],
    ],
  );
  client.ws.close();
});

test('a service error comes back with the same status, code and message as over HTTP', async () => {
  reset();
  const client = await signedIn();

  client.send({
    id: 'x',
    type: 'request',
    action: 'chat.send',
    payload: { sessionId: 's', text: 'boom' },
  });
  await client.next();
  await client.next();

  assert.deepEqual(await client.next(), {
    id: 'x',
    type: 'error',
    error: { status: 409, code: 'PENDING_COMMAND_EXISTS', message: 'A command is waiting.' },
  });
  client.ws.close();
});

test('an unknown action or an invalid payload is a 400, and nothing runs', async () => {
  reset();
  const client = await signedIn();

  client.send({ id: 'u', type: 'request', action: 'chat.delete', payload: {} });
  const unknown = await client.next();
  client.send({
    id: 'v',
    type: 'request',
    action: 'chat.send',
    payload: { sessionId: 's', text: '' },
  });
  const invalid = await client.next();

  assert.equal(unknown.error.status, 400);
  assert.match(unknown.error.message, /Unknown action/);
  assert.equal(invalid.error.status, 400);
  assert.equal(invalid.error.code, 'VALIDATION_ERROR');
  assert.equal(S.calls.length, 0);
  client.ws.close();
});

test('a bad, revoked or non-Operator token is refused and the socket closed', async () => {
  reset();
  for (const [token, code] of [
    ['not-a-jwt', CLOSE.UNAUTHENTICATED],
    [tokenFor('op-1', { sv: 3 }), CLOSE.UNAUTHENTICATED],
    [tokenFor('admin-1'), CLOSE.FORBIDDEN],
  ]) {
    const client = connect();
    await client.opened;
    client.send({ type: 'auth', token });
    assert.equal((await client.next()).type, 'auth.error');
    assert.equal(await client.closed, code);
  }
});

test('a request before signing in closes the socket', async () => {
  reset();
  const client = connect();
  await client.opened;

  client.send({ id: 'r', type: 'request', action: 'chat.send', payload: {} });

  assert.equal(await client.closed, CLOSE.UNAUTHENTICATED);
  assert.equal(S.calls.length, 0);
});

test('a session revoked after connecting fails its next request and ends the socket', async () => {
  reset();
  const client = await signedIn();
  S.users['op-1'] = { ...S.users['op-1'], sessionVersion: 1 };

  client.send({
    id: 'r',
    type: 'request',
    action: 'chat.send',
    payload: { sessionId: 's', text: 'hi' },
  });

  const reply = await client.next();
  assert.equal(reply.error.code, 'UNAUTHENTICATED');
  assert.equal(await client.closed, CLOSE.UNAUTHENTICATED);
  assert.equal(S.calls.length, 0);
});

test('a socket runs at most a few requests at once', async () => {
  reset();
  let release;
  S.gate = new Promise((resolve) => {
    release = resolve;
  });
  const client = await signedIn();

  for (let i = 0; i <= MAX_IN_FLIGHT; i += 1) {
    client.send({
      id: `r${i}`,
      type: 'request',
      action: 'chat.send',
      payload: { sessionId: 's', text: 'x' },
    });
  }
  const refused = [];
  // Each accepted request emits two progress frames before waiting on the gate.
  for (let i = 0; i < MAX_IN_FLIGHT * 2 + 1; i += 1) {
    const frame = await client.next();
    if (frame.type === 'error') refused.push(frame);
  }
  release();

  assert.equal(refused.length, 1);
  assert.equal(refused[0].error.status, 429);
  client.ws.close();
});

test('a frame that is not JSON closes the socket', async () => {
  reset();
  const client = await signedIn();

  client.ws.send('hello');

  assert.equal(await client.closed, CLOSE.BAD_FRAME);
});
