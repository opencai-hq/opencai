// Keeps one Operator's dashboard from flooding the sandbox and the cloud
// provider's API. In-process, like the sandbox idle sweep: it assumes a single
// backend process.

const { AppError } = require('../../middleware/errorHandler');
const { ERROR_CODES } = require('../../constants/errors');

const MAX_CONCURRENT_PER_USER = 2;
const MAX_WAITING_PER_USER = 24;

// userId -> { active: number, waiting: Array<() => void> }
const users = new Map();

/**
 * Run `fn` in one of the user's slots, waiting for one if they are all busy.
 *
 * @throws {AppError} 429 when too many runs are already waiting.
 */
async function withUserSlot(userId, fn) {
  let state = users.get(userId);
  if (!state) {
    state = { active: 0, waiting: [] };
    users.set(userId, state);
  }

  if (state.active < MAX_CONCURRENT_PER_USER) {
    state.active += 1;
  } else {
    if (state.waiting.length >= MAX_WAITING_PER_USER) {
      throw new AppError(429, ERROR_CODES.DASHBOARD_BUSY);
    }
    // The slot is handed over by whoever finishes next; `active` stays as is.
    await new Promise((resolve) => state.waiting.push(resolve));
  }

  try {
    return await fn();
  } finally {
    const next = state.waiting.shift();
    if (next) {
      next();
    } else {
      state.active -= 1;
      if (state.active === 0) users.delete(userId);
    }
  }
}

const inFlight = new Map();

/** Concurrent calls with the same key share one run of `fn`. */
function singleFlight(key, fn) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = Promise.resolve()
    .then(fn)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

module.exports = { withUserSlot, singleFlight, MAX_CONCURRENT_PER_USER, MAX_WAITING_PER_USER };
