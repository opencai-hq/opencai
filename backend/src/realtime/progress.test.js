const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withProgress, emitProgress, emitStatus } = require('./progress');

test('outside a context, emitting does nothing', () => {
  assert.doesNotThrow(() => emitProgress({ kind: 'status', text: 'x' }));
});

test('events reach the listener through awaits, in order', async () => {
  const seen = [];
  await withProgress(
    (event) => seen.push(event),
    async () => {
      emitStatus('one');
      await new Promise((resolve) => setImmediate(resolve));
      emitProgress({ kind: 'message', message: { id: 'm-1' } });
    },
  );
  assert.deepEqual(seen, [
    { kind: 'status', text: 'one' },
    { kind: 'message', message: { id: 'm-1' } },
  ]);
});

test('concurrent requests keep their own listeners', async () => {
  const a = [];
  const b = [];
  const work = (name) => async () => {
    await new Promise((resolve) => setTimeout(resolve, name === 'a' ? 5 : 1));
    emitStatus(name);
  };
  await Promise.all([
    withProgress((e) => a.push(e.text), work('a')),
    withProgress((e) => b.push(e.text), work('b')),
  ]);
  assert.deepEqual(a, ['a']);
  assert.deepEqual(b, ['b']);
});

test('a nested context does not leak into the outer one', async () => {
  const outer = [];
  const inner = [];
  await withProgress(
    (e) => outer.push(e.text),
    async () => {
      await withProgress(
        (e) => inner.push(e.text),
        async () => emitStatus('in'),
      );
      emitStatus('out');
    },
  );
  assert.deepEqual(outer, ['out']);
  assert.deepEqual(inner, ['in']);
});

test('a listener that throws never fails the work', async () => {
  const result = await withProgress(
    () => {
      throw new Error('socket closed');
    },
    async () => {
      emitStatus('x');
      return 'done';
    },
  );
  assert.equal(result, 'done');
});
