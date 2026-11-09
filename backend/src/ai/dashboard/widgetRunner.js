// Runs one dashboard graph: fill in the dates, check each command against the
// policy, run it in the sandbox and shape its output into rows. A graph is one
// command or a chain of them (see chain.js). The model is not involved, so a
// graph refreshes the same way every time and works even when no AI provider
// is configured.
//
// Dashboards never ask for confirmation, so the one rule that matters here is
// that nothing but a command the policy calls read-only is ever executed.

const prisma = require('../../config/db');
const { AppError } = require('../../middleware/errorHandler');
const { AUDIT_ACTIONS, AUDIT_OUTCOMES } = require('../../constants/auditActions');
const {
  MAX_ERROR_CHARS,
  MAX_ITEMS_PER_STEP,
  MAX_COMMANDS_PER_RUN,
  MAX_CHAIN_RUN_MS,
} = require('../../constants/dashboard');
const { classify } = require('../policy/commandPolicy');
const { POLICY_VERDICTS } = require('../policy/policyVerdicts');
const { sanitizeOutput } = require('../sanitizer');
const { allowedBinariesForMode } = require('../systemPrompt.service');
const { executeInSandbox } = require('../sandbox/sandboxManager');
const pool = require('../sandbox/dashboardSandboxPool');
const { getCsp, policyContextFor, execArgvFor } = require('../csp');
const { withUserSlot } = require('./runLimiter');
const { emitStatus } = require('../../realtime/progress');
const { resolvePeriod } = require('./period');
const { chainProblem, renderStep, stepsOf, ItemValueError } = require('./chain');
const {
  chartSpecSchema,
  shapeRows,
  selectObjects,
  scalarFields,
  ChartDataError,
} = require('./chartSpec');

const DEFAULT_COMMAND_TIMEOUT_SECONDS = 60;

const SANDBOX_UNAVAILABLE_TEXT = "The execution environment couldn't be started.";
const SIGN_IN_FAILED_TEXT =
  "Couldn't sign in to the cloud provider with this Workspace's credentials. Ask an Administrator to check them.";
const READ_ONLY_TEXT =
  'dashboards are read-only; a command that creates, changes or deletes anything is never run here';

/** Thrown when no sandbox could be made ready for a command. */
class SandboxUnavailableError extends Error {}

async function commandTimeoutSeconds() {
  const settings = await prisma.chatSettings.findFirst();
  return settings?.sandboxCommandTimeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS;
}

/**
 * Run an already-classified argv in the Operator's dashboard sandbox for this
 * Workspace. A sandbox that turns out to be unusable is replaced once.
 *
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: ?number, timedOut: boolean }>}
 * @throws {SandboxUnavailableError}
 */
async function execInDashboardSandbox({
  userId,
  workspace,
  credential,
  credentialUpdatedAt,
  argv,
}) {
  const timeoutSeconds = await commandTimeoutSeconds();
  return withUserSlot(userId, async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const { containerId, env } = await pool.acquire({
          userId,
          workspace,
          credential,
          credentialUpdatedAt,
          timeoutSeconds,
        });
        return await executeInSandbox(containerId, execArgvFor(workspace.csp, argv), {
          env,
          timeoutSeconds,
        });
      } catch (err) {
        if (err instanceof AppError) throw err;
        await pool.release(userId, workspace.id);
        if (attempt === 0 && !err.signInFailed) continue;
        console.error(`[dashboard] sandbox unavailable: ${err.message}`);
        throw new SandboxUnavailableError(
          err.signInFailed ? SIGN_IN_FAILED_TEXT : SANDBOX_UNAVAILABLE_TEXT,
        );
      }
    }
  });
}

async function writeDashboardAudit({ userId, workspaceId, action, outcome, metadata }) {
  await prisma.auditLog.create({
    data: {
      actorUserId: userId,
      workspaceId,
      chatSessionId: null,
      action,
      outcome: outcome ?? null,
      metadata,
    },
  });
}

/**
 * Check one rendered command against the policy, run it and parse its JSON.
 *
 * @param {Function} params.audit (action, outcome, metadata) => Promise
 * @param {?string} [params.status] what the Operator is told while it runs.
 * @returns {Promise<{ ok: true, json: any, argv: string[] }
 *                  | { ok: false, error: string, rejected?: boolean }>}
 */
async function runCommand({
  rendered,
  status,
  userId,
  workspace,
  credential,
  credentialUpdatedAt,
  mode,
  audit,
}) {
  // The policy sees exactly what would run: the command with its values in.
  const verdict = classify({
    mode,
    csp: workspace.csp,
    commandString: rendered,
    personaAllowedBinaries: await allowedBinariesForMode(mode),
    cspContext: policyContextFor(workspace.csp, credential),
  });

  if (verdict.verdict !== POLICY_VERDICTS.ALLOW_READONLY) {
    const reason = verdict.verdict === POLICY_VERDICTS.REJECTED ? verdict.reason : READ_ONLY_TEXT;
    await audit(AUDIT_ACTIONS.DASHBOARD_COMMAND_REJECTED, AUDIT_OUTCOMES.REJECTED, {
      command: verdict.argv,
      reason,
    });
    return { ok: false, rejected: true, error: `The command was not run: ${reason}` };
  }

  emitStatus(status ?? `Running ${verdict.argv.join(' ')}`);
  let execution;
  try {
    execution = await execInDashboardSandbox({
      userId,
      workspace,
      credential,
      credentialUpdatedAt,
      argv: verdict.argv,
    });
  } catch (err) {
    if (err instanceof SandboxUnavailableError) return { ok: false, error: err.message };
    throw err;
  }

  const succeeded = execution.exitCode === 0 && !execution.timedOut;
  await audit(
    AUDIT_ACTIONS.DASHBOARD_COMMAND_EXECUTED,
    succeeded ? AUDIT_OUTCOMES.SUCCESS : AUDIT_OUTCOMES.FAILURE,
    { command: verdict.argv, exitCode: execution.exitCode, timedOut: execution.timedOut },
  );

  if (execution.timedOut) return { ok: false, error: 'The command timed out.' };
  if (execution.exitCode !== 0) {
    const detail = sanitizeOutput(execution.stderr || execution.stdout || '').trim();
    return {
      ok: false,
      error: `The command failed (exit code ${execution.exitCode}): ${detail.slice(0, MAX_ERROR_CHARS) || 'no error output'}`,
    };
  }

  try {
    return { ok: true, json: JSON.parse(sanitizeOutput(execution.stdout)), argv: verdict.argv };
  } catch {
    const csp = getCsp(workspace.csp);
    return {
      ok: false,
      error: `The command output was not JSON, or was too large to read. The command must print JSON (${csp.label}: ${csp.dashboardOutputHint}) and return a modest amount of data.`,
    };
  }
}

/** A step's output as plain rows, each carrying its parent row's fields. */
function stepRows(json, rowsPath, parent) {
  return selectObjects(json, rowsPath).map((row) => ({ ...parent, ...scalarFields(row) }));
}

/**
 * Run one graph end to end: its one command, or its chain of steps.
 *
 * A graph that cannot run is a normal outcome, not an exception: the caller
 * stores the reason and keeps the graph's previous result. In a chain, an item
 * whose command fails is skipped and counted; the graph fails only when step 1
 * fails, a command is refused by the policy, or a step fails for every item.
 *
 * @param {object} params
 * @param {?object[]} [params.steps] a chain; without it `commandTemplate` runs alone.
 * @param {string} params.trigger 'preview' | 'save' | 'refresh', for the audit log.
 * @param {?string} [params.widgetId] absent while a graph is still a draft.
 * @returns {Promise<{ ok: true, result: object, argv: string[], commands: string[][] }
 *                  | { ok: false, error: string, rejected?: boolean }>}
 *   `argv` is the first command that ran, `commands` every command that ran.
 */
async function runWidget({
  userId,
  workspace,
  credential,
  credentialUpdatedAt,
  mode,
  commandTemplate,
  steps,
  period,
  chartSpec,
  trigger,
  widgetId = null,
  now = new Date(),
}) {
  const spec = chartSpecSchema.safeParse(chartSpec);
  if (!spec.success) {
    return {
      ok: false,
      error: `The chart definition is not valid: ${spec.error.issues.map((i) => i.message).join('; ')}`,
    };
  }

  const chain = stepsOf({ steps, commandTemplate });
  const problem = chainProblem(chain, period);
  if (problem) return { ok: false, error: `The command cannot be used: ${problem}` };
  const dates = resolvePeriod(period, now);

  const audit = (action, outcome, extra) =>
    writeDashboardAudit({
      userId,
      workspaceId: workspace.id,
      action,
      outcome,
      metadata: { widgetId, trigger, ...extra },
    });
  const run = (rendered, status) =>
    runCommand({
      rendered,
      status,
      userId,
      workspace,
      credential,
      credentialUpdatedAt,
      mode,
      audit,
    });
  const failed = (i, out) =>
    chain.length > 1 ? { ...out, error: `Step ${i + 1}: ${out.error}` } : out;

  const startedAt = Date.now();
  const commands = [];
  let truncated = false;
  let skippedItems = 0;

  // Step 1 runs once.
  const first = await run(renderStep(chain[0].command, dates, null));
  if (!first.ok) return failed(0, first);
  commands.push(first.argv);

  let data = first.json;
  try {
    if (chain[0].rowsPath) data = stepRows(first.json, chain[0].rowsPath, {});
  } catch (err) {
    if (err instanceof ChartDataError) return failed(0, { ok: false, error: err.message });
    throw err;
  }

  // Every later step runs once per row of the step before it, one at a time,
  // so a chain never holds more than one of the Operator's sandbox slots.
  for (let i = 1; i < chain.length; i += 1) {
    let parents = data;
    if (parents.length > MAX_ITEMS_PER_STEP) {
      parents = parents.slice(0, MAX_ITEMS_PER_STEP);
      truncated = true;
    }

    const rows = [];
    let failures = 0;
    let lastError = null;
    for (const [k, parent] of parents.entries()) {
      if (commands.length >= MAX_COMMANDS_PER_RUN || Date.now() - startedAt >= MAX_CHAIN_RUN_MS) {
        truncated = true;
        break;
      }
      let out;
      try {
        out = await run(
          renderStep(chain[i].command, dates, parent),
          `Step ${i + 1} of ${chain.length}: item ${k + 1} of ${parents.length}`,
        );
      } catch (err) {
        if (!(err instanceof ItemValueError)) throw err;
        out = { ok: false, error: `The command cannot be used: ${err.message}` };
      }
      if (out.rejected) return failed(i, out);

      try {
        if (!out.ok) throw new ChartDataError(out.error);
        commands.push(out.argv);
        rows.push(...stepRows(out.json, chain[i].rowsPath, parent));
      } catch (err) {
        if (!(err instanceof ChartDataError)) throw err;
        failures += 1;
        lastError = err.message;
      }
    }

    if (parents.length > 0 && failures === parents.length) {
      return failed(i, { ok: false, error: `it failed for every item. Last error: ${lastError}` });
    }
    skippedItems += failures;
    data = rows;
  }

  try {
    const result = shapeRows(data, spec.data);
    if (truncated) result.truncated = true;
    if (skippedItems > 0) result.skippedItems = skippedItems;
    return { ok: true, result, argv: commands[0], commands };
  } catch (err) {
    if (err instanceof ChartDataError) return { ok: false, error: err.message };
    throw err;
  }
}

module.exports = {
  runWidget,
  execInDashboardSandbox,
  writeDashboardAudit,
  SandboxUnavailableError,
  READ_ONLY_TEXT,
};
