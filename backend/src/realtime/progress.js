// Live progress for a long-running request (a chat turn, a graph being built).
//
// The request runs inside withProgress(); anything it calls, however deep, can
// report a step with emitProgress() without each function passing a callback
// along. Outside a context, as on the plain HTTP routes, emitProgress does
// nothing.

const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

/** Run `fn` with every emitProgress() inside it delivered to `emit`. */
function withProgress(emit, fn) {
  return storage.run(emit, fn);
}

/**
 * Report a step to whoever is listening.
 *
 * @param {{ kind: 'message', message: object } | { kind: 'status', text: string }} event
 */
function emitProgress(event) {
  const emit = storage.getStore();
  if (!emit) return;
  try {
    emit(event);
  } catch (err) {
    // A listener that fails (a closed socket) must never fail the work itself.
    console.error(`[progress] could not deliver an event: ${err.message}`);
  }
}

/** Report a transient status line, e.g. "Asking the AI"; `extra` tags it, e.g. `{ command }`. */
const emitStatus = (text, extra) => emitProgress({ kind: 'status', text, ...extra });

module.exports = { withProgress, emitProgress, emitStatus };
