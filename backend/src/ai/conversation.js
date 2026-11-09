// How a conversation is shaped for the model: the rules appended to every
// system prompt, the plain-text notes that stand in for past tool calls, and
// the trimming that keeps one request inside the provider's limits. Shared by
// the chat orchestrator and the dashboard graph author.

const { AppError } = require('../middleware/errorHandler');
const { ERROR_CODES } = require('../constants/errors');

const KIND_TO_TOOL = Object.freeze({
  LOOKUP_REQUEST: 'run_lookup',
  COMMAND_REQUEST: 'run_command',
});

// Appended to every persona prompt. History replays past tool calls as plain
// text notes (see buildHistoryFromMessages), and without this rule models
// imitate those notes in their reply text instead of calling the tool -- the
// command then never runs and the note is shown to the Operator as an answer.
const TOOL_CALL_RULES = [
  'Earlier tool calls appear in this conversation as system-written notes like "(called run_command: <command>)", each followed by a "(<tool> result)", "(<tool> failed, ...)" or "(<tool> rejected by policy)" message.',
  'Never write such a note yourself. Writing a command in your reply does not run it: the only way to run a command is to call the run_lookup or run_command tool.',
  'When a command fails, read the error and fix it yourself before involving the Operator. If you are unsure of the correct syntax or parameters, look them up with run_lookup, then retry with a corrected command.',
  'When a command is rejected by policy, it was not run; do not repeat it. Use a different, allowed command to get the same information.',
  'Help pages are long and only partly shown to you. Prefer commands you already know; look up help only for the options you need.',
  'Ask the Operator only for information you cannot discover with a command.',
  "Once you have the information you need, answer the Operator's question directly in plain language.",
].join('\n');

/**
 * The provider's own CLI rules for one Workspace. Persona text is Admin-edited
 * and may name a CLI; the provider line here is what actually holds. A provider
 * whose rules depend on the Workspace (SSH names its hosts) defines
 * `promptRules` as a function of the decrypted credential.
 */
function providerRulesFor(csp, credential) {
  const rules =
    typeof csp.promptRules === 'function' ? csp.promptRules(credential) : csp.promptRules;
  return [
    `This Workspace is on ${csp.label}. The only CLI available is "${csp.binary}"; commands for any other cloud provider's CLI are rejected.`,
    ...rules,
  ].join('\n');
}

// Hard upper bound on any one result note, wherever it is built.
const MAX_MODEL_OUTPUT_CHARS = 12000;

const isToolResultNote = (entry) =>
  entry.role === 'user' && /^\((run_lookup|run_command) /.test(entry.content);

function truncateText(text, max) {
  return text.length > max
    ? `${text.slice(0, max)}\n[... ${text.length - max} more characters not shown]`
    : text;
}

/**
 * Shape the conversation into one request that fits `limits`: the newest
 * output capped at toolOutputChars, older outputs shrunk to olderResultChars,
 * then the oldest turns dropped until the history fits historyChars. Nothing
 * persisted changes -- this is only what the model is sent.
 */
function fitConversation(conversation, limits) {
  const last = conversation[conversation.length - 1];
  const newMessage = isToolResultNote(last)
    ? truncateText(last.content, limits.toolOutputChars)
    : last.content;

  let history = conversation
    .slice(0, -1)
    .map((e) =>
      isToolResultNote(e) ? { ...e, content: truncateText(e.content, limits.olderResultChars) } : e,
    );
  let total = history.reduce((sum, e) => sum + e.content.length, 0);
  let trimmed = false;
  while (history.length > 0 && total > limits.historyChars) {
    total -= history[0].content.length;
    history = history.slice(1);
    trimmed = true;
  }
  // Providers such as Anthropic require the conversation to open with a user
  // turn; trimming must not leave an assistant turn at the front.
  while (trimmed && history.length > 0 && history[0].role !== 'user') history = history.slice(1);
  return { history, newMessage };
}

/**
 * Turn the provider SDK's HTTP errors into messages the Operator can act on;
 * anything else is rethrown untouched (and becomes the generic 500).
 */
function providerError(err) {
  const status = err?.status;
  const detail = String(err?.error?.error?.message ?? err?.message ?? '');
  let mapped = null;
  if (status === 413 || /request too large|maximum context|context length/i.test(detail)) {
    mapped = new AppError(413, ERROR_CODES.AI_PROVIDER_REQUEST_TOO_LARGE);
  } else if (status === 429) {
    mapped = new AppError(429, ERROR_CODES.AI_PROVIDER_RATE_LIMITED);
  } else if (status === 401 || status === 403) {
    mapped = new AppError(502, ERROR_CODES.AI_PROVIDER_AUTH_FAILED);
  }
  if (!mapped) return err;
  console.error(`[orchestrator] AI provider error ${status}: ${detail.slice(0, 300)}`);
  return mapped;
}

function toolCallNote(kind, commandText) {
  return { role: 'assistant', content: `(called ${KIND_TO_TOOL[kind]}: ${commandText})` };
}

const TOOL_TO_TYPE = Object.freeze({
  run_lookup: 'lookup_request',
  run_command: 'command_request',
});

// A note on a line of its own. Greedy to the line's last ")" because commands
// (JMESPath queries, for one) contain parentheses themselves.
const IMITATED_NOTE = /^[ \t]*\(called (run_lookup|run_command): (.+)\)[ \t]*$/m;
const REGIONS_LABEL = / \[regions: ([^\]]+)\]$/;

/**
 * The tool call a text reply stands for when the model wrote a tool-call note
 * instead of calling the tool, shaped like a provider adapter's result; null
 * for an ordinary reply. Despite TOOL_CALL_RULES some models still imitate the
 * notes, and the intent is unambiguous -- the command goes through the same
 * policy checks and confirmation as a native call. The surrounding prose
 * becomes the explanation.
 */
function recoverToolCall(text) {
  const match = typeof text === 'string' ? IMITATED_NOTE.exec(text) : null;
  if (!match) return null;
  let command = match[2].trim();
  let regions;
  const label = REGIONS_LABEL.exec(command);
  if (label) {
    command = command.slice(0, label.index).trim();
    regions = label[1]
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
  }
  if (!command) return null;
  const explanation = text.replace(match[0], '').trim();
  return {
    type: TOOL_TO_TYPE[match[1]],
    content: command,
    command,
    explanation: explanation || undefined,
    regions: regions && regions.length > 0 ? regions : undefined,
  };
}

/**
 * The model-facing copy of a command's output. Capped so one large output (a
 * full `help` page runs to ~2,000 lines) cannot crowd out the conversation or
 * exhaust the provider's token limits; the persisted row keeps everything.
 *
 * `outcome` is 'result', 'failed' / 'failed, exit code N', or
 * 'rejected by policy' -- the model needs to know a command did not succeed
 * to decide to check the documentation and retry.
 */
function toolResultNote(kind, output, outcome = 'result') {
  const text =
    output.length > MAX_MODEL_OUTPUT_CHARS
      ? `${output.slice(0, MAX_MODEL_OUTPUT_CHARS)}\n[... ${output.length - MAX_MODEL_OUTPUT_CHARS} more characters not shown]`
      : output;
  return { role: 'user', content: `(${KIND_TO_TOOL[kind]} ${outcome})\n${text}` };
}

function executionOutcome(execution) {
  if (execution.timedOut) return 'failed, timed out';
  return execution.exitCode === 0 ? 'result' : `failed, exit code ${execution.exitCode}`;
}

module.exports = {
  TOOL_CALL_RULES,
  MAX_MODEL_OUTPUT_CHARS,
  providerRulesFor,
  fitConversation,
  providerError,
  toolCallNote,
  recoverToolCall,
  toolResultNote,
  executionOutcome,
};
