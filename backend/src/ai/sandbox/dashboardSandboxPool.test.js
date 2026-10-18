const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Docker, container creation and the provider modules are stubbed before the
// pool loads them (same require.cache injection as sandboxManager.test.js).
function inject(request, exports) {
  const resolved = require.resolve(request);
  require.cache[resolved] = new Module(resolved, null);
  require.cache[resolved].filename = resolved;
  require.cache[resolved].loaded = true;
  require.cache[resolved].exports = exports;
}

const S = {};
let idCounter = 0;

function reset() {
  S.created = [];
  S.removed = [];
  S.running = new Set();
  S.listed = [];
  S.listFilters = null;
  S.signIns = [];
  S.signInError = null;
  S.createGate = null;
  S.buildEnvCalls = 0;
}

inject('./dockerClient', {
  docker: {
    getContainer(id) {
      return {
        async inspect() {
          if (!S.running.has(id)) throw new Error('no such container');
          return { State: { Running: true } };
        },
        async remove() {
          S.removed.push(id);
          S.running.delete(id);
        },
      };
    },
    async listContainers(options) {
      S.listFilters = options;
      return S.listed.map((Id) => ({ Id }));
    },
  },
});
inject('./sandboxManager', {
  async createSandboxContainer(options) {
    if (S.createGate) await S.createGate;
    idCounter += 1;
    const id = `cid-${idCounter}`;
    S.created.push({ id, ...options });
    S.running.add(id);
    return { id };
  },
  async executeInSandbox(containerId, argv, options) {
    return { containerId, argv, options, exitCode: 0, timedOut: false };
  },
});
inject('../csp', {
  getCsp(name) {
    return {
      sandboxImage: `image-${name}`,
      async buildEnv(credential) {
        S.buildEnvCalls += 1;
        return { TOKEN: credential.token };
      },
      ...(name === 'AZURE'
        ? {
            async prepareSandbox({ credential, exec }) {
              S.signIns.push(credential.token);
              if (S.signInError) throw S.signInError;
              await exec(['sh', '-c', 'login'], { SECRET: credential.token });
            },
          }
        : {}),
    };
  },
});

const pool = require('./dashboardSandboxPool');

const STAMP = new Date('2026-01-01T00:00:00Z');
let userCounter = 0;

// Each test uses its own Operator so pool state never crosses tests.
function target(over = {}) {
  userCounter += 1;
  return {
    userId: `user-${userCounter}`,
    workspace: { id: 'ws-1', csp: 'AZURE' },
    credential: { token: 't1' },
    credentialUpdatedAt: STAMP,
    timeoutSeconds: 60,
    ...over,
  };
}

test('acquire: creates a labelled container, signs it in, and returns the environment', async () => {
  reset();

  const { containerId, env } = await pool.acquire(target());

  assert.equal(S.created.length, 1);
  assert.equal(S.created[0].id, containerId);
  assert.equal(S.created[0].image, 'image-AZURE');
  assert.deepEqual(S.created[0].labels, { [pool.LABEL_KEY]: pool.LABEL_VALUE });
  assert.deepEqual(S.signIns, ['t1']);
  assert.deepEqual(env, { TOKEN: 't1' });
});

test('acquire: concurrent calls share one container and one sign-in', async () => {
  reset();
  let open;
  S.createGate = new Promise((resolve) => {
    open = resolve;
  });
  const t = target();

  const pending = [pool.acquire(t), pool.acquire(t), pool.acquire(t), pool.acquire(t)];
  open();
  const results = await Promise.all(pending);

  assert.equal(S.created.length, 1);
  assert.equal(S.signIns.length, 1);
  assert.equal(new Set(results.map((r) => r.containerId)).size, 1);
});

test('acquire: a later call reuses the container but builds the environment again', async () => {
  reset();
  const t = target();

  const first = await pool.acquire(t);
  const second = await pool.acquire({ ...t, credential: { token: 't1' } });

  assert.equal(second.containerId, first.containerId);
  assert.equal(S.created.length, 1);
  assert.equal(S.signIns.length, 1);
  assert.equal(S.buildEnvCalls, 2);
});

test('acquire: each Operator and each Workspace gets its own container', async () => {
  reset();
  const t = target();

  const a = await pool.acquire(t);
  const b = await pool.acquire({ ...t, workspace: { id: 'ws-2', csp: 'AZURE' } });
  const c = await pool.acquire({ ...t, userId: `${t.userId}-other` });

  assert.equal(new Set([a.containerId, b.containerId, c.containerId]).size, 3);
});

test('acquire: a changed credential replaces the container and signs in again', async () => {
  reset();
  const t = target();

  const first = await pool.acquire(t);
  const second = await pool.acquire({
    ...t,
    credential: { token: 't2' },
    credentialUpdatedAt: new Date('2026-02-01T00:00:00Z'),
  });

  assert.notEqual(second.containerId, first.containerId);
  assert.deepEqual(S.removed, [first.containerId]);
  assert.deepEqual(S.signIns, ['t1', 't2']);
});

test('acquire: a container that is no longer running is replaced', async () => {
  reset();
  const t = target();

  const first = await pool.acquire(t);
  S.running.delete(first.containerId);
  const second = await pool.acquire(t);

  assert.notEqual(second.containerId, first.containerId);
  assert.equal(S.created.length, 2);
});

test('acquire: a failed sign-in removes the container and is marked as such', async () => {
  reset();
  S.signInError = new Error('Azure sign-in exited 1');
  const t = target();

  await assert.rejects(pool.acquire(t), (err) => err.signInFailed === true);
  assert.deepEqual(S.removed, [S.created[0].id]);

  // Nothing unusable is kept: the next call starts over.
  S.signInError = null;
  const next = await pool.acquire(t);
  assert.equal(S.created.length, 2);
  assert.equal(next.containerId, S.created[1].id);
});

test('acquire: a provider with no sign-in step just gets a container', async () => {
  reset();

  await pool.acquire(target({ workspace: { id: 'ws-1', csp: 'AWS' } }));

  assert.equal(S.created[0].image, 'image-AWS');
  assert.equal(S.signIns.length, 0);
});

test('release: removes the container, and the next acquire makes a new one', async () => {
  reset();
  const t = target();

  const first = await pool.acquire(t);
  await pool.release(t.userId, t.workspace.id);
  const second = await pool.acquire(t);

  assert.deepEqual(S.removed, [first.containerId]);
  assert.notEqual(second.containerId, first.containerId);
});

test('reapIdle: removes only sandboxes idle past their expiry', async (t) => {
  reset();
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const idle = target();
  const fresh = target();

  const idleSandbox = await pool.acquire(idle);
  t.mock.timers.tick(9 * 60 * 1000);
  const freshSandbox = await pool.acquire(fresh);
  t.mock.timers.tick(2 * 60 * 1000);
  await pool.reapIdle();

  assert.ok(S.removed.includes(idleSandbox.containerId));
  assert.ok(!S.removed.includes(freshSandbox.containerId));
  await pool.release(fresh.userId, fresh.workspace.id);
});

test('reapOrphans: removes labelled containers this process does not own', async () => {
  reset();
  const t = target();
  const mine = await pool.acquire(t);
  S.listed = [mine.containerId, 'left-over-1', 'left-over-2'];

  const count = await pool.reapOrphans();

  assert.equal(count, 2);
  assert.deepEqual(S.removed.sort(), ['left-over-1', 'left-over-2']);
  assert.deepEqual(S.listFilters, {
    all: true,
    filters: { label: [`${pool.LABEL_KEY}=${pool.LABEL_VALUE}`] },
  });
  await pool.release(t.userId, t.workspace.id);
});
