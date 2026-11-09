const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// The model, the database and the sandbox are stubbed before widgetAuthor.js
// loads them (same require.cache injection as orchestrator.test.js). The
// command policy and the widget runner are the real ones.
function inject(request, exports) {
  const resolved = require.resolve(request);
  require.cache[resolved] = new Module(resolved, null);
  require.cache[resolved].filename = resolved;
  require.cache[resolved].loaded = true;
  require.cache[resolved].exports = exports;
}

const S = {};

function reset() {
  S.settings = {
    provider: 'ANTHROPIC',
    providerApiKeyEncrypted: 'enc-key',
    model: 'claude-test',
    sandboxCommandTimeoutSeconds: 60,
    sandboxIdleTimeoutMinutes: 30,
  };
  S.providerResponses = [];
  S.providerCalls = [];
  S.execResults = [];
  S.execCalls = [];
  S.audits = [];
}

inject('../../config/db', {
  chatSettings: { findFirst: async () => S.settings },
  auditLog: {
    async create({ data }) {
      S.audits.push(data);
      return data;
    },
  },
});
inject('../../crypto/envelope', { decrypt: (value) => `decrypted:${value}` });
inject('../providers', {
  getProvider: () => ({
    async sendMessage(args) {
      S.providerCalls.push(args);
      const next = S.providerResponses.shift();
      if (!next) return { type: 'text', content: 'I cannot build that graph.' };
      if (next instanceof Error) throw next;
      return next;
    },
  }),
});
inject('../systemPrompt.service', { allowedBinariesForMode: async () => ['aws', 'az', 'gcloud'] });
inject('../sandbox/sandboxManager', {
  async executeInSandbox(containerId, argv) {
    S.execCalls.push(argv);
    return S.execResults.shift() ?? { stdout: '{}', stderr: '', exitCode: 0, timedOut: false };
  },
});
inject('../sandbox/dashboardSandboxPool', {
  acquire: async () => ({ containerId: 'cid-1', env: {} }),
  release: async () => {},
});

const { authorWidget, redrawPage, parseDraft, MAX_SPEC_ATTEMPTS } = require('./widgetAuthor');
const { EXAMPLE_PAGE } = require('./pagePrompt');
const { chartHtmlProblem } = require('./chartHtml');
const { MAX_CHART_HTML_CHARS } = require('../../constants/dashboard');
const { ERROR_CODES } = require('../../constants/errors');
const { AUDIT_ACTIONS } = require('../../constants/auditActions');

const PAGE = `<svg id="c" viewBox="0 0 600 260" width="100%" height="100%"></svg>
<script>
  const points = DATA.rows.map((row) => row.amount);
  document.getElementById('c').dataset.count = points.length;
</script>`;
const DEFINITION = {
  title: 'Daily cost',
  commandTemplate:
    'aws ce get-cost-and-usage --time-period Start={{start}},End={{end}} --granularity DAILY --metrics UnblendedCost --output json',
  period: 'LAST_30_DAYS',
  chartSpec: {
    type: 'line',
    rowsPath: 'ResultsByTime[].{date: TimePeriod.Start, amount: Total.UnblendedCost.Amount}',
    x: 'date',
    y: ['amount'],
    unit: 'USD',
  },
};
const DRAFT = { ...DEFINITION, chartHtml: PAGE };
const FENCE = '```';
const reply = (definition, page = PAGE) =>
  `${JSON.stringify(definition)}\n${FENCE}html\n${page}\n${FENCE}`;
const COST_OUTPUT = JSON.stringify({
  ResultsByTime: [
    { TimePeriod: { Start: '2026-10-09' }, Total: { UnblendedCost: { Amount: '6' } } },
  ],
});

const text = (content) => ({ type: 'text', content });
const spec = (over = {}) => text(reply({ ...DEFINITION, ...over }));
const ok = (stdout) => ({ stdout, stderr: '', exitCode: 0, timedOut: false });

function author(over = {}) {
  return authorWidget({
    userId: 'user-1',
    workspace: { id: 'ws-1', csp: 'AWS' },
    credential: { accessKeyId: 'AKIATEST', secretAccessKey: 'secret' },
    credentialUpdatedAt: new Date('2026-01-01T00:00:00Z'),
    mode: 'FINOPS',
    query: 'daily cost for the last 30 days',
    ...over,
  });
}

const authorFailed = (pattern) => (err) =>
  err.status === 422 &&
  err.code === ERROR_CODES.DASHBOARD_AUTHOR_FAILED &&
  pattern.test(err.message);

test('parseDraft: reads the definition and the page, with or without prose around them', () => {
  assert.deepEqual(parseDraft(reply(DEFINITION)).draft, DRAFT);
  assert.deepEqual(parseDraft(`Here is the graph:\n${reply(DEFINITION)}\nDone.`).draft, DRAFT);
  assert.deepEqual(
    parseDraft(
      `${FENCE}json\n${JSON.stringify(DEFINITION)}\n${FENCE}\n${FENCE}html\n${PAGE}\n${FENCE}`,
    ).draft,
    DRAFT,
  );
});

test('parseDraft: braces in the page are not mistaken for the definition', () => {
  const page =
    '<script>const total = DATA.rows.reduce((sum, row) => { return sum + row.amount; }, 0);</script>';
  assert.equal(parseDraft(reply(DEFINITION, page)).draft.chartHtml, page);
});

test('parseDraft: reports what is wrong with a definition', () => {
  assert.match(parseDraft('{"title": ').problem, /not valid JSON/);
  assert.match(parseDraft('').problem, /empty/);
  assert.match(parseDraft(reply({ ...DEFINITION, period: 'YESTERDAY' })).problem, /period/);
  assert.match(
    parseDraft(reply({ ...DEFINITION, chartSpec: { type: 'line', rowsPath: 'a' } })).problem,
    /needs "x" and "y"/,
  );
  assert.equal(
    parseDraft('That cannot be shown as a graph.').declined,
    'That cannot be shown as a graph.',
  );
});

test('parseDraft: reports what is wrong with the page', () => {
  const json = JSON.stringify(DEFINITION);
  assert.match(parseDraft(json).problem, /html code block with the page is missing/);
  assert.match(parseDraft(`${json}\n${FENCE}html\n<svg>`).problem, /cut off/);
  assert.match(parseDraft(`${FENCE}html\n${PAGE}\n${FENCE}`).problem, /JSON object before/);
  assert.match(parseDraft(reply(DEFINITION, '<svg></svg>')).problem, /chartHtml: .*no <script>/);
  assert.match(
    parseDraft(
      reply(
        DEFINITION,
        '<script src="https://cdn.example.com/chart.js"></script><script>DATA</script>',
      ),
    ).problem,
    /external address/,
  );
});

test('a working definition is run once and returned with the command that ran', async () => {
  reset();
  S.providerResponses.push(spec());
  S.execResults.push(ok(COST_OUTPUT));

  const result = await author();

  assert.deepEqual(result.draft, { ...DRAFT, query: 'daily cost for the last 30 days' });
  assert.deepEqual(result.result.rows, [{ date: '2026-10-09', amount: 6 }]);
  assert.match(
    result.command,
    /^aws ce get-cost-and-usage --time-period Start=\d{4}-\d{2}-\d{2},End=/,
  );
  assert.equal(S.providerCalls.length, 1);
  assert.equal(S.execCalls.length, 1);
  assert.equal(S.audits[0].metadata.trigger, 'preview');
});

test('the system prompt carries the graph contract and the provider rule, not a persona', async () => {
  reset();
  S.providerResponses.push(spec());
  S.execResults.push(ok(COST_OUTPUT));

  await author();

  const { systemPrompt, apiKey, model } = S.providerCalls[0];
  assert.match(systemPrompt, /one JSON object, then one ```html code block/);
  assert.ok(
    systemPrompt.includes(`Today's date is ${new Date().toISOString().slice(0, 10)} (UTC).`),
  );
  assert.match(systemPrompt, /DATA = \{ rows/);
  assert.match(systemPrompt, /no network/);
  assert.match(systemPrompt, /smooth curve/);
  assert.match(systemPrompt, /\{\{start\}\}/);
  assert.match(systemPrompt, /FinOps dashboard/);
  assert.match(systemPrompt, /The only CLI available is "aws"/);
  assert.equal(apiKey, 'decrypted:enc-key');
  assert.equal(model, 'claude-test');
});

test('the model can look at real output first, then define the graph', async () => {
  reset();
  S.providerResponses.push(
    {
      type: 'command_request',
      command:
        'aws ce get-cost-and-usage --time-period Start=2026-10-01,End=2026-10-02 --granularity DAILY --metrics UnblendedCost --output json',
    },
    spec(),
  );
  S.execResults.push(ok(COST_OUTPUT), ok(COST_OUTPUT));

  const result = await author();

  assert.equal(result.result.rows.length, 1);
  assert.equal(S.execCalls.length, 2);
  // The second call sees the first command and its output as notes.
  const second = S.providerCalls[1];
  assert.match(second.history.at(-1).content, /^\(called run_command: aws ce get-cost-and-usage/);
  assert.match(second.newMessage, /^\(run_command result\)/);
  assert.match(second.newMessage, /ResultsByTime/);
});

test('a mutating command the model asks for is refused, never run, and audited', async () => {
  reset();
  S.providerResponses.push(
    {
      type: 'command_request',
      command: 'aws ec2 terminate-instances --instance-ids i-123',
      explanation: 'Stop the idle instances',
    },
    spec(),
  );
  S.execResults.push(ok(COST_OUTPUT));

  await author({ query: 'stop all idle instances as a graph' });

  assert.equal(S.execCalls.length, 1, 'only the final read-only command ran');
  assert.ok(!S.execCalls.flat().includes('terminate-instances'));
  assert.match(S.providerCalls[1].newMessage, /^\(run_command rejected by policy\)/);
  assert.match(S.providerCalls[1].newMessage, /read-only/);
  assert.equal(S.audits[0].action, AUDIT_ACTIONS.DASHBOARD_COMMAND_REJECTED);
});

test('a multi-region request is refused on dashboards', async () => {
  reset();
  S.providerResponses.push(
    { type: 'command_request', command: 'aws ec2 describe-instances', regions: ['all'] },
    spec(),
  );
  S.execResults.push(ok(COST_OUTPUT));

  await author();

  assert.equal(S.execCalls.length, 1);
  assert.match(S.providerCalls[1].newMessage, /"regions" argument is not available/);
});

test('a definition that fails when run goes back to the model to fix', async () => {
  reset();
  S.providerResponses.push(
    spec({ chartSpec: { ...DRAFT.chartSpec, rowsPath: 'Wrong[].{date: a, amount: b}' } }),
    spec(),
  );
  S.execResults.push(ok(COST_OUTPUT), ok(COST_OUTPUT));

  const result = await author();

  assert.equal(result.result.rows.length, 1);
  assert.equal(S.providerCalls.length, 2);
  assert.match(S.providerCalls[1].newMessage, /did not work: "rowsPath" did not return a list/);
  assert.match(S.providerCalls[1].newMessage, /corrected JSON object and html code block/);
});

test('a definition with a fixed date is sent back without running anything', async () => {
  reset();
  S.providerResponses.push(
    spec({
      commandTemplate:
        'aws ce get-cost-and-usage --time-period Start=2026-09-01,End=2026-10-01 --granularity DAILY --metrics UnblendedCost --output json',
    }),
    spec(),
  );
  S.execResults.push(ok(COST_OUTPUT));

  await author();

  assert.equal(S.execCalls.length, 1);
  assert.match(S.providerCalls[1].newMessage, /fixed date|must take its dates/);
});

test('a final definition whose command is mutating is refused and never run', async () => {
  reset();
  const mutating = spec({
    commandTemplate: 'aws ec2 stop-instances --instance-ids i-123 --output json',
    period: 'NONE',
    chartSpec: { type: 'table', rowsPath: 'StoppingInstances' },
  });
  S.providerResponses.push(mutating, mutating, mutating);

  await assert.rejects(author(), authorFailed(/read-only/));

  assert.equal(S.execCalls.length, 0);
  assert.equal(S.providerCalls.length, MAX_SPEC_ATTEMPTS);
});

test('gives up after MAX_SPEC_ATTEMPTS definitions, with the last reason', async () => {
  reset();
  const broken = text('{"title": "x"');
  S.providerResponses.push(broken, broken, broken, spec());

  await assert.rejects(author(), authorFailed(/not valid JSON/));

  assert.equal(S.providerCalls.length, MAX_SPEC_ATTEMPTS);
});

test('gives up when the model only ever explores', async () => {
  reset();
  for (let i = 0; i < 20; i += 1) {
    S.providerResponses.push({ type: 'command_request', command: 'aws ec2 describe-instances' });
  }

  await assert.rejects(author(), authorFailed(/could not be built/));

  assert.equal(S.providerCalls.length, 8);
});

test('a reply in words is passed on as the reason no graph was built', async () => {
  reset();
  S.providerResponses.push(text('Stopping instances changes resources, so it cannot be a graph.'));

  await assert.rejects(author(), authorFailed(/Stopping instances changes resources/));
});

test('no AI provider configured is a 503 before anything runs', async () => {
  reset();
  S.settings = { provider: null };

  await assert.rejects(
    author(),
    (err) => err.status === 503 && err.code === ERROR_CODES.AI_PROVIDER_NOT_CONFIGURED,
  );
  assert.equal(S.providerCalls.length, 0);
});

test('a provider rate limit is passed on as a 429', async () => {
  reset();
  S.providerResponses.push(Object.assign(new Error('slow down'), { status: 429 }));

  await assert.rejects(
    author(),
    (err) => err.status === 429 && err.code === ERROR_CODES.AI_PROVIDER_RATE_LIMITED,
  );
});

/* ---- redraw -------------------------------------------------------------- */

const REDRAW = {
  title: 'Daily cost',
  query: 'daily cost for the last 30 days',
  chartSpec: DEFINITION.chartSpec,
  result: {
    columns: ['date', 'amount'],
    rows: Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${i + 1}`, amount: i })),
  },
};
const pageReply = (page = PAGE) => text(`${FENCE}html\n${page}\n${FENCE}`);

test('the example page in the prompt is itself a page that would be accepted', () => {
  assert.equal(chartHtmlProblem(EXAMPLE_PAGE), null);
  assert.ok(EXAMPLE_PAGE.length < MAX_CHART_HTML_CHARS);
});

test('redrawPage: returns the page, having shown the model the definition and a few rows', async () => {
  reset();
  S.providerResponses.push(pageReply());

  const page = await redrawPage(REDRAW);

  assert.equal(page, PAGE);
  assert.equal(S.execCalls.length, 0);
  const { systemPrompt, newMessage } = S.providerCalls[0];
  assert.match(systemPrompt, /one ```html code block holding the page/);
  assert.match(systemPrompt, /smooth curve/);
  assert.match(systemPrompt, /tooltip/);
  assert.match(newMessage, /The Operator asked for: daily cost for the last 30 days/);
  assert.match(newMessage, /DATA.rows has 30 rows. The first 8:/);
  assert.ok(!newMessage.includes('2026-09-9"'), 'only the first rows are sent');
});

test('redrawPage: an unusable reply goes back to the model, then it gives up', async () => {
  reset();
  S.providerResponses.push(
    pageReply('<svg></svg>'),
    { type: 'command_request', command: 'aws ec2 describe-instances' },
    pageReply(),
  );

  assert.equal(await redrawPage(REDRAW), PAGE);
  assert.match(S.providerCalls[1].newMessage, /cannot be used: .*no <script>/);
  assert.match(S.providerCalls[2].newMessage, /no tool is available/);
  assert.equal(S.execCalls.length, 0);

  reset();
  S.providerResponses.push(text('Sure!'), text('Sure!'), text('Sure!'), pageReply());
  await assert.rejects(redrawPage(REDRAW), authorFailed(/html code block is missing/));
  assert.equal(S.providerCalls.length, MAX_SPEC_ATTEMPTS);
});

const CHAIN = {
  title: 'CPU by instance',
  steps: [
    {
      command: 'aws ec2 describe-instances --output json',
      rowsPath: 'Reservations[].Instances[].{id: InstanceId}',
    },
    {
      command:
        'aws cloudwatch get-metric-statistics --dimensions Name=InstanceId,Value={{item.id}} --start-time {{start}}T00:00:00Z --end-time {{end}}T00:00:00Z --output json',
      rowsPath: 'Datapoints[].{date: Timestamp, cpu: Average}',
    },
  ],
  period: 'LAST_7_DAYS',
  chartSpec: { type: 'line', rowsPath: '[]', x: 'date', y: ['cpu'], series: 'id', unit: '%' },
};

test('parseDraft: reads a chain, keeping its first command as the graph command', () => {
  const { draft } = parseDraft(reply(CHAIN));
  assert.deepEqual(draft.steps, CHAIN.steps);
  assert.equal(draft.commandTemplate, CHAIN.steps[0].command);
});

test('parseDraft: a definition has a command or a chain, and a chain is at most 5 steps', () => {
  assert.match(
    parseDraft(reply({ ...CHAIN, commandTemplate: 'aws ec2 describe-volumes' })).problem,
    /either "commandTemplate" or "steps"/,
  );
  const { steps, ...noCommand } = CHAIN;
  assert.ok(steps);
  assert.match(parseDraft(reply(noCommand)).problem, /either "commandTemplate" or "steps"/);
  assert.match(
    parseDraft(reply({ ...CHAIN, steps: Array(6).fill(CHAIN.steps[1]) })).problem,
    /steps/,
  );
  assert.match(
    parseDraft(reply({ ...CHAIN, steps: [CHAIN.steps[0], { command: 'aws ec2 x {{item.id}}' }] }))
      .problem,
    /rowsPath/,
  );
});

test('a chained definition runs every step and returns every command that ran', async () => {
  reset();
  S.providerResponses.push(text(reply(CHAIN)));
  S.execResults.push(
    ok(
      JSON.stringify({
        Reservations: [{ Instances: [{ InstanceId: 'i-1' }, { InstanceId: 'i-2' }] }],
      }),
    ),
    ok(JSON.stringify({ Datapoints: [{ Timestamp: '2026-10-09', Average: 12 }] })),
    ok(JSON.stringify({ Datapoints: [{ Timestamp: '2026-10-09', Average: 30 }] })),
  );

  const result = await author({ mode: 'CLOUDOPS', query: 'cpu per instance' });

  assert.deepEqual(result.draft.steps, CHAIN.steps);
  assert.equal(result.commands.length, 3);
  assert.match(result.commands[1], /Value=i-1 /);
  assert.match(result.commands[2], /Value=i-2 /);
  assert.equal(result.command, result.commands[0]);
  assert.deepEqual(result.result.rows, [
    { date: '2026-10-09', id: 'i-1', cpu: 12 },
    { date: '2026-10-09', id: 'i-2', cpu: 30 },
  ]);
});

test('a chain whose later step is wrong goes back to the model with the step named', async () => {
  reset();
  const broken = {
    ...CHAIN,
    steps: [CHAIN.steps[0], { ...CHAIN.steps[1], rowsPath: 'Nothing[]' }],
  };
  S.providerResponses.push(text(reply(broken)), text(reply(CHAIN)));
  S.execResults.push(
    ok(JSON.stringify({ Reservations: [{ Instances: [{ InstanceId: 'i-1' }] }] })),
  );

  await author({ mode: 'CLOUDOPS', query: 'cpu per instance' }).catch(() => {});

  assert.match(S.providerCalls[1].newMessage, /Step 2: it failed for every item/);
});

test('live progress: the Operator sees each look, each try and why a try failed', async () => {
  const { withProgress } = require('../../realtime/progress');
  reset();
  S.providerResponses.push(
    { type: 'command_request', command: 'aws ce get-cost-and-usage --output json' },
    spec({ chartSpec: { type: 'line', rowsPath: 'Nothing', x: 'date', y: ['amount'] } }),
    spec(),
  );
  S.execResults.push(ok(COST_OUTPUT), ok(COST_OUTPUT), ok(COST_OUTPUT));

  const statuses = [];
  await withProgress(
    (event) => statuses.push(event.text),
    () => author(),
  );

  assert.equal(statuses[0], 'Asking the AI');
  assert.match(statuses[1], /^Looking at aws ce get-cost-and-usage/);
  assert.ok(statuses.includes('Testing the graph'));
  assert.ok(
    statuses.some((text) => /^That graph didn't work \(try 1 of 3\): .*rowsPath/.test(text)),
  );
});

test('authorWidget: the JSON-output line names the Workspace provider flag', async () => {
  reset();
  await author({
    workspace: { id: 'ws-1', csp: 'KUBERNETES' },
    credential: {},
    mode: 'CLOUDOPS',
  }).catch(() => {});
  const { systemPrompt } = S.providerCalls[0];
  assert.ok(systemPrompt.includes('It must print JSON (Kubernetes: add -o json)'));
  assert.ok(!systemPrompt.includes('AWS and Azure: --output json'));
});
