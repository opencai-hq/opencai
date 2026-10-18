const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  withUserSlot,
  singleFlight,
  MAX_CONCURRENT_PER_USER,
  MAX_WAITING_PER_USER,
} = require('./runLimiter');
const { ERROR_CODES } = require('../../constants/errors');

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('withUserSlot: runs at most MAX_CONCURRENT_PER_USER at once per user, in order', async () => {
  const gates = Array.from({ length: 5 }, deferred);
  const started = [];
  let running = 0;
  let peak = 0;
  const runs = gates.map((gate, i) =>
    withUserSlot('u1', async () => {
      started.push(i);
      running += 1;
      peak = Math.max(peak, running);
      await gate.promise;
      running -= 1;
      return i;
    }),
  );

  await tick();
  assert.deepEqual(started, [0, 1]);
  gates[0].resolve();
  await tick();
  assert.deepEqual(started, [0, 1, 2]);
  gates.forEach((g) => g.resolve());
  assert.deepEqual(await Promise.all(runs), [0, 1, 2, 3, 4]);
  assert.equal(peak, MAX_CONCURRENT_PER_USER);
});

test('withUserSlot: one user waiting does not hold up another', async () => {
  const gate = deferred();
  const busy = [withUserSlot('u1', () => gate.promise), withUserSlot('u1', () => gate.promise)];
  assert.equal(await withUserSlot('u2', async () => 'ran'), 'ran');
  gate.resolve();
  await Promise.all(busy);
});

test('withUserSlot: a failing run frees its slot', async () => {
  await assert.rejects(
    withUserSlot('u1', async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  const results = await Promise.all([1, 2, 3].map((n) => withUserSlot('u1', async () => n)));
  assert.deepEqual(results, [1, 2, 3]);
});

test('withUserSlot: refuses once too many runs are waiting', async () => {
  const gate = deferred();
  const runs = [];
  for (let i = 0; i < MAX_CONCURRENT_PER_USER + MAX_WAITING_PER_USER; i += 1) {
    runs.push(withUserSlot('u1', () => gate.promise));
  }
  await assert.rejects(
    withUserSlot('u1', async () => 'never'),
    (err) => err.status === 429 && err.code === ERROR_CODES.DASHBOARD_BUSY,
  );
  gate.resolve();
  await Promise.all(runs);
});

test('singleFlight: concurrent calls with one key share a run; later calls run again', async () => {
  const gate = deferred();
  let calls = 0;
  const fn = async () => {
    calls += 1;
    await gate.promise;
    return calls;
  };
  const a = singleFlight('w1', fn);
  const b = singleFlight('w1', fn);
  const other = singleFlight('w2', async () => 'other');
  gate.resolve();
  assert.deepEqual(await Promise.all([a, b, other]), [1, 1, 'other']);
  assert.equal(await singleFlight('w1', fn), 2);
});
