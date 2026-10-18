const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// The database, the sandbox and the pool are stubbed before widgetRunner.js
// loads them (same require.cache injection as orchestrator.test.js). The
// command policy is the real one: what this file is about is that nothing the
// policy does not call read-only ever reaches the sandbox.
function inject(request, exports) {
  const resolved = require.resolve(request);
  require.cache[resolved] = new Module(resolved, null);
  require.cache[resolved].filename = resolved;
  require.cache[resolved].loaded = true;
  require.cache[resolved].exports = exports;
}

const S = {};

function reset() {
  S.settings = { sandboxCommandTimeoutSeconds: 45, provider: null };
  S.audits = [];
  S.execCalls = [];
  S.execResults = [];
  S.acquireCalls = [];
  S.acquireErrors = [];
  S.released = [];
  S.allowedBinaries = ['aws', 'az', 'gcloud'];
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
inject('../systemPrompt.service', { allowedBinariesForMode: async () => S.allowedBinaries });
inject('../sandbox/sandboxManager', {
  async executeInSandbox(containerId, argv, options) {
    S.execCalls.push({ containerId, argv, options });
    const next = S.execResults.shift() ?? {
      stdout: '{}',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    };
    if (next instanceof Error) throw next;
    return next;
  },
});
inject('../sandbox/dashboardSandboxPool', {
  async acquire(args) {
    S.acquireCalls.push(args);
    const err = S.acquireErrors.shift();
    if (err) throw err;
    return { containerId: 'cid-1', env: { AWS_ACCESS_KEY_ID: 'AKIATEST' } };
  },
  async release(userId, workspaceId) {
    S.released.push(`${userId}:${workspaceId}`);
  },
});

const { runWidget } = require('./widgetRunner');
const { AUDIT_ACTIONS, AUDIT_OUTCOMES } = require('../../constants/auditActions');

const NOW = new Date('2026-10-10T12:00:00Z');
const COST_TEMPLATE =
  'aws ce get-cost-and-usage --time-period Start={{start}},End={{end}} --granularity DAILY --metrics UnblendedCost --output json';
const COST_SPEC = {
  type: 'line',
  rowsPath: 'ResultsByTime[].{date: TimePeriod.Start, amount: Total.UnblendedCost.Amount}',
  x: 'date',
  y: ['amount'],
};
const COST_OUTPUT = JSON.stringify({
  ResultsByTime: [
    { TimePeriod: { Start: '2026-10-08' }, Total: { UnblendedCost: { Amount: '4.5' } } },
    { TimePeriod: { Start: '2026-10-09' }, Total: { UnblendedCost: { Amount: '6' } } },
  ],
});

function run(over = {}) {
  return runWidget({
    userId: 'user-1',
    workspace: { id: 'ws-1', csp: 'AWS' },
    credential: { accessKeyId: 'AKIATEST', secretAccessKey: 'secret' },
    credentialUpdatedAt: new Date('2026-01-01T00:00:00Z'),
    mode: 'FINOPS',
    commandTemplate: COST_TEMPLATE,
    period: 'LAST_7_DAYS',
    chartSpec: COST_SPEC,
    trigger: 'refresh',
    widgetId: 'w-1',
    now: NOW,
    ...over,
  });
}

const ok = (stdout) => ({ stdout, stderr: '', exitCode: 0, timedOut: false });

test('runs the command with its dates filled in and returns chart rows', async () => {
  reset();
  S.execResults.push(ok(COST_OUTPUT));

  const result = await run();

  assert.equal(result.ok, true);
  assert.deepEqual(result.result.rows, [
    { date: '2026-10-08', amount: 4.5 },
    { date: '2026-10-09', amount: 6 },
  ]);
  assert.equal(S.execCalls.length, 1);
  const { argv, options, containerId } = S.execCalls[0];
  assert.equal(containerId, 'cid-1');
  assert.ok(Array.isArray(argv), 'the command is executed as an argv array');
  assert.ok(argv.includes('Start=2026-10-04,End=2026-10-11'));
  assert.ok(!argv.join(' ').includes('{{'));
  assert.equal(options.timeoutSeconds, 45);
  assert.deepEqual(result.argv, argv);
});

test('works when no AI provider is configured, and with no ChatSettings row at all', async () => {
  reset();
  S.settings = null;
  S.execResults.push(ok(COST_OUTPUT));

  const result = await run();

  assert.equal(result.ok, true);
  assert.equal(S.execCalls[0].options.timeoutSeconds, 60);
});

test('audits an executed command against the Workspace, with no chat session', async () => {
  reset();
  S.execResults.push(ok(COST_OUTPUT));

  await run();

  assert.equal(S.audits.length, 1);
  const audit = S.audits[0];
  assert.equal(audit.action, AUDIT_ACTIONS.DASHBOARD_COMMAND_EXECUTED);
  assert.equal(audit.outcome, AUDIT_OUTCOMES.SUCCESS);
  assert.equal(audit.actorUserId, 'user-1');
  assert.equal(audit.workspaceId, 'ws-1');
  assert.equal(audit.chatSessionId, null);
  assert.equal(audit.metadata.widgetId, 'w-1');
  assert.equal(audit.metadata.trigger, 'refresh');
  assert.deepEqual(audit.metadata.command, S.execCalls[0].argv);
  assert.equal(audit.metadata.exitCode, 0);
});

const NEVER_RUN = [
  ['a mutating command', 'aws ec2 terminate-instances --instance-ids i-123', /read-only/],
  [
    'a mutating command that takes dates',
    'aws ec2 create-snapshot --description {{start}}',
    /read-only/,
  ],
  ['a help lookup', 'aws ec2 help', /not run/],
  ['a pipe', 'aws ec2 describe-instances | cat', /not run/],
  ['a second command', 'aws ec2 describe-instances ; aws ec2 terminate-instances', /not run/],
  ['command substitution', 'aws ec2 describe-instances --filters $(whoami)', /not run/],
  ['another provider CLI', 'gcloud compute instances list --format=json', /not run/],
  ['an unknown binary', 'curl https://example.com', /not run/],
];

for (const [label, commandTemplate, expected] of NEVER_RUN) {
  test(`never executes ${label}`, async () => {
    reset();
    const period = commandTemplate.includes('{{') ? 'LAST_7_DAYS' : 'NONE';

    const result = await run({
      commandTemplate,
      period,
      chartSpec: { type: 'table', rowsPath: '@' },
    });

    assert.equal(result.ok, false);
    assert.equal(result.rejected, true);
    assert.match(result.error, expected);
    assert.equal(S.execCalls.length, 0);
    assert.equal(S.acquireCalls.length, 0, 'no sandbox is even prepared');
    assert.equal(S.audits.length, 1);
    assert.equal(S.audits[0].action, AUDIT_ACTIONS.DASHBOARD_COMMAND_REJECTED);
    assert.equal(S.audits[0].outcome, AUDIT_OUTCOMES.REJECTED);
  });
}

test('never executes a binary the mode does not allow', async () => {
  reset();
  S.allowedBinaries = [];

  const result = await run();

  assert.equal(result.rejected, true);
  assert.equal(S.execCalls.length, 0);
});

test('a template that cannot be rendered is refused before the policy or the sandbox', async () => {
  reset();

  const fixedDate = await run({
    commandTemplate: 'aws ce get-cost-and-usage --time-period Start=2026-09-01,End={{end}}',
  });
  const unknown = await run({ commandTemplate: 'aws ce get-cost-and-usage {{start}} {{evil}}' });

  assert.match(fixedDate.error, /fixed date/);
  assert.match(unknown.error, /only placeholders/);
  assert.equal(S.execCalls.length, 0);
  assert.equal(S.audits.length, 0);
});

test('an invalid chart definition is refused before anything runs', async () => {
  reset();

  const result = await run({ chartSpec: { type: 'line', rowsPath: 'a' } });

  assert.equal(result.ok, false);
  assert.match(result.error, /chart definition is not valid/);
  assert.equal(S.execCalls.length, 0);
});

test('a failing command reports its sanitized error output', async () => {
  reset();
  S.execResults.push({
    stdout: '',
    stderr: 'An error occurred (AccessDenied) for key AKIAABCDEFGHIJKLMNOP',
    exitCode: 254,
    timedOut: false,
  });

  const result = await run();

  assert.equal(result.ok, false);
  assert.match(result.error, /exit code 254/);
  assert.match(result.error, /AccessDenied/);
  assert.ok(!result.error.includes('AKIAABCDEFGHIJKLMNOP'), 'key ids are redacted');
  assert.equal(S.audits[0].outcome, AUDIT_OUTCOMES.FAILURE);
});

test('a timed-out command is a failure', async () => {
  reset();
  S.execResults.push({ stdout: '', stderr: '', exitCode: null, timedOut: true });

  const result = await run();

  assert.deepEqual(result, { ok: false, error: 'The command timed out.' });
  assert.equal(S.audits[0].outcome, AUDIT_OUTCOMES.FAILURE);
});

test('output that is not JSON, or was cut off, is a failure', async () => {
  reset();
  S.execResults.push(ok('i-123\trunning\n'));
  S.execResults.push(ok(`${COST_OUTPUT.slice(0, 40)}\n[... output truncated ...]`));

  const text = await run();
  const truncated = await run();

  assert.match(text.error, /not JSON/);
  assert.match(truncated.error, /not JSON/);
});

test('only stdout is parsed: warnings on stderr do not break a graph', async () => {
  reset();
  S.execResults.push({
    stdout: COST_OUTPUT,
    stderr: 'WARNING: something',
    exitCode: 0,
    timedOut: false,
  });

  const result = await run();

  assert.equal(result.ok, true);
});

test('output that does not fit the chart definition is a failure with a usable reason', async () => {
  reset();
  S.execResults.push(ok(JSON.stringify({ Other: [] })));

  const result = await run();

  assert.equal(result.ok, false);
  assert.match(result.error, /rowsPath/);
});

test('a sandbox that fails once is replaced and the command retried', async () => {
  reset();
  S.execResults.push(new Error('no such container'), ok(COST_OUTPUT));

  const result = await run();

  assert.equal(result.ok, true);
  assert.deepEqual(S.released, ['user-1:ws-1']);
  assert.equal(S.acquireCalls.length, 2);
});

test('a sandbox that cannot be started is a failure, not an exception', async () => {
  reset();
  S.acquireErrors.push(new Error('no such image'), new Error('no such image'));

  const result = await run();

  assert.equal(result.ok, false);
  assert.match(result.error, /execution environment/);
  assert.equal(S.execCalls.length, 0);
});

test('a failed sign-in is reported as a credential problem and not retried', async () => {
  reset();
  S.acquireErrors.push(Object.assign(new Error('Azure sign-in exited 1'), { signInFailed: true }));

  const result = await run();

  assert.match(result.error, /sign in to the cloud provider/);
  assert.equal(S.acquireCalls.length, 1);
});
