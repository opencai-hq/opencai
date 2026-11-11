// Agent orchestrator: the integration point that drives PLAN.md's execution
// flow by wiring together the provider adapters, the persona/system-prompt
// service, the deterministic command policy classifier, the output sanitizer,
// the per-provider CSP modules and the Docker sandbox.
//
// Two rules from Task 5's security review are load-bearing here and are
// repeated at every call site below:
//
//   1. `classify()`'s `result.argv` -- not the model's raw `commandString` --
//      is authoritative for anything a human sees or that lands in the audit
//      log. `shell-quote` expands `$VAR` to empty and collapses newlines, so
//      the raw string an LLM emitted can differ from what would actually run.
//      Confirming the raw string would mean confirming something other than
//      what executes.
//   2. `argv` is only ever executed as an array. Nothing in this file builds a
//      shell string; `executeInSandbox` takes the array straight through to
//      Docker's `Cmd`, so no shell ever parses it.

const prisma = require('../config/db');
const { AppError } = require('../middleware/errorHandler');
const { ERROR_CODES } = require('../constants/errors');
const { CHAT_MESSAGE_STATUS } = require('../constants/chatMessageStatus');
const { AUDIT_ACTIONS, AUDIT_OUTCOMES } = require('../constants/auditActions');
const { MAX_MODEL_TURNS_PER_MESSAGE, MAX_ORCHESTRATION_WALL_CLOCK_MS } = require('./constants');
const { getPersona } = require('./systemPrompt.service');
const { currentDateRule } = require('./prompts/currentDate');
const { classify } = require('./policy/commandPolicy');
const { commandTextFromArgv } = require('./policy/commandText');
const { POLICY_VERDICTS } = require('./policy/policyVerdicts');
const { combineOutput } = require('./sanitizer');
const { getCsp, policyContextFor, execArgvFor } = require('./csp');
const { provisionSandbox, executeInSandbox, destroySandbox } = require('./sandbox/sandboxManager');
const { contextWindowFor } = require('./contextWindows');
const { DEFAULT_REQUEST_LIMITS } = require('./settingsDefaults');
const { resolveProviderConfig } = require('./providerConfig');
const { emitProgress, emitStatus } = require('../realtime/progress');
const {
  TOOL_CALL_RULES,
  providerRulesFor,
  fitConversation,
  providerError,
  toolCallNote,
  recoverToolCall,
  toolResultNote,
  executionOutcome,
  looksLikeStepDescription,
  STEP_DESCRIPTION_NUDGE,
} = require('./conversation');

// How many prior ChatMessage rows are replayed into the model's context.
// Deliberately local: nothing outside this orchestrator has an opinion on it.
const MAX_HISTORY_MESSAGES = 40;

// ChatMessageRole / ChatMessageKind values, as plain strings. `SYSTEM` is
// deliberately absent: the system prompt is passed to the provider directly and
// is never persisted as a chat row.
const ROLE = Object.freeze({ USER: 'USER', ASSISTANT: 'ASSISTANT' });
const KIND = Object.freeze({
  TEXT: 'TEXT',
  LOOKUP_REQUEST: 'LOOKUP_REQUEST',
  COMMAND_REQUEST: 'COMMAND_REQUEST',
  COMMAND_RESULT: 'COMMAND_RESULT',
  // The model's own reasoning for one provider call, when the provider returns
  // it. Display-only: never replayed into the model's context.
  REASONING: 'REASONING',
});

/**
 * The full system prompt for one Workspace: the persona, the tool rules, the
 * provider's own CLI rules, and today's date.
 */
function systemPromptFor(persona, csp, credential) {
  return `${persona.systemPrompt}\n\n${TOOL_CALL_RULES}\n${providerRulesFor(csp, credential)}\n${currentDateRule()}`;
}

const SANDBOX_UNAVAILABLE_TEXT = "The execution environment couldn't be started. Please try again.";
const SIGN_IN_FAILED_TEXT =
  "I couldn't sign in to the cloud provider with this Workspace's credentials. Ask an Administrator to check them.";
const BUDGET_EXHAUSTED_TEXT =
  "I'm having trouble completing this within the allotted steps. Please try rephrasing or breaking your request into smaller steps.";
const DRY_RUN_FAILED_TEXT = '(dry-run failed to execute)';

// A model that keeps proposing commands the policy refuses is not going to get
// anywhere; it only burns turns. The turn ends once a refused command is
// proposed again, or after this many refusals in a row.
const MAX_CONSECUTIVE_REJECTIONS = 4;

/** Why the turn stopped after the policy kept refusing, in the Operator's terms. */
function blockedText(reason) {
  return `I couldn't do this: this Workspace's command policy doesn't allow what it needs (${reason}). I stopped instead of trying other commands. If this should be possible, ask an Administrator.`;
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                            */
/* -------------------------------------------------------------------------- */

/* ---- Multi-region runs ---------------------------------------------------- */

// Most regions one multi-region step may run in, and how many of those run at
// once inside the sandbox.
const MAX_FANOUT_REGIONS = 25;
const FANOUT_CONCURRENCY = 6;
// AWS region names: us-east-1, ap-southeast-2, us-gov-west-1, ... Anything
// else is refused, so a region can never smuggle another argument in.
const REGION_NAME = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
// Fixed, backend-owned lookup behind regions: ["all"]. describe-regions only
// lists regions enabled on the account; us-east-1 is always reachable.
const LIST_REGIONS_ARGV = Object.freeze([
  'aws',
  'ec2',
  'describe-regions',
  '--region',
  'us-east-1',
  '--query',
  'Regions[].RegionName',
  '--output',
  'text',
]);

function withRegionsLabel(commandText, regions) {
  return `${commandText} [regions: ${regions.join(', ')}]`;
}

/** Why a multi-region request cannot run, or null when it can. */
function regionsProblem(regions, argv, isReadOnly, csp) {
  if (!csp.supportsRegions) {
    return `the "regions" argument is not available on ${csp.label}. Run the command once without it.`;
  }
  if (!isReadOnly) {
    return 'running in several regions is only allowed for read-only commands. Propose changes one region at a time.';
  }
  if (argv.includes('--region')) {
    return 'remove --region from the command when passing regions.';
  }
  if (regions.includes('all')) return null;
  const invalid = regions.filter((r) => !REGION_NAME.test(r));
  if (invalid.length > 0) return `invalid region name(s): ${invalid.join(', ')}.`;
  if (regions.length > MAX_FANOUT_REGIONS) {
    return `at most ${MAX_FANOUT_REGIONS} regions per step; split the request.`;
  }
  return null;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Run a read-only argv once per region (appending `--region <name>`), in
 * parallel, and combine the results into one output with a section per region.
 * `regions: ["all"]` expands to the regions enabled on the account.
 *
 * @returns {Promise<{ regions: string[], exitCodes: Record<string, number|null>,
 *                     output: string, outcome: string }>}
 */
async function runAcrossRegions(containerId, cspName, argv, requested, options) {
  let regions = requested;
  let skipped = [];
  if (requested.includes('all')) {
    const listing = await executeInSandbox(containerId, [...LIST_REGIONS_ARGV], options);
    const names = (listing.stdout || '').split(/\s+/).filter((r) => REGION_NAME.test(r));
    if (listing.exitCode !== 0 || names.length === 0) {
      return {
        regions: [],
        exitCodes: {},
        output: `Could not list the account's regions:\n${combineOutput(listing)}`,
        outcome: 'failed, could not list regions',
      };
    }
    regions = names.slice(0, MAX_FANOUT_REGIONS);
    skipped = names.slice(MAX_FANOUT_REGIONS);
  }

  const executions = await mapWithConcurrency(regions, FANOUT_CONCURRENCY, (region) =>
    executeInSandbox(containerId, execArgvFor(cspName, [...argv, '--region', region]), options),
  );

  const exitCodes = {};
  const sections = regions.map((region, i) => {
    const execution = executions[i];
    exitCodes[region] = execution.timedOut ? null : execution.exitCode;
    const status = execution.timedOut ? 'timed out' : `exit ${execution.exitCode}`;
    const text = combineOutput(execution).trim();
    return `=== ${region} (${status}) ===\n${text || '(no output)'}`;
  });

  const failed = regions.filter((r) => exitCodes[r] !== 0).length;
  let outcome = 'result';
  if (failed === regions.length) outcome = `failed in all ${regions.length} regions`;
  else if (failed > 0) outcome = `result, failed in ${failed} of ${regions.length} regions`;

  if (skipped.length > 0) {
    sections.push(
      `=== not checked (limit ${MAX_FANOUT_REGIONS} regions per step) ===\n${skipped.join(' ')}`,
    );
  }

  return { regions, exitCodes, output: sections.join('\n\n'), outcome };
}

const STATUS_TO_OUTCOME = Object.freeze({
  [CHAT_MESSAGE_STATUS.FAILED]: 'failed',
  [CHAT_MESSAGE_STATUS.REJECTED]: 'rejected by policy',
});

/**
 * Flatten persisted ChatMessage rows (oldest first) into the stateless
 * `{ role, content }` turns both provider adapters expect.
 *
 * Proposals and results are rendered as plain text rather than as native
 * tool-call/tool-result blocks. That is the deliberate simplification that lets
 * both adapters stay single-shot and stateless, with no provider-specific
 * tool-call replay format to maintain (see Task 3).
 */
function buildHistoryFromMessages(messages) {
  const history = [];
  // The tool that produced the next COMMAND_RESULT row; results always follow
  // their request row.
  let lastRequestKind = KIND.COMMAND_REQUEST;
  for (const m of messages) {
    if (m.kind === KIND.REASONING) continue;
    if (m.kind === KIND.LOOKUP_REQUEST || m.kind === KIND.COMMAND_REQUEST) {
      lastRequestKind = m.kind;
      history.push(toolCallNote(m.kind, m.content));
    } else if (m.kind === KIND.COMMAND_RESULT) {
      history.push(toolResultNote(lastRequestKind, m.content, STATUS_TO_OUTCOME[m.status]));
    } else {
      history.push({ role: m.role === ROLE.USER ? 'user' : 'assistant', content: m.content });
    }
  }
  return history;
}

/**
 * Load the most recent MAX_HISTORY_MESSAGES rows for a session, oldest first.
 *
 * `excludeIds` keeps rows this turn has already created out of the replayed
 * history, so they are not counted twice against the rows the caller appends to
 * the conversation explicitly.
 *
 * Implementation note: fetched with `orderBy: desc` + `take` + `reverse()`
 * rather than Prisma's negative-`take` idiom. Both are documented to return the
 * last N; this form is unambiguous without a live database to verify against.
 */
async function loadPriorHistory(sessionId, excludeIds = []) {
  const ids = excludeIds.filter(Boolean);
  const rows = await prisma.chatMessage.findMany({
    where: ids.length > 0 ? { sessionId, id: { notIn: ids } } : { sessionId },
    orderBy: { createdAt: 'desc' },
    take: MAX_HISTORY_MESSAGES,
  });
  return buildHistoryFromMessages([...rows].reverse());
}

/**
 * Write one AuditLog row. `session.userId` is the authoritative actor (the
 * session's owning Operator); ownership is already checked by the caller.
 */
async function writeAudit({ session, workspace, action, outcome, metadata }) {
  await prisma.auditLog.create({
    data: {
      actorUserId: session.userId,
      workspaceId: workspace?.id ?? session.workspaceId ?? null,
      chatSessionId: session.id,
      action,
      outcome: outcome ?? null,
      metadata,
    },
  });
}

/**
 * Persist how full the model's context window was after this turn: the last
 * call's input + output tokens, which is roughly what the next call will send.
 * Returns the `{ tokens, window }` the Operator's UI shows, or null when the
 * provider reported no usage.
 */
async function recordContextUsage(session, providerConfig, lastUsage) {
  if (!lastUsage) return null;
  const tokens = lastUsage.inputTokens + lastUsage.outputTokens;
  const window = contextWindowFor(
    providerConfig.providerName,
    providerConfig.model,
    providerConfig.config,
  );
  await prisma.chatSession.update({
    where: { id: session.id },
    data: { contextTokens: tokens, contextWindow: window },
  });
  return { tokens, window };
}

// Every row a turn returns goes through here, so the Operator's socket sees
// it the moment it is saved (see realtime/progress.js).
function addRow(createdMessages, row) {
  createdMessages.push(row);
  emitProgress({ kind: 'message', message: row });
  return row;
}

async function createMessage(createdMessages, data) {
  return addRow(createdMessages, await prisma.chatMessage.create({ data }));
}

function createAssistantText(createdMessages, sessionId, content) {
  return createMessage(createdMessages, {
    sessionId,
    role: ROLE.ASSISTANT,
    kind: KIND.TEXT,
    content,
  });
}

/**
 * The single source of the command text this orchestrator persists and audits.
 *
 * Always the classifier's tokenized argv -- never the model's raw string. The
 * raw string is used only when argv came back empty, which only happens on a
 * REJECTED verdict for genuinely unparseable input that will never execute.
 * The text is re-parsed at confirm time, so words are quoted where needed to
 * make it parse back to exactly this argv.
 */
function commandTextFor(result, rawCommand) {
  if (Array.isArray(result.argv) && result.argv.length > 0) {
    return commandTextFromArgv(result.argv);
  }
  return typeof rawCommand === 'string' ? rawCommand : '';
}

function hasExplanation(providerResult) {
  return (
    typeof providerResult.explanation === 'string' && providerResult.explanation.trim().length > 0
  );
}

function cappedText(cap) {
  return `This session has reached its limit of ${cap} mutating commands. Start a new session to continue.`;
}

/* ---- Sandbox sign-in ------------------------------------------------------ */

/**
 * Everything a command needs from the Workspace's credential: the per-exec
 * environment, plus a one-time sign-in for providers whose CLI cannot
 * authenticate from the environment alone. A container that could not be
 * signed in is destroyed, so the next message starts a new one and signs in
 * again instead of reusing one that never worked.
 *
 * @returns {Promise<Record<string, string>>} the per-exec environment.
 */
async function signInSandbox({ session, csp, credential, containerId, created, timeoutSeconds }) {
  const env = await csp.buildEnv(credential);
  if (created && csp.prepareSandbox) {
    try {
      await csp.prepareSandbox({
        credential,
        exec: (argv, execEnv) =>
          executeInSandbox(containerId, argv, { env: execEnv, timeoutSeconds }),
      });
    } catch (err) {
      try {
        await destroySandbox({ id: session.id, sandboxContainerId: containerId });
      } catch (destroyErr) {
        console.error(
          `[orchestrator] could not remove unsigned sandbox for session ${session.id}: ${destroyErr.message}`,
        );
      }
      throw err;
    }
  }
  return env;
}

/* -------------------------------------------------------------------------- */
/* The model loop                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Drive the provider until it produces a terminal state for this turn.
 *
 * Terminal states: a plain text answer, a rejected proposal, a capped proposal,
 * or a mutating command parked awaiting confirmation. Lookups and read-only
 * commands execute immediately and feed their result back for another turn,
 * bounded by MAX_MODEL_TURNS_PER_MESSAGE and MAX_ORCHESTRATION_WALL_CLOCK_MS.
 *
 * `conversation` grows in place; its last entry is always the trigger for the
 * next provider call. `createdMessages` accumulates every persisted row, in
 * order, and becomes the caller's `{ messages }`.
 */
async function runModelLoop({
  session,
  persona,
  providerConfig,
  workspace,
  credential,
  env,
  containerId,
  conversation,
  createdMessages,
  startedAt,
  usage = {},
}) {
  const csp = getCsp(workspace.csp);
  const systemPrompt = systemPromptFor(persona, csp, credential);
  const rejectedCommands = new Set();
  let lastRejection = null;
  let consecutiveRejections = 0;
  let nudged = false;

  for (let turn = 0; turn < MAX_MODEL_TURNS_PER_MESSAGE; turn += 1) {
    if (Date.now() - startedAt >= MAX_ORCHESTRATION_WALL_CLOCK_MS) break;

    const { history, newMessage } = fitConversation(
      conversation,
      providerConfig.limits ?? DEFAULT_REQUEST_LIMITS,
    );

    let providerResult;
    emitStatus('Asking the AI', { thinking: true });
    try {
      providerResult = await providerConfig.provider.sendMessage({
        systemPrompt,
        history,
        newMessage,
        model: providerConfig.model,
        apiKey: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl,
        config: providerConfig.config,
      });
    } catch (err) {
      throw providerError(err);
    }
    if (providerResult.usage) usage.last = providerResult.usage;

    // Persisted first so it precedes whatever this call produced.
    if (typeof providerResult.reasoning === 'string' && providerResult.reasoning.trim()) {
      await createMessage(createdMessages, {
        sessionId: session.id,
        role: ROLE.ASSISTANT,
        kind: KIND.REASONING,
        content: providerResult.reasoning.trim(),
      });
    }

    // A tool-call note written as reply text is the call the model meant to
    // make; without this the command never runs and the note is the answer.
    if (providerResult.type === 'text') {
      providerResult = recoverToolCall(providerResult.content) ?? providerResult;
    }

    // 1a. A bare step description ("Start the Redis service") is a tool call the
    //     model forgot to make. Not shown to the Operator, where it reads as an
    //     unasked question; the model is told once and gets another turn.
    if (
      providerResult.type === 'text' &&
      !nudged &&
      looksLikeStepDescription(providerResult.content)
    ) {
      nudged = true;
      conversation.push({ role: 'assistant', content: providerResult.content.trim() });
      conversation.push({ role: 'user', content: STEP_DESCRIPTION_NUDGE });
      continue;
    }

    // 1b. Plain answer -- the model is done with this turn.
    if (providerResult.type === 'text') {
      await createAssistantText(createdMessages, session.id, providerResult.content);
      return;
    }

    const isLookup = providerResult.type === 'lookup_request';
    const kind = isLookup ? KIND.LOOKUP_REQUEST : KIND.COMMAND_REQUEST;

    const result = classify({
      mode: session.mode,
      subMode: session.subMode,
      csp: workspace.csp,
      commandString: providerResult.command,
      personaAllowedBinaries: persona.allowedBinaries,
      cspContext: policyContextFor(workspace.csp, credential),
    });

    // An explanation is its own ASSISTANT/TEXT row, persisted *before* the
    // request row -- never folded into the request row's content, which must
    // round-trip the command string exactly for re-classification at confirm.
    if (hasExplanation(providerResult)) {
      await createAssistantText(createdMessages, session.id, providerResult.explanation);
    }

    const isReadOnly =
      result.verdict === POLICY_VERDICTS.ALLOW_LOOKUP ||
      result.verdict === POLICY_VERDICTS.ALLOW_READONLY;
    // A multi-region request is shown with its regions so the transcript and
    // replayed history say what actually ran.
    const requestedRegions = providerResult.regions;
    const commandText = requestedRegions
      ? withRegionsLabel(commandTextFor(result, providerResult.command), requestedRegions)
      : commandTextFor(result, providerResult.command);
    const rejectionReason =
      result.verdict === POLICY_VERDICTS.REJECTED
        ? result.reason
        : requestedRegions && regionsProblem(requestedRegions, result.argv, isReadOnly, csp);

    // 2. Rejected by policy (or an invalid multi-region request) -- never
    //    executes. The reason goes back to the model so it can find an allowed
    //    way to get the same information, bounded like every other turn by
    //    MAX_MODEL_TURNS_PER_MESSAGE.
    if (rejectionReason) {
      const reasonText = `I can't run that: ${rejectionReason}`;
      await createMessage(createdMessages, {
        sessionId: session.id,
        role: ROLE.ASSISTANT,
        kind,
        content: commandText,
        status: CHAT_MESSAGE_STATUS.REJECTED,
      });
      await createMessage(createdMessages, {
        sessionId: session.id,
        role: ROLE.ASSISTANT,
        kind: KIND.COMMAND_RESULT,
        content: reasonText,
        status: CHAT_MESSAGE_STATUS.REJECTED,
      });
      await writeAudit({
        session,
        workspace,
        action: AUDIT_ACTIONS.COMMAND_REJECTED,
        outcome: AUDIT_OUTCOMES.REJECTED,
        metadata: requestedRegions
          ? { command: result.argv, reason: rejectionReason, regions: requestedRegions }
          : { command: result.argv, reason: rejectionReason },
      });
      const repeated = rejectedCommands.has(commandText);
      rejectedCommands.add(commandText);
      lastRejection = rejectionReason;
      consecutiveRejections += 1;
      if (repeated || consecutiveRejections >= MAX_CONSECUTIVE_REJECTIONS) {
        await createAssistantText(createdMessages, session.id, blockedText(rejectionReason));
        return;
      }
      conversation.push(toolCallNote(kind, commandText));
      conversation.push(
        toolResultNote(kind, reasonText, STATUS_TO_OUTCOME[CHAT_MESSAGE_STATUS.REJECTED]),
      );
      continue;
    }
    consecutiveRejections = 0;

    // 3a. Read-only across several regions: one step, run in parallel.
    if (isReadOnly && requestedRegions) {
      emitStatus(`Running ${commandText}`, { command: commandText });
      const fanout = await runAcrossRegions(
        containerId,
        workspace.csp,
        result.argv,
        requestedRegions,
        { env, timeoutSeconds: providerConfig.sandboxCommandTimeoutSeconds },
      );
      const status = fanout.outcome.startsWith('failed')
        ? CHAT_MESSAGE_STATUS.FAILED
        : CHAT_MESSAGE_STATUS.EXECUTED;

      await createMessage(createdMessages, {
        sessionId: session.id,
        role: ROLE.ASSISTANT,
        kind,
        content: commandText,
        status,
      });
      await createMessage(createdMessages, {
        sessionId: session.id,
        role: ROLE.ASSISTANT,
        kind: KIND.COMMAND_RESULT,
        content: fanout.output,
        commandOutput: fanout.output,
        status,
      });

      await writeAudit({
        session,
        workspace,
        action: isLookup ? AUDIT_ACTIONS.LOOKUP_EXECUTED : AUDIT_ACTIONS.COMMAND_EXECUTED,
        outcome: fanout.outcome === 'result' ? AUDIT_OUTCOMES.SUCCESS : AUDIT_OUTCOMES.FAILURE,
        metadata: { command: result.argv, regions: fanout.regions, exitCodes: fanout.exitCodes },
      });

      conversation.push(toolCallNote(kind, commandText));
      conversation.push(toolResultNote(kind, fanout.output, fanout.outcome));
      continue;
    }

    // 3b. Lookup or read-only -- safe to run without a human in the loop.
    if (isReadOnly) {
      emitStatus(`Running ${commandText}`, { command: commandText });
      const execution = await executeInSandbox(
        containerId,
        execArgvFor(workspace.csp, result.argv),
        { env, timeoutSeconds: providerConfig.sandboxCommandTimeoutSeconds },
      );
      const output = combineOutput(execution);
      const outcome = executionOutcome(execution);
      const status =
        outcome === 'result' ? CHAT_MESSAGE_STATUS.EXECUTED : CHAT_MESSAGE_STATUS.FAILED;

      await createMessage(createdMessages, {
        sessionId: session.id,
        role: ROLE.ASSISTANT,
        kind,
        content: commandText,
        status,
      });
      await createMessage(createdMessages, {
        sessionId: session.id,
        role: ROLE.ASSISTANT,
        kind: KIND.COMMAND_RESULT,
        content: output,
        commandOutput: output,
        status,
      });

      await writeAudit({
        session,
        workspace,
        action: isLookup ? AUDIT_ACTIONS.LOOKUP_EXECUTED : AUDIT_ACTIONS.COMMAND_EXECUTED,
        outcome: execution.exitCode === 0 ? AUDIT_OUTCOMES.SUCCESS : AUDIT_OUTCOMES.FAILURE,
        metadata: {
          command: result.argv,
          exitCode: execution.exitCode,
          timedOut: execution.timedOut,
        },
      });

      conversation.push(toolCallNote(kind, commandText));
      conversation.push(toolResultNote(kind, output, outcome));
      continue;
    }

    // 4. Mutating -- gated behind an explicit human confirmation.
    if (session.mutatingCommandCount >= session.mutatingCommandCap) {
      await createMessage(createdMessages, {
        sessionId: session.id,
        role: ROLE.ASSISTANT,
        kind,
        content: commandText,
        status: CHAT_MESSAGE_STATUS.CAPPED,
      });
      await writeAudit({
        session,
        workspace,
        action: AUDIT_ACTIONS.SESSION_CAP_EXCEEDED,
        outcome: AUDIT_OUTCOMES.CAPPED,
        metadata: { command: result.argv },
      });
      await createAssistantText(
        createdMessages,
        session.id,
        cappedText(session.mutatingCommandCap),
      );
      return;
    }

    await createMessage(createdMessages, {
      sessionId: session.id,
      role: ROLE.ASSISTANT,
      kind,
      content: commandText,
      status: CHAT_MESSAGE_STATUS.PENDING_CONFIRMATION,
    });
    await writeAudit({
      session,
      workspace,
      action: AUDIT_ACTIONS.COMMAND_PROPOSED,
      outcome: null,
      metadata: { command: result.argv },
    });

    // Best-effort preview. A dry-run that blows up must not block the
    // confirmation flow, so the Operator still gets a result row either way.
    if (result.dryRunCapable && !result.argv.includes('--dry-run')) {
      let dryRunOutput;
      emitStatus('Previewing the change with --dry-run');
      try {
        const dryRunArgv = execArgvFor(workspace.csp, [...result.argv, '--dry-run']);
        const dryRun = await executeInSandbox(containerId, dryRunArgv, {
          env,
          timeoutSeconds: providerConfig.sandboxCommandTimeoutSeconds,
        });
        dryRunOutput = combineOutput(dryRun);
      } catch (err) {
        console.error(`[orchestrator] dry-run failed for session ${session.id}: ${err.message}`);
        dryRunOutput = DRY_RUN_FAILED_TEXT;
      }

      await createMessage(createdMessages, {
        sessionId: session.id,
        role: ROLE.ASSISTANT,
        kind: KIND.COMMAND_RESULT,
        content: dryRunOutput,
        commandOutput: dryRunOutput,
        status: CHAT_MESSAGE_STATUS.DRY_RUN,
      });
    }

    // The proposal/confirm split: this turn ends here and confirmCommand picks
    // the conversation back up.
    return;
  }

  // Fell out of the loop without reaching a terminal state. If it ended on
  // refusals, say why rather than blaming the step budget.
  await createAssistantText(
    createdMessages,
    session.id,
    consecutiveRejections > 0 ? blockedText(lastRejection) : BUDGET_EXHAUSTED_TEXT,
  );
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Handle one Operator chat message end to end.
 *
 * @param {{ session: object, workspace: object, credential: object,
 *           userId: string, text: string }} params
 * @returns {Promise<{ messages: object[] }>} every row persisted, in order.
 */
async function handleUserMessage({ session, workspace, credential, userId, text }) {
  // Accepted for future audit/authorization use; `session.userId` is the
  // authoritative actor for the audit writes below.
  void userId;

  const startedAt = Date.now();
  const createdMessages = [];

  const userMessage = await createMessage(createdMessages, {
    sessionId: session.id,
    role: ROLE.USER,
    kind: KIND.TEXT,
    content: text,
  });

  // Deliberately allowed to propagate: the HTTP layer turns AppErrors into
  // responses.
  const providerConfig = await resolveProviderConfig();
  const persona = await getPersona(session.mode, session.subMode);

  const csp = getCsp(workspace.csp);

  let containerId;
  let created;
  emitStatus('Starting the environment');
  try {
    ({ containerId, created } = await provisionSandbox(session, {
      idleTimeoutMinutes: providerConfig.sandboxIdleTimeoutMinutes,
      image: csp.sandboxImage,
    }));
  } catch (err) {
    console.error(
      `[orchestrator] sandbox provisioning failed for session ${session.id}: ${err.message}`,
    );
    // Nothing was proposed, so nothing to audit -- just tell the Operator.
    await createAssistantText(createdMessages, session.id, SANDBOX_UNAVAILABLE_TEXT);
    return { messages: createdMessages };
  }

  let env;
  emitStatus(`Signing in to ${csp.label}`);
  try {
    env = await signInSandbox({
      session,
      csp,
      credential,
      containerId,
      created,
      timeoutSeconds: providerConfig.sandboxCommandTimeoutSeconds,
    });
  } catch (err) {
    console.error(`[orchestrator] cloud sign-in failed for session ${session.id}: ${err.message}`);
    await createAssistantText(createdMessages, session.id, SIGN_IN_FAILED_TEXT);
    return { messages: createdMessages };
  }

  // The row created above is excluded and re-appended explicitly, so it is
  // neither double-counted nor ordered by a createdAt tie.
  const priorHistory = await loadPriorHistory(session.id, [userMessage.id]);
  const conversation = [...priorHistory, { role: 'user', content: text }];

  const usage = {};
  await runModelLoop({
    session,
    persona,
    providerConfig,
    workspace,
    credential,
    env,
    containerId,
    conversation,
    createdMessages,
    startedAt,
    usage,
  });

  const context = await recordContextUsage(session, providerConfig, usage.last);
  return { messages: createdMessages, context };
}

/**
 * Execute a command the Operator explicitly confirmed, then let the model
 * continue from its result.
 *
 * @param {{ session: object, workspace: object, credential: object,
 *           messageId: string, userId: string }} params
 * @returns {Promise<{ messages: object[] }>}
 */
async function confirmCommand({ session, workspace, credential, messageId, userId }) {
  void userId;

  const startedAt = Date.now();
  const createdMessages = [];

  // Atomic claim. Two concurrent confirms both issue this UPDATE; exactly one
  // matches a row still in PENDING_CONFIRMATION, so exactly one can go on to
  // execute. A read-then-write here would let both pass the check.
  const claimed = await prisma.chatMessage.updateMany({
    where: {
      id: messageId,
      sessionId: session.id,
      status: CHAT_MESSAGE_STATUS.PENDING_CONFIRMATION,
    },
    data: { status: CHAT_MESSAGE_STATUS.CONFIRMED },
  });
  if (claimed.count !== 1) {
    throw new AppError(409, ERROR_CODES.COMMAND_ALREADY_RESOLVED);
  }

  const message = await prisma.chatMessage.findUnique({ where: { id: messageId } });
  const persona = await getPersona(session.mode, session.subMode);

  // Defense in depth: policy, persona binaries or mode could have changed
  // between proposal and confirmation. Re-classify the persisted command text
  // and refuse anything that is no longer exactly a confirmable mutation.
  const result = classify({
    mode: session.mode,
    subMode: session.subMode,
    csp: workspace.csp,
    commandString: message.content,
    personaAllowedBinaries: persona.allowedBinaries,
    cspContext: policyContextFor(workspace.csp, credential),
  });

  if (result.verdict !== POLICY_VERDICTS.REQUIRE_CONFIRMATION) {
    const failed = await prisma.chatMessage.update({
      where: { id: messageId },
      data: { status: CHAT_MESSAGE_STATUS.FAILED },
    });
    addRow(createdMessages, failed);

    await createAssistantText(
      createdMessages,
      session.id,
      `This command can no longer be run: ${result.reason || 'it is no longer permitted'}.`,
    );
    await writeAudit({
      session,
      workspace,
      action: AUDIT_ACTIONS.COMMAND_REJECTED,
      outcome: AUDIT_OUTCOMES.FAILURE,
      metadata: { command: result.argv, reason: result.reason },
    });

    // No execution, and the mutating counter is untouched.
    return { messages: createdMessages };
  }

  // Everything from here to the end of execution runs under one catch. Past the
  // atomic claim the command is already CONFIRMED and (shortly) the session's
  // mutating budget is already spent, but COMMAND_EXECUTED is only written once
  // execution completes -- so an unhandled throw in here would leave the single
  // most audit-sensitive operation in the product with no audit record at all,
  // and the message stranded in the non-terminal CONFIRMED state that the claim
  // guard's PENDING_CONFIRMATION predicate makes unretryable. Fail loudly into
  // the transcript and the audit log instead, exactly as handleUserMessage does
  // for its own provisioning failure.
  let providerConfig;
  let containerId;
  let env;
  let execution;

  try {
    // Resolved before the counter is consumed, so a misconfigured provider
    // cannot burn a slot off the session's mutating budget.
    providerConfig = await resolveProviderConfig();

    // Atomic cap increment. The `lt` predicate and the increment are one
    // statement, so concurrent confirms can never push the count past the cap:
    // the losing UPDATE matches zero rows.
    const capResult = await prisma.chatSession.updateMany({
      where: { id: session.id, mutatingCommandCount: { lt: session.mutatingCommandCap } },
      data: { mutatingCommandCount: { increment: 1 } },
    });
    if (capResult.count !== 1) {
      const capped = await prisma.chatMessage.update({
        where: { id: messageId },
        data: { status: CHAT_MESSAGE_STATUS.CAPPED },
      });
      addRow(createdMessages, capped);

      await createAssistantText(
        createdMessages,
        session.id,
        cappedText(session.mutatingCommandCap),
      );
      await writeAudit({
        session,
        workspace,
        action: AUDIT_ACTIONS.SESSION_CAP_EXCEEDED,
        outcome: AUDIT_OUTCOMES.CAPPED,
        metadata: { command: result.argv },
      });

      return { messages: createdMessages };
    }

    // `updateMany` increments the row in the database and does not touch this
    // in-memory copy. Without this line, a mutating command the model chains on
    // in the runModelLoop call below would be cap-checked against a stale count
    // -- so the Operator could be shown a confirmation card for a command that
    // the confirm-time atomic guard will then always refuse.
    session.mutatingCommandCount += 1;

    const csp = getCsp(workspace.csp);
    emitStatus('Starting the environment');
    const sandbox = await provisionSandbox(session, {
      idleTimeoutMinutes: providerConfig.sandboxIdleTimeoutMinutes,
      image: csp.sandboxImage,
    });
    containerId = sandbox.containerId;
    emitStatus(`Signing in to ${csp.label}`);
    env = await signInSandbox({
      session,
      csp,
      credential,
      containerId,
      created: sandbox.created,
      timeoutSeconds: providerConfig.sandboxCommandTimeoutSeconds,
    });

    // argv, as an array. Never a shell string.
    emitStatus(`Running ${result.argv.join(' ')}`, { command: result.argv.join(' ') });
    execution = await executeInSandbox(containerId, execArgvFor(workspace.csp, result.argv), {
      env,
      timeoutSeconds: providerConfig.sandboxCommandTimeoutSeconds,
    });
  } catch (err) {
    console.error(
      `[orchestrator] confirmed command failed for session ${session.id}: ${err.message}`,
    );

    const failed = await prisma.chatMessage.update({
      where: { id: messageId },
      data: { status: CHAT_MESSAGE_STATUS.FAILED },
    });
    addRow(createdMessages, failed);

    await createAssistantText(
      createdMessages,
      session.id,
      `Something went wrong while running this command: ${err.message || 'unknown error'}`,
    );
    await writeAudit({
      session,
      workspace,
      action: AUDIT_ACTIONS.COMMAND_EXECUTED,
      outcome: AUDIT_OUTCOMES.FAILURE,
      metadata: { command: result.argv, error: err.message },
    });

    // The Operator sees a clean failure in the transcript, not a 500.
    return { messages: createdMessages };
  }

  const output = combineOutput(execution);
  const success = execution.exitCode === 0 && !execution.timedOut;
  const finalStatus = success ? CHAT_MESSAGE_STATUS.EXECUTED : CHAT_MESSAGE_STATUS.FAILED;

  const updated = await prisma.chatMessage.update({
    where: { id: messageId },
    data: { status: finalStatus },
  });
  addRow(createdMessages, updated);

  const resultRow = await createMessage(createdMessages, {
    sessionId: session.id,
    role: ROLE.ASSISTANT,
    kind: KIND.COMMAND_RESULT,
    content: output,
    commandOutput: output,
    status: finalStatus,
  });

  await writeAudit({
    session,
    workspace,
    action: AUDIT_ACTIONS.COMMAND_EXECUTED,
    outcome: success ? AUDIT_OUTCOMES.SUCCESS : AUDIT_OUTCOMES.FAILURE,
    metadata: { command: result.argv, exitCode: execution.exitCode, timedOut: execution.timedOut },
  });

  // The proposal and its result are appended explicitly as the conversation's
  // trailing turns, so both are excluded from the replayed history.
  const priorHistory = await loadPriorHistory(session.id, [messageId, resultRow.id]);
  const conversation = [
    ...priorHistory,
    toolCallNote(message.kind, commandTextFor(result, message.content)),
    toolResultNote(message.kind, output, executionOutcome(execution)),
  ];

  const usage = {};
  await runModelLoop({
    session,
    persona,
    providerConfig,
    workspace,
    credential,
    env,
    containerId,
    conversation,
    createdMessages,
    startedAt,
    usage,
  });

  const context = await recordContextUsage(session, providerConfig, usage.last);
  return { messages: createdMessages, context };
}

/**
 * Cancel a pending command. No model call, no execution, no counter change.
 *
 * @param {{ session: object, workspace?: object, messageId: string,
 *           userId: string }} params
 * @returns {Promise<{ messages: object[] }>}
 */
async function cancelCommand({ session, workspace, messageId, userId }) {
  void userId;

  const createdMessages = [];

  // Same atomic claim as confirmCommand: a cancel that races a confirm (or
  // another cancel) loses cleanly instead of overwriting a resolved state.
  const claimed = await prisma.chatMessage.updateMany({
    where: {
      id: messageId,
      sessionId: session.id,
      status: CHAT_MESSAGE_STATUS.PENDING_CONFIRMATION,
    },
    data: { status: CHAT_MESSAGE_STATUS.CANCELLED },
  });
  if (claimed.count !== 1) {
    throw new AppError(409, ERROR_CODES.COMMAND_ALREADY_RESOLVED);
  }

  const message = await prisma.chatMessage.findUnique({ where: { id: messageId } });
  addRow(createdMessages, message);

  await createAssistantText(createdMessages, session.id, 'Command cancelled.');

  await writeAudit({
    session,
    workspace,
    action: AUDIT_ACTIONS.COMMAND_CANCELLED,
    outcome: AUDIT_OUTCOMES.CANCELLED,
    metadata: { messageId },
  });

  return { messages: createdMessages };
}

module.exports = { handleUserMessage, confirmCommand, cancelCommand };
