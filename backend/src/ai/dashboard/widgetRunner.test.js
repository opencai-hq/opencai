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
  // What a command prints once execResults runs out.
  S.defaultStdout = '{}';
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
      stdout: S.defaultStdout,
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
  // The hint is the Workspace provider's own.
  assert.ok(text.error.includes('(AWS: --output json)'), text.error);
});

const SSH_RUN = {
  workspace: { id: 'ws-ssh', csp: 'SSH' },
  credential: { hosts: [{ name: 'web-01', address: '10.0.0.5', port: 22 }] },
  mode: 'CLOUDOPS',
  period: 'NONE',
  chartSpec: { type: 'table', rowsPath: 'blockdevices', columns: ['name'] },
};

test("the not-JSON error names the on-prem provider's own output hint", async () => {
  reset();
  S.allowedBinaries = ['ssh'];
  S.execResults.push(ok('Architecture: x86_64\n'));

  const result = await run({ ...SSH_RUN, commandTemplate: 'ssh web-01 lscpu' });

  assert.equal(result.ok, false);
  assert.match(result.error, /not JSON/);
  assert.match(result.error, /Linux servers \(SSH\): use JSON-capable flags/);
  assert.doesNotMatch(result.error, /--format=json\)/);
});

test('the dashboard classify gets the Workspace cspContext (SSH host names)', async () => {
  reset();
  S.allowedBinaries = ['ssh'];
  S.execResults.push(ok(JSON.stringify({ blockdevices: [{ name: 'sda' }] })));

  const known = await run({ ...SSH_RUN, commandTemplate: 'ssh web-01 lsblk -J' });
  const unknown = await run({ ...SSH_RUN, commandTemplate: 'ssh db-01 lsblk -J' });

  // Without the context there are no hosts, so even web-01 would be refused.
  assert.equal(known.ok, true, JSON.stringify(known));
  assert.deepEqual(S.execCalls[0].argv, ['ssh', 'web-01', '--', "'lsblk'", "'-J'"]);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Unknown host "db-01"; use one of: web-01/);
  assert.equal(S.execCalls.length, 1);
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

// Chains: step 1 lists, every later step runs once per row of the one before.
const LIST_STEP = {
  command: 'aws ec2 describe-instances --output json',
  rowsPath: 'Reservations[].Instances[].{id: InstanceId, name: Name}',
};
const CPU_STEP = {
  command:
    'aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value={{item.id}} --start-time {{start}}T00:00:00Z --end-time {{end}}T00:00:00Z --period 86400 --statistics Average --output json',
  rowsPath: 'Datapoints[].{date: Timestamp, cpu: Average}',
};
const CPU_SPEC = { type: 'line', rowsPath: '[]', x: 'date', y: ['cpu'], series: 'name' };

const instances = (...ids) =>
  JSON.stringify({
    Reservations: [{ Instances: ids.map((id) => ({ InstanceId: id, Name: `web-${id}` })) }],
  });
const cpu = (value) =>
  JSON.stringify({ Datapoints: [{ Timestamp: '2026-10-09', Average: value }] });

function runChain(over = {}) {
  return run({
    commandTemplate: undefined,
    steps: [LIST_STEP, CPU_STEP],
    chartSpec: CPU_SPEC,
    mode: 'CLOUDOPS',
    ...over,
  });
}

test('a chain runs step 2 once per row of step 1 and merges the parent fields into its rows', async () => {
  reset();
  S.execResults.push(ok(instances('i-1', 'i-2')), ok(cpu(10)), ok(cpu(20)));

  const result = await runChain();

  assert.equal(result.ok, true);
  assert.deepEqual(result.result.rows, [
    { date: '2026-10-09', name: 'web-i-1', cpu: 10 },
    { date: '2026-10-09', name: 'web-i-2', cpu: 20 },
  ]);
  assert.equal(S.execCalls.length, 3);
  assert.ok(S.execCalls[1].argv.includes('Name=InstanceId,Value=i-1'));
  assert.ok(S.execCalls[2].argv.includes('Name=InstanceId,Value=i-2'));
  assert.ok(S.execCalls[1].argv.includes('2026-10-04T00:00:00Z'));
  assert.equal(result.commands.length, 3);
  assert.deepEqual(result.argv, S.execCalls[0].argv);
  assert.equal(S.audits.length, 3, 'every command is audited');
});

test('a chain can be longer than two steps', async () => {
  reset();
  const VOLUMES = {
    command:
      'aws ec2 describe-volumes --filters Name=attachment.instance-id,Values={{item.id}} --output json',
    rowsPath: 'Volumes[].{volumeId: VolumeId}',
  };
  const SNAPSHOTS = {
    command:
      'aws ec2 describe-snapshots --filters Name=volume-id,Values={{item.volumeId}} --output json',
    rowsPath: 'Snapshots[].{snapshot: SnapshotId, size: VolumeSize}',
  };
  S.execResults.push(
    ok(instances('i-1')),
    ok(JSON.stringify({ Volumes: [{ VolumeId: 'vol-1' }, { VolumeId: 'vol-2' }] })),
    ok(JSON.stringify({ Snapshots: [{ SnapshotId: 'snap-1', VolumeSize: 8 }] })),
    ok(JSON.stringify({ Snapshots: [{ SnapshotId: 'snap-2', VolumeSize: 16 }] })),
  );

  const result = await runChain({
    steps: [LIST_STEP, VOLUMES, SNAPSHOTS],
    period: 'NONE',
    chartSpec: { type: 'table', rowsPath: '[]', columns: ['name', 'volumeId', 'snapshot', 'size'] },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.result.rows, [
    { name: 'web-i-1', volumeId: 'vol-1', snapshot: 'snap-1', size: 8 },
    { name: 'web-i-1', volumeId: 'vol-2', snapshot: 'snap-2', size: 16 },
  ]);
  assert.ok(S.execCalls[3].argv.includes('Name=volume-id,Values=vol-2'));
});

test('a failing item is skipped and counted; the rest of the graph still draws', async () => {
  reset();
  S.execResults.push(
    ok(instances('i-1', 'i-2')),
    { stdout: '', stderr: 'Throttling', exitCode: 255, timedOut: false },
    ok(cpu(20)),
  );

  const result = await runChain();

  assert.equal(result.ok, true);
  assert.equal(result.result.rows.length, 1);
  assert.equal(result.result.skippedItems, 1);
});

test('a step that fails for every item fails the graph, naming the step', async () => {
  reset();
  S.execResults.push(ok(instances('i-1')), {
    stdout: '',
    stderr: 'AccessDenied',
    exitCode: 254,
    timedOut: false,
  });

  const result = await runChain();

  assert.equal(result.ok, false);
  assert.match(result.error, /^Step 2: it failed for every item.*AccessDenied/);
});

test('an item whose value is not safe to put in a command is skipped, never run', async () => {
  reset();
  S.execResults.push(
    ok(
      JSON.stringify({
        Reservations: [{ Instances: [{ InstanceId: 'i-1 --debug' }, { InstanceId: 'i-2' }] }],
      }),
    ),
    ok(cpu(5)),
  );

  const result = await runChain();

  assert.equal(result.ok, true);
  assert.equal(result.result.skippedItems, 1);
  assert.equal(S.execCalls.length, 2);
  assert.ok(!S.execCalls.some((c) => c.argv.includes('--debug')));
});

test('a mutating later step is refused by the policy and never runs', async () => {
  reset();
  S.execResults.push(ok(instances('i-1', 'i-2')));

  const result = await runChain({
    steps: [
      LIST_STEP,
      { command: 'aws ec2 terminate-instances --instance-ids {{item.id}}', rowsPath: '@' },
    ],
    period: 'NONE',
    chartSpec: { type: 'table', rowsPath: '[]' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.rejected, true);
  assert.match(result.error, /^Step 2: The command was not run/);
  assert.equal(S.execCalls.length, 1, 'only the listing ran');
  assert.equal(S.audits.at(-1).action, AUDIT_ACTIONS.DASHBOARD_COMMAND_REJECTED);
});

test('a step runs for at most 25 items, and the result says it was cut short', async () => {
  reset();
  const ids = Array.from({ length: 30 }, (_, i) => `i-${i}`);
  S.execResults.push(ok(instances(...ids)));
  S.defaultStdout = cpu(1);

  const result = await runChain({ chartSpec: { ...CPU_SPEC, series: undefined } });

  assert.equal(result.ok, true);
  assert.equal(S.execCalls.length, 1 + 25);
  assert.equal(result.result.truncated, true);
});

test('a chain stops at 60 commands in all', async () => {
  reset();
  // Four steps of 1 + 25 + 25 + 25 commands would be 76.
  const ids = Array.from({ length: 25 }, (_, i) => `i-${i}`);
  const next = (command, field) => ({
    command: `${command} --filters Name=x,Values={{item.${field}}} --output json`,
    rowsPath: 'Items[].{key: Key}',
  });
  S.execResults.push(ok(instances(...ids)));
  S.defaultStdout = JSON.stringify({ Items: [{ Key: 'k-1' }] });

  const result = await runChain({
    steps: [
      LIST_STEP,
      next('aws ec2 describe-volumes', 'id'),
      next('aws ec2 describe-snapshots', 'key'),
      next('aws ec2 describe-images', 'key'),
    ],
    period: 'NONE',
    chartSpec: { type: 'table', rowsPath: '[]' },
  });

  assert.equal(result.ok, true);
  assert.equal(S.execCalls.length, 60);
  assert.equal(result.commands.length, 60);
  assert.equal(result.result.truncated, true);
});

test('a step 1 that fails names the step', async () => {
  reset();
  S.execResults.push({ stdout: '', stderr: 'nope', exitCode: 1, timedOut: false });

  const result = await runChain();

  assert.match(result.error, /^Step 1: The command failed/);
});

test('live progress: each command is reported as it runs, and chain items by step and count', async () => {
  const { withProgress } = require('../../realtime/progress');
  reset();
  S.execResults.push(ok(instances('i-1', 'i-2')), ok(cpu(10)), ok(cpu(20)));

  const statuses = [];
  const result = await withProgress(
    (event) => statuses.push(event.text),
    () => runChain(),
  );

  assert.equal(result.ok, true);
  assert.match(statuses[0], /^Running aws ec2 describe-instances/);
  assert.deepEqual(statuses.slice(1), ['Step 2 of 2: item 1 of 2', 'Step 2 of 2: item 2 of 2']);
});

test('provider hooks: the dashboard exec uses the transformed argv, the audit keeps the plain one', async () => {
  reset();
  const provider = require('../csp').getCsp('AWS');
  provider.toExecArgv = (argv) => [...argv, 'X'];
  try {
    S.execResults.push(ok(COST_OUTPUT));
    const result = await run();
    assert.equal(result.ok, true);
    assert.equal(S.execCalls[0].argv.at(-1), 'X');
    assert.notEqual(result.argv.at(-1), 'X');
    assert.deepEqual(S.execCalls[0].argv.slice(0, -1), result.argv);
  } finally {
    delete provider.toExecArgv;
  }
});
