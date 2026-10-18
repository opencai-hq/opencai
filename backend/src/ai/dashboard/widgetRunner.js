// Runs one dashboard graph: fill in the dates, check the command against the
// policy, run it in the sandbox and shape its output into rows. The model is
// not involved, so a graph refreshes the same way every time and works even
// when no AI provider is configured.
//
// Dashboards never ask for confirmation, so the one rule that matters here is
// that nothing but a command the policy calls read-only is ever executed.

const prisma = require('../../config/db');
const { AppError } = require('../../middleware/errorHandler');
const { AUDIT_ACTIONS, AUDIT_OUTCOMES } = require('../../constants/auditActions');
const { MAX_ERROR_CHARS } = require('../../constants/dashboard');
const { classify } = require('../policy/commandPolicy');
const { POLICY_VERDICTS } = require('../policy/policyVerdicts');
const { sanitizeOutput } = require('../sanitizer');
const { allowedBinariesForMode } = require('../systemPrompt.service');
const { executeInSandbox } = require('../sandbox/sandboxManager');
const pool = require('../sandbox/dashboardSandboxPool');
const { withUserSlot } = require('./runLimiter');
const { renderCommand } = require('./period');
const { chartSpecSchema, shapeRows, ChartDataError } = require('./chartSpec');

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
        return await executeInSandbox(containerId, argv, { env, timeoutSeconds });
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
 * Run one graph end to end.
 *
 * A graph that cannot run is a normal outcome, not an exception: the caller
 * stores the reason and keeps the graph's previous result.
 *
 * @param {object} params
 * @param {string} params.trigger 'preview' | 'save' | 'refresh', for the audit log.
 * @param {?string} [params.widgetId] absent while a graph is still a draft.
 * @returns {Promise<{ ok: true, result: object, argv: string[] }
 *                  | { ok: false, error: string, rejected?: boolean }>}
 */
async function runWidget({
  userId,
  workspace,
  credential,
  credentialUpdatedAt,
  mode,
  commandTemplate,
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

  let rendered;
  try {
    rendered = renderCommand(commandTemplate, period, now);
  } catch (err) {
    return { ok: false, error: `The command cannot be used: ${err.message}` };
  }

  // The policy sees exactly what would run: the command with its dates in.
  const verdict = classify({
    mode,
    csp: workspace.csp,
    commandString: rendered,
    personaAllowedBinaries: await allowedBinariesForMode(mode),
  });
  const audit = (action, outcome, extra) =>
    writeDashboardAudit({
      userId,
      workspaceId: workspace.id,
      action,
      outcome,
      metadata: { widgetId, trigger, command: verdict.argv, ...extra },
    });

  if (verdict.verdict !== POLICY_VERDICTS.ALLOW_READONLY) {
    const reason = verdict.verdict === POLICY_VERDICTS.REJECTED ? verdict.reason : READ_ONLY_TEXT;
    await audit(AUDIT_ACTIONS.DASHBOARD_COMMAND_REJECTED, AUDIT_OUTCOMES.REJECTED, { reason });
    return { ok: false, rejected: true, error: `The command was not run: ${reason}` };
  }

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
    { exitCode: execution.exitCode, timedOut: execution.timedOut },
  );

  if (execution.timedOut) return { ok: false, error: 'The command timed out.' };
  if (execution.exitCode !== 0) {
    const detail = sanitizeOutput(execution.stderr || execution.stdout || '').trim();
    return {
      ok: false,
      error: `The command failed (exit code ${execution.exitCode}): ${detail.slice(0, MAX_ERROR_CHARS) || 'no error output'}`,
    };
  }

  let json;
  try {
    json = JSON.parse(sanitizeOutput(execution.stdout));
  } catch {
    return {
      ok: false,
      error:
        'The command output was not JSON, or was too large to read. The command must print JSON (--output json / --format=json) and return a modest amount of data.',
    };
  }

  try {
    return { ok: true, result: shapeRows(json, spec.data), argv: verdict.argv };
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
