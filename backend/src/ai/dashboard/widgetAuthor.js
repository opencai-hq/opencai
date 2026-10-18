// Turns an Operator's plain-language request into a dashboard graph: one
// read-only command, a chart definition, and a small page that draws it. This is the only place a dashboard
// uses the model; once a graph is saved it runs without it (see widgetRunner).
//
// The model may run read-only commands to see what the output really looks
// like, then answers with a JSON graph definition followed by the page. The
// definition is not trusted: it is run through the real pipeline, and a failure
// goes back to the model to fix. The page is never run here; the browser shows
// it in an isolated frame (see chartHtml.js).

const { z } = require('zod');
const { AppError } = require('../../middleware/errorHandler');
const { ERROR_CODES, ERROR_MESSAGES } = require('../../constants/errors');
const { AUDIT_ACTIONS, AUDIT_OUTCOMES } = require('../../constants/auditActions');
const { CHAT_MODES } = require('../../constants/chatModes');
const { DASHBOARD_PERIODS, MAX_TEMPLATE_CHARS } = require('../../constants/dashboard');
const { MAX_MODEL_TURNS_PER_MESSAGE, MAX_ORCHESTRATION_WALL_CLOCK_MS } = require('../constants');
const { DEFAULT_REQUEST_LIMITS } = require('../settingsDefaults');
const { resolveProviderConfig } = require('../providerConfig');
const {
  providerRulesFor,
  fitConversation,
  providerError,
  toolCallNote,
  toolResultNote,
  executionOutcome,
} = require('../conversation');
const { classify } = require('../policy/commandPolicy');
const { POLICY_VERDICTS } = require('../policy/policyVerdicts');
const { combineOutput } = require('../sanitizer');
const { getCsp } = require('../csp');
const { allowedBinariesForMode } = require('../systemPrompt.service');
const { chartSpecSchema } = require('./chartSpec');
const { chartHtmlSchema } = require('./chartHtml');
const { PAGE_RULES } = require('./pagePrompt');
const {
  runWidget,
  execInDashboardSandbox,
  writeDashboardAudit,
  SandboxUnavailableError,
  READ_ONLY_TEXT,
} = require('./widgetRunner');

// How many graph definitions the model may offer before giving up.
const MAX_SPEC_ATTEMPTS = 3;
const MAX_TITLE_CHARS = 80;

const MODE_CONTEXT = Object.freeze({
  [CHAT_MODES.CLOUDOPS]:
    'This is the CloudOps dashboard: graphs about cloud resources and their current state.',
  [CHAT_MODES.FINOPS]: 'This is the FinOps dashboard: graphs about cost, usage, tagging and waste.',
});

const AUTHOR_PROMPT = `You build one graph for an Operator's cloud dashboard in OpenCAI. The Workspace (cloud provider, account and environment) is already selected. The Operator describes the graph they want; you work out the single read-only CLI command that returns its data and how to turn its output into rows, and you write the small page that draws those rows.

How to work:
- Call run_command to run a read-only command and see its real output before you decide. Do this whenever you are not certain of the exact shape of the output: the graph only works if your field paths match it. Call run_lookup for CLI help.
- Earlier tool calls appear in this conversation as system-written notes like "(called run_command: <command>)", each followed by a "(<tool> result)", "(<tool> failed, ...)" or "(<tool> rejected by policy)" message. Never write such a note yourself.
- Dashboards are read-only. A command that creates, changes or deletes anything is rejected and never runs. Do not use the "regions" argument.
- Do not ask the Operator questions. If the request is ambiguous, choose the most useful reading. If it cannot be shown as a read-only graph at all, say so in one sentence and nothing else.

Your final reply must be one JSON object, then one \`\`\`html code block holding the page, and nothing else -- no prose:
{"title": "...", "commandTemplate": "...", "period": "...", "chartSpec": {...}}
\`\`\`html
...the page...
\`\`\`

title: short, under 60 characters.

commandTemplate: the one command run every time the graph refreshes.
- It must print JSON (AWS and Azure: --output json; Google Cloud: --format=json).
- Never write a real date in it. Where the command takes dates, write {{start}} and either {{end}} (the day after today, for an end date that is exclusive, as in AWS Cost Explorer) or {{end_inclusive}} (today, for an end date that is inclusive). They are replaced with YYYY-MM-DD dates on every run. For a timestamp write, for example, {{start}}T00:00:00Z.
- A command you run with run_command to explore needs real dates. Only the final commandTemplate uses placeholders.
- No backticks, pipes or other shell syntax. Do not use the CLI's own --query option with backtick literals; shape the data with rowsPath instead.

period: one of ${Object.values(DASHBOARD_PERIODS).join(', ')}. Use NONE only for a graph of current state whose command takes no dates, and then use no placeholders. Otherwise choose the period that matches the request, or LAST_30_DAYS when it does not say.

chartSpec: how the command's output becomes the rows your page draws. It draws nothing itself.
- type: the shape of the rows. "line", "bar" or "area" (values along x), "pie" (shares of a total), "stat" (one number) or "table" (plain rows with the columns you list -- use it for a list, or for any drawing the other types do not fit).
- rowsPath: a JMESPath expression over the command's JSON output that returns a list of flat objects, with field names you choose. Example: "Volumes[].{id: VolumeId, size: Size}".
- unnest (optional): the name of a row field that holds a list of objects. Each of those objects becomes its own row and keeps its parent's plain fields. Use it for grouped results, because JMESPath cannot reach a parent from inside a nested list.
- x: the field along the horizontal axis (line, bar, area) or the slice name (pie).
- y: a list of numeric fields. Numbers given as strings are converted.
- series (optional, only with a single y): a category field. The rows stay one per x and category; at most 8 categories are kept and the rest are summed into one called "Other".
- agg (stat only): sum, avg, min, max, count or first. Your page does this calculation; the rows are not collapsed for you.
- columns (table only): the fields to show, in order.
- unit (optional): for example "USD", "GB" or "%".

${PAGE_RULES}

An example of the JSON object alone (AWS, daily cost by service). In your reply the html block follows it:
{"title":"Daily cost by service","commandTemplate":"aws ce get-cost-and-usage --time-period Start={{start}},End={{end}} --granularity DAILY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE --output json","period":"LAST_30_DAYS","chartSpec":{"type":"bar","rowsPath":"ResultsByTime[].{date: TimePeriod.Start, groups: Groups[].{service: Keys[0], amount: Metrics.UnblendedCost.Amount}}","unnest":"groups","x":"date","y":["amount"],"series":"service","unit":"USD"}}`;

const draftSchema = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE_CHARS),
  commandTemplate: z.string().trim().min(1).max(MAX_TEMPLATE_CHARS),
  period: z.enum(Object.values(DASHBOARD_PERIODS)),
  chartSpec: chartSpecSchema,
  chartHtml: chartHtmlSchema,
});

const HTML_FENCE = /```html[^\n]*\n([\s\S]*?)```/i;

/**
 * Read the model's final reply as a graph definition: a JSON object, then the
 * page in an html code block.
 *
 * @returns {{ draft: object } | { problem: string } | { declined: string }}
 *   `declined` is a reply with neither in it: the model saying, in words, why
 *   it will not build this graph.
 */
function parseDraft(text) {
  const raw = typeof text === 'string' ? text : '';
  const fenceAt = raw.search(/```html/i);
  const definition = fenceAt === -1 ? raw : raw.slice(0, fenceAt);
  const start = definition.indexOf('{');
  const end = definition.lastIndexOf('}');
  if (start === -1) {
    if (fenceAt !== -1) return { problem: 'the JSON object before the html block is missing' };
    const said = raw.trim();
    return said ? { declined: said } : { problem: 'the reply was empty' };
  }
  if (end <= start) return { problem: 'the reply was not valid JSON' };

  let parsed;
  try {
    parsed = JSON.parse(definition.slice(start, end + 1));
  } catch {
    return { problem: 'the reply was not valid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { problem: 'the reply was not a JSON object' };
  }

  const page = HTML_FENCE.exec(raw);
  if (!page) {
    return {
      problem:
        fenceAt === -1
          ? 'the html code block with the page is missing'
          : 'the html code block was cut off before its closing fence. Write a shorter page',
    };
  }

  const result = draftSchema.safeParse({ ...parsed, chartHtml: page[1] });
  if (!result.success) {
    return {
      problem: result.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; '),
    };
  }
  return { draft: result.data };
}

function authorFailed(detail) {
  const message = ERROR_MESSAGES[ERROR_CODES.DASHBOARD_AUTHOR_FAILED];
  return new AppError(
    422,
    ERROR_CODES.DASHBOARD_AUTHOR_FAILED,
    detail ? `${message} (${detail})` : undefined,
  );
}

/**
 * Build a graph from a plain-language request and run it once.
 *
 * @returns {Promise<{ draft: { title, query, commandTemplate, period, chartSpec, chartHtml },
 *                     command: string, result: object }>} `command` is what ran
 *   for the preview, with real dates.
 * @throws {AppError} 503 when no AI provider is configured, 422 when no working
 *   graph came out of the model's budget.
 */
async function authorWidget({ userId, workspace, credential, credentialUpdatedAt, mode, query }) {
  const providerConfig = await resolveProviderConfig();
  const csp = getCsp(workspace.csp);
  const allowedBinaries = await allowedBinariesForMode(mode);
  const systemPrompt = `${AUTHOR_PROMPT}\n\n${MODE_CONTEXT[mode] ?? ''}\n${providerRulesFor(csp)}`;
  const limits = providerConfig.limits ?? DEFAULT_REQUEST_LIMITS;
  const target = { userId, workspace, credential, credentialUpdatedAt };

  const conversation = [{ role: 'user', content: query }];
  const startedAt = Date.now();
  let specAttempts = 0;
  let lastProblem = null;

  for (let turn = 0; turn < MAX_MODEL_TURNS_PER_MESSAGE; turn += 1) {
    if (Date.now() - startedAt >= MAX_ORCHESTRATION_WALL_CLOCK_MS) break;

    const { history, newMessage } = fitConversation(conversation, limits);
    let reply;
    try {
      reply = await providerConfig.provider.sendMessage({
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

    // 1. A final answer: a graph definition, to be proven by running it.
    if (reply.type === 'text') {
      specAttempts += 1;
      const parsed = parseDraft(reply.content);
      if (parsed.declined) throw authorFailed(parsed.declined.slice(0, 300));

      let problem = parsed.problem;
      if (parsed.draft) {
        const { title, commandTemplate, period, chartSpec } = parsed.draft;
        const run = await runWidget({
          ...target,
          mode,
          title,
          commandTemplate,
          period,
          chartSpec,
          trigger: 'preview',
        });
        if (run.ok) {
          return {
            draft: { ...parsed.draft, query },
            command: run.argv.join(' '),
            result: run.result,
          };
        }
        problem = run.error;
      }

      lastProblem = problem;
      if (specAttempts >= MAX_SPEC_ATTEMPTS) break;
      conversation.push(
        { role: 'assistant', content: reply.content || '(empty reply)' },
        {
          role: 'user',
          content: `That graph definition did not work: ${problem}\nReply with the corrected JSON object and html code block, and nothing else.`,
        },
      );
      continue;
    }

    // 2. The model wants to look at something first.
    const kind = reply.type === 'lookup_request' ? 'LOOKUP_REQUEST' : 'COMMAND_REQUEST';
    const verdict = classify({
      mode,
      csp: workspace.csp,
      commandString: reply.command,
      personaAllowedBinaries: allowedBinaries,
    });
    const commandText =
      verdict.argv.length > 0 ? verdict.argv.join(' ') : String(reply.command ?? '');
    const readOnly =
      verdict.verdict === POLICY_VERDICTS.ALLOW_LOOKUP ||
      verdict.verdict === POLICY_VERDICTS.ALLOW_READONLY;

    let rejection = null;
    if (verdict.verdict === POLICY_VERDICTS.REJECTED) rejection = verdict.reason;
    else if (!readOnly) rejection = READ_ONLY_TEXT;
    else if (reply.regions) rejection = 'the "regions" argument is not available on dashboards';

    conversation.push(toolCallNote(kind, commandText));

    if (rejection) {
      await writeDashboardAudit({
        userId,
        workspaceId: workspace.id,
        action: AUDIT_ACTIONS.DASHBOARD_COMMAND_REJECTED,
        outcome: AUDIT_OUTCOMES.REJECTED,
        metadata: { widgetId: null, trigger: 'preview', command: verdict.argv, reason: rejection },
      });
      conversation.push(
        toolResultNote(kind, `I can't run that: ${rejection}`, 'rejected by policy'),
      );
      continue;
    }

    let execution;
    try {
      execution = await execInDashboardSandbox({ ...target, argv: verdict.argv });
    } catch (err) {
      if (err instanceof SandboxUnavailableError) throw authorFailed(err.message);
      throw err;
    }
    await writeDashboardAudit({
      userId,
      workspaceId: workspace.id,
      action: AUDIT_ACTIONS.DASHBOARD_COMMAND_EXECUTED,
      outcome:
        execution.exitCode === 0 && !execution.timedOut
          ? AUDIT_OUTCOMES.SUCCESS
          : AUDIT_OUTCOMES.FAILURE,
      metadata: {
        widgetId: null,
        trigger: 'preview',
        command: verdict.argv,
        exitCode: execution.exitCode,
        timedOut: execution.timedOut,
      },
    });
    conversation.push(toolResultNote(kind, combineOutput(execution), executionOutcome(execution)));
  }

  throw authorFailed(lastProblem);
}

const REDRAW_PROMPT = `You write the page that draws one graph on an Operator's cloud dashboard in OpenCAI. The graph's data already exists; you only decide how it is drawn.

Your reply must be one \`\`\`html code block holding the page, and nothing else -- no prose, no JSON. No tool is available: do not call one.

${PAGE_RULES}`;

// How many of the graph's rows the model is shown, to learn their shape.
const REDRAW_SAMPLE_ROWS = 8;

/**
 * Write a new page for a graph that already has data. Nothing is run: the
 * model sees the graph's definition and a few of its rows.
 *
 * @returns {Promise<string>} the page.
 * @throws {AppError} 503 when no AI provider is configured, 422 when no usable
 *   page came out of MAX_SPEC_ATTEMPTS replies.
 */
async function redrawPage({ title, query, chartSpec, result }) {
  const providerConfig = await resolveProviderConfig();
  const limits = providerConfig.limits ?? DEFAULT_REQUEST_LIMITS;
  const sample = result.rows.slice(0, REDRAW_SAMPLE_ROWS);
  const conversation = [
    {
      role: 'user',
      content: [
        `Graph title: ${title}`,
        `The Operator asked for: ${query}`,
        `chartSpec: ${JSON.stringify(chartSpec)}`,
        `DATA.columns: ${JSON.stringify(result.columns)}`,
        `DATA.rows has ${result.rows.length} rows. The first ${sample.length}:`,
        JSON.stringify(sample),
      ].join('\n'),
    },
  ];
  let lastProblem = null;

  for (let attempt = 0; attempt < MAX_SPEC_ATTEMPTS; attempt += 1) {
    const { history, newMessage } = fitConversation(conversation, limits);
    let reply;
    try {
      reply = await providerConfig.provider.sendMessage({
        systemPrompt: REDRAW_PROMPT,
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

    const said = reply.type === 'text' ? (reply.content ?? '') : '';
    const page = HTML_FENCE.exec(said);
    if (reply.type !== 'text') {
      lastProblem = 'no tool is available here';
    } else if (!page) {
      lastProblem = 'the html code block is missing or was cut off. Write a shorter page';
    } else {
      const parsed = chartHtmlSchema.safeParse(page[1]);
      if (parsed.success) return parsed.data;
      lastProblem = parsed.error.issues.map((i) => i.message).join('; ');
    }

    conversation.push(
      { role: 'assistant', content: said || '(no page)' },
      {
        role: 'user',
        content: `That page cannot be used: ${lastProblem}\nReply with one html code block and nothing else.`,
      },
    );
  }

  throw authorFailed(lastProblem);
}

module.exports = { authorWidget, redrawPage, parseDraft, MAX_SPEC_ATTEMPTS };
