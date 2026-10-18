// Sandboxes for dashboard graphs. A chat sandbox belongs to a ChatSession row;
// a dashboard has no session, so its containers are tracked here in memory:
// one per Operator and Workspace, shared by every graph on that Workspace.
//
// Nothing here survives a restart, so every container carries a label and
// reapOrphans() removes whatever a previous process left behind.

const { docker } = require('./dockerClient');
const { createSandboxContainer, executeInSandbox } = require('./sandboxManager');
const { getCsp } = require('../csp');

const LABEL_KEY = 'opencai.sandbox';
const LABEL_VALUE = 'dashboard';
const IDLE_MS = 10 * 60 * 1000;

// key -> { containerId, stamp, expiresAt }
const entries = new Map();
// key -> tail of that key's queue of container operations
const locks = new Map();

const keyFor = (userId, workspaceId) => `${userId}:${workspaceId}`;

/** Run `fn` after every earlier operation on the same key has finished. */
function withLock(key, fn) {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

async function removeContainer(containerId) {
  try {
    await docker.getContainer(containerId).remove({ force: true });
  } catch {
    // Already gone -- nothing worth surfacing.
  }
}

async function isRunning(containerId) {
  try {
    const info = await docker.getContainer(containerId).inspect();
    return Boolean(info?.State?.Running);
  } catch {
    return false;
  }
}

async function dropEntry(key) {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  await removeContainer(entry.containerId);
}

/**
 * A running, signed-in sandbox for this Operator and Workspace, plus the
 * environment a command needs. Concurrent calls for the same pair share one
 * container and one sign-in.
 *
 * The container is replaced when the Workspace's credential has changed since
 * it was signed in. The environment is built on every call, so nothing secret
 * is kept here and short-lived tokens are always fresh.
 *
 * @returns {Promise<{ containerId: string, env: Record<string, string> }>}
 */
async function acquire({ userId, workspace, credential, credentialUpdatedAt, timeoutSeconds }) {
  const csp = getCsp(workspace.csp);
  const key = keyFor(userId, workspace.id);
  const stamp = credentialUpdatedAt ? String(new Date(credentialUpdatedAt).getTime()) : '';

  const containerId = await withLock(key, async () => {
    const entry = entries.get(key);
    if (entry) {
      if (entry.stamp === stamp && (await isRunning(entry.containerId))) {
        entry.expiresAt = Date.now() + IDLE_MS;
        return entry.containerId;
      }
      await dropEntry(key);
    }

    const container = await createSandboxContainer({
      image: csp.sandboxImage,
      labels: { [LABEL_KEY]: LABEL_VALUE },
    });
    if (csp.prepareSandbox) {
      try {
        await csp.prepareSandbox({
          credential,
          exec: (argv, env) => executeInSandbox(container.id, argv, { env, timeoutSeconds }),
        });
      } catch (err) {
        await removeContainer(container.id);
        err.signInFailed = true;
        throw err;
      }
    }
    entries.set(key, { containerId: container.id, stamp, expiresAt: Date.now() + IDLE_MS });
    return container.id;
  });

  return { containerId, env: await csp.buildEnv(credential) };
}

/** Remove this pair's sandbox, e.g. after an exec found it unusable. */
function release(userId, workspaceId) {
  const key = keyFor(userId, workspaceId);
  return withLock(key, () => dropEntry(key));
}

/** Remove sandboxes that have not been used for IDLE_MS. */
async function reapIdle() {
  const now = Date.now();
  const expired = [...entries.entries()].filter(([, entry]) => entry.expiresAt < now);
  await Promise.all(
    expired.map(([key]) =>
      withLock(key, async () => {
        // Re-check: it may have been used while this waited for the lock.
        const entry = entries.get(key);
        if (entry && entry.expiresAt < Date.now()) await dropEntry(key);
      }),
    ),
  );
  return expired.length;
}

/**
 * Remove every dashboard sandbox on the Docker host that this process does not
 * know about. Called once at startup, before any dashboard request can run.
 */
async function reapOrphans() {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [`${LABEL_KEY}=${LABEL_VALUE}`] },
  });
  const known = new Set([...entries.values()].map((entry) => entry.containerId));
  const orphans = containers.filter((c) => !known.has(c.Id));
  await Promise.all(orphans.map((c) => removeContainer(c.Id)));
  return orphans.length;
}

const REAP_INTERVAL_MS = 60000;

/**
 * Clear out leftovers from a previous process, then reap idle sandboxes
 * periodically.
 *
 * @returns {NodeJS.Timeout} the interval handle.
 */
function startDashboardSandboxReaper() {
  reapOrphans()
    .then((count) => {
      if (count > 0) console.log(`[sandbox] removed ${count} leftover dashboard sandbox(es)`);
    })
    .catch((err) => console.error(`[sandbox] dashboard orphan reap failed: ${err.message}`));

  return setInterval(() => {
    reapIdle().catch((err) =>
      console.error(`[sandbox] dashboard idle reap failed: ${err.message}`),
    );
  }, REAP_INTERVAL_MS);
}

module.exports = {
  acquire,
  release,
  reapIdle,
  reapOrphans,
  startDashboardSandboxReaper,
  LABEL_KEY,
  LABEL_VALUE,
};
