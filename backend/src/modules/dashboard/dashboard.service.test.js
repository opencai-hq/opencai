const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// The database, the widget runner and the graph author are stubbed before the
// service loads them (same require.cache injection as orchestrator.test.js).
// Workspace access is the real code, on top of the stubbed database.
function inject(request, exports) {
  const resolved = require.resolve(request);
  require.cache[resolved] = new Module(resolved, null);
  require.cache[resolved].filename = resolved;
  require.cache[resolved].loaded = true;
  require.cache[resolved].exports = exports;
}

const S = {};
let idCounter = 0;

const SPEC = { type: 'line', rowsPath: 'rows', x: 'date', y: ['amount'] };
const PAGE = '<svg id="c"></svg><script>DATA.rows.length</script>';
const NEW_PAGE = '<svg id="c"></svg><script>DATA.rows.map(String)</script>';
const TEMPLATE =
  'aws ce get-cost-and-usage --time-period Start={{start}},End={{end}} --output json';
const RESULT = {
  columns: ['date', 'amount'],
  rows: [{ date: 'd', amount: 1 }],
  rowCount: 1,
  truncated: false,
};

function reset() {
  idCounter = 0;
  S.workspace = {
    id: 'ws-1',
    organisationId: 'org-1',
    csp: 'AWS',
    isActive: true,
    credential: { encryptedCredentials: 'enc', updatedAt: new Date('2026-03-01T00:00:00Z') },
  };
  S.member = true;
  S.widgets = [];
  S.runs = [];
  S.runResults = [];
  S.audits = [];
  S.authorCalls = [];
  S.redrawCalls = [];
}

function seedWidget(over = {}) {
  idCounter += 1;
  const widget = {
    id: `w-${idCounter}`,
    userId: 'user-1',
    workspaceId: 'ws-1',
    mode: 'FINOPS',
    title: 'Daily cost',
    query: 'daily cost',
    commandTemplate: TEMPLATE,
    period: 'LAST_30_DAYS',
    chartSpec: SPEC,
    chartHtml: PAGE,
    lastResult: RESULT,
    lastRunAt: new Date(),
    lastAttemptAt: new Date(),
    lastError: null,
    createdAt: new Date(2026, 0, idCounter),
    ...over,
  };
  S.widgets.push(widget);
  return widget;
}

const matches = (row, where) => Object.entries(where).every(([k, v]) => row[k] === v);

inject('../../config/db', {
  workspace: { findUnique: async () => S.workspace },
  userOrganisation: { findUnique: async () => (S.member ? { id: 'uo-1' } : null) },
  dashboardWidget: {
    findMany: async ({ where }) => S.widgets.filter((w) => matches(w, where)),
    findFirst: async ({ where }) => S.widgets.find((w) => matches(w, where)) ?? null,
    count: async ({ where }) => S.widgets.filter((w) => matches(w, where)).length,
    async create({ data }) {
      return seedWidget({ lastError: null, ...data });
    },
    async update({ where, data }) {
      const widget = S.widgets.find((w) => w.id === where.id);
      Object.assign(widget, data);
      return widget;
    },
    async delete({ where }) {
      S.widgets = S.widgets.filter((w) => w.id !== where.id);
    },
  },
});
inject('../../crypto/envelope', { decrypt: () => JSON.stringify({ accessKeyId: 'AKIATEST' }) });
inject('../../ai/dashboard/widgetRunner', {
  async runWidget(args) {
    S.runs.push(args);
    return S.runResults.shift() ?? { ok: true, result: RESULT, argv: ['aws'] };
  },
  async writeDashboardAudit(entry) {
    S.audits.push(entry);
  },
});
inject('../../ai/dashboard/widgetAuthor', {
  async authorWidget(args) {
    S.authorCalls.push(args);
    return { draft: { title: 'T' }, command: 'aws x', result: RESULT };
  },
  async redrawPage(args) {
    S.redrawCalls.push(args);
    return NEW_PAGE;
  },
});

const service = require('./dashboard.service');
const { ERROR_CODES } = require('../../constants/errors');
const { AUDIT_ACTIONS } = require('../../constants/auditActions');
const { MAX_WIDGETS_PER_DASHBOARD, WIDGET_TTL_MS } = require('../../constants/dashboard');

const fails = (status, code) => (err) => err.status === status && err.code === code;
const BODY = {
  workspaceId: 'ws-1',
  mode: 'FINOPS',
  query: 'daily cost',
  title: 'Daily cost',
  commandTemplate: TEMPLATE,
  period: 'LAST_30_DAYS',
  chartSpec: SPEC,
  chartHtml: PAGE,
};

/* ---- list ---------------------------------------------------------------- */

test("listWidgets: returns only the caller's graphs for that Workspace and mode", async () => {
  reset();
  seedWidget();
  seedWidget({ mode: 'CLOUDOPS' });
  seedWidget({ userId: 'user-2' });
  seedWidget({ workspaceId: 'ws-2' });

  const { widgets, maxWidgets, ttlSeconds } = await service.listWidgets('user-1', {
    workspaceId: 'ws-1',
    mode: 'FINOPS',
  });

  assert.deepEqual(
    widgets.map((w) => w.id),
    ['w-1'],
  );
  assert.equal(maxWidgets, MAX_WIDGETS_PER_DASHBOARD);
  assert.equal(ttlSeconds, WIDGET_TTL_MS / 1000);
  assert.ok(!('userId' in widgets[0]));
});

test('listWidgets: stale means never attempted, or last attempted longer ago than the TTL', async () => {
  reset();
  seedWidget({ lastAttemptAt: new Date() });
  seedWidget({ lastAttemptAt: new Date(Date.now() - WIDGET_TTL_MS - 1000) });
  seedWidget({ lastAttemptAt: null, lastRunAt: null, lastResult: null });
  // A graph that failed a minute ago is not re-run on every open.
  seedWidget({ lastAttemptAt: new Date(Date.now() - 60000), lastError: 'boom' });

  const { widgets } = await service.listWidgets('user-1', { workspaceId: 'ws-1', mode: 'FINOPS' });

  assert.deepEqual(
    widgets.map((w) => w.stale),
    [false, true, true, false],
  );
});

test('listWidgets: works for a Workspace with no credential, but not without access', async () => {
  reset();
  S.workspace.credential = null;
  await service.listWidgets('user-1', { workspaceId: 'ws-1', mode: 'FINOPS' });

  S.member = false;
  await assert.rejects(
    service.listWidgets('user-1', { workspaceId: 'ws-1', mode: 'FINOPS' }),
    fails(403, ERROR_CODES.FORBIDDEN),
  );
});

/* ---- preview ------------------------------------------------------------- */

test('previewWidget: hands the author the Workspace and decrypted credential, saves nothing', async () => {
  reset();

  const preview = await service.previewWidget('user-1', {
    workspaceId: 'ws-1',
    mode: 'FINOPS',
    query: 'daily cost',
  });

  assert.equal(preview.command, 'aws x');
  const call = S.authorCalls[0];
  assert.equal(call.userId, 'user-1');
  assert.equal(call.workspace.id, 'ws-1');
  assert.deepEqual(call.credential, { accessKeyId: 'AKIATEST' });
  assert.equal(call.mode, 'FINOPS');
  assert.equal(S.widgets.length, 0);
});

test('previewWidget: refused for an inactive Workspace or one with no credential', async () => {
  reset();
  S.workspace.isActive = false;
  await assert.rejects(
    service.previewWidget('user-1', { workspaceId: 'ws-1', mode: 'FINOPS', query: 'q' }),
    fails(403, ERROR_CODES.WORKSPACE_INACTIVE),
  );

  reset();
  S.workspace.credential = null;
  await assert.rejects(
    service.previewWidget('user-1', { workspaceId: 'ws-1', mode: 'FINOPS', query: 'q' }),
    fails(422, ERROR_CODES.WORKSPACE_CREDENTIAL_MISSING),
  );
  assert.equal(S.authorCalls.length, 0);
});

/* ---- create -------------------------------------------------------------- */

test('createWidget: runs the definition on the server and stores that result', async () => {
  reset();

  const widget = await service.createWidget('user-1', BODY);

  assert.equal(S.runs.length, 1);
  assert.equal(S.runs[0].trigger, 'save');
  assert.equal(S.runs[0].commandTemplate, TEMPLATE);
  assert.deepEqual(widget.lastResult, RESULT);
  assert.equal(widget.chartHtml, PAGE);
  assert.equal(S.runs[0].chartHtml, undefined, 'the page is never run on the server');
  assert.equal(widget.stale, false);
  assert.equal(S.widgets[0].userId, 'user-1');
  assert.equal(S.audits[0].action, AUDIT_ACTIONS.DASHBOARD_WIDGET_CREATED);
  assert.equal(S.audits[0].metadata.widgetId, widget.id);
});

test('createWidget: a definition that does not run is not saved', async () => {
  reset();
  S.runResults.push({ ok: false, rejected: true, error: 'The command was not run: read-only' });

  await assert.rejects(
    service.createWidget('user-1', BODY),
    (err) =>
      err.status === 422 &&
      err.code === ERROR_CODES.DASHBOARD_WIDGET_INVALID &&
      /read-only/.test(err.message),
  );
  assert.equal(S.widgets.length, 0);
});

test('createWidget: refused once the dashboard is full, without running anything', async () => {
  reset();
  for (let i = 0; i < MAX_WIDGETS_PER_DASHBOARD; i += 1) seedWidget();

  await assert.rejects(
    service.createWidget('user-1', BODY),
    fails(409, ERROR_CODES.DASHBOARD_WIDGET_LIMIT),
  );
  assert.equal(S.runs.length, 0);
});

test('createWidget: the limit is per dashboard, not per Operator', async () => {
  reset();
  for (let i = 0; i < MAX_WIDGETS_PER_DASHBOARD; i += 1) seedWidget({ mode: 'CLOUDOPS' });

  await service.createWidget('user-1', BODY);

  assert.equal(S.widgets.filter((w) => w.mode === 'FINOPS').length, 1);
});

test('createWidget: refused without access to the Workspace', async () => {
  reset();
  S.member = false;
  await assert.rejects(service.createWidget('user-1', BODY), fails(403, ERROR_CODES.FORBIDDEN));
  assert.equal(S.runs.length, 0);
});

/* ---- refresh ------------------------------------------------------------- */

test('refreshWidget: stores a new result and clears an old error', async () => {
  reset();
  const widget = seedWidget({ lastError: 'old failure', lastResult: null });
  const fresh = { ...RESULT, rowCount: 7 };
  S.runResults.push({ ok: true, result: fresh, argv: ['aws'] });

  const updated = await service.refreshWidget('user-1', widget.id);

  assert.deepEqual(updated.lastResult, fresh);
  assert.equal(updated.lastError, null);
  assert.equal(S.runs[0].trigger, 'refresh');
  assert.equal(S.runs[0].widgetId, widget.id);
});

test('refreshWidget: a failed run keeps the previous result and records the reason', async () => {
  reset();
  const before = new Date('2026-01-01T00:00:00Z');
  const widget = seedWidget({ lastRunAt: before, lastAttemptAt: before });
  S.runResults.push({ ok: false, error: 'The command timed out.' });

  const updated = await service.refreshWidget('user-1', widget.id);

  assert.deepEqual(updated.lastResult, RESULT);
  assert.deepEqual(updated.lastRunAt, before);
  assert.equal(updated.lastError, 'The command timed out.');
  assert.ok(updated.lastAttemptAt > before);
  assert.equal(updated.stale, false);
});

test("refreshWidget: another Operator's graph is a 404", async () => {
  reset();
  const widget = seedWidget({ userId: 'user-2' });

  await assert.rejects(
    service.refreshWidget('user-1', widget.id),
    fails(404, ERROR_CODES.NOT_FOUND),
  );
  assert.equal(S.runs.length, 0);
});

test('refreshWidget: stops as soon as the Operator loses the Workspace', async () => {
  reset();
  const widget = seedWidget();

  S.member = false;
  await assert.rejects(
    service.refreshWidget('user-1', widget.id),
    fails(403, ERROR_CODES.FORBIDDEN),
  );

  S.member = true;
  S.workspace.isActive = false;
  await assert.rejects(
    service.refreshWidget('user-1', widget.id),
    fails(403, ERROR_CODES.WORKSPACE_INACTIVE),
  );
  assert.equal(S.runs.length, 0);
});

test('refreshWidget: concurrent refreshes of one graph run its command once', async () => {
  reset();
  const widget = seedWidget();

  await Promise.all([
    service.refreshWidget('user-1', widget.id),
    service.refreshWidget('user-1', widget.id),
    service.refreshWidget('user-1', widget.id),
  ]);

  assert.equal(S.runs.length, 1);
});

/* ---- update -------------------------------------------------------------- */

test('updateWidget: renaming does not run the command', async () => {
  reset();
  const widget = seedWidget();

  const updated = await service.updateWidget('user-1', widget.id, { title: 'Spend per day' });

  assert.equal(updated.title, 'Spend per day');
  assert.equal(S.runs.length, 0);
  assert.deepEqual(S.audits[0].metadata.changed, ['title']);
});

test('updateWidget: a new period is saved and the graph re-run with it', async () => {
  reset();
  const widget = seedWidget();

  const updated = await service.updateWidget('user-1', widget.id, { period: 'LAST_7_DAYS' });

  assert.equal(updated.period, 'LAST_7_DAYS');
  assert.equal(S.runs.length, 1);
  assert.equal(S.runs[0].period, 'LAST_7_DAYS');
});

test('updateWidget: the same period again changes nothing and runs nothing', async () => {
  reset();
  const widget = seedWidget();

  await service.updateWidget('user-1', widget.id, { period: 'LAST_30_DAYS' });

  assert.equal(S.runs.length, 0);
  assert.equal(S.audits.length, 0);
});

test('updateWidget: a period the command cannot take is refused', async () => {
  reset();
  const dated = seedWidget();
  const snapshot = seedWidget({ commandTemplate: 'aws ec2 describe-volumes', period: 'NONE' });

  await assert.rejects(
    service.updateWidget('user-1', dated.id, { period: 'NONE' }),
    fails(422, ERROR_CODES.DASHBOARD_WIDGET_INVALID),
  );
  await assert.rejects(
    service.updateWidget('user-1', snapshot.id, { period: 'LAST_7_DAYS' }),
    fails(422, ERROR_CODES.DASHBOARD_WIDGET_INVALID),
  );
  assert.equal(dated.period, 'LAST_30_DAYS');
  assert.equal(S.runs.length, 0);
});

test('listWidgets: a graph saved before pages existed has no page', async () => {
  reset();
  seedWidget({ chartHtml: undefined });

  const { widgets } = await service.listWidgets('user-1', { workspaceId: 'ws-1', mode: 'FINOPS' });

  assert.equal(widgets[0].chartHtml, null);
});

/* ---- redraw -------------------------------------------------------------- */

test('redrawWidget: stores a new page written from the data the graph already has', async () => {
  reset();
  const widget = seedWidget({ chartHtml: null });

  const updated = await service.redrawWidget('user-1', widget.id);

  assert.equal(updated.chartHtml, NEW_PAGE);
  assert.deepEqual(updated.lastResult, RESULT);
  assert.equal(S.runs.length, 0, 'the command is not run');
  assert.deepEqual(S.redrawCalls[0], {
    title: 'Daily cost',
    query: 'daily cost',
    chartSpec: SPEC,
    result: RESULT,
  });
  assert.deepEqual(S.audits[0].metadata, { widgetId: widget.id, changed: ['chartHtml'] });
});

test("redrawWidget: refused for a graph with no data, without access, or not the caller's", async () => {
  reset();
  const empty = seedWidget({ lastResult: null });
  await assert.rejects(
    service.redrawWidget('user-1', empty.id),
    fails(422, ERROR_CODES.DASHBOARD_WIDGET_INVALID),
  );

  const other = seedWidget({ userId: 'user-2' });
  await assert.rejects(service.redrawWidget('user-1', other.id), fails(404, ERROR_CODES.NOT_FOUND));

  const mine = seedWidget();
  S.member = false;
  await assert.rejects(service.redrawWidget('user-1', mine.id), fails(403, ERROR_CODES.FORBIDDEN));
  assert.equal(S.redrawCalls.length, 0);
});

/* ---- delete -------------------------------------------------------------- */

test("deleteWidget: removes the caller's graph and audits it", async () => {
  reset();
  const widget = seedWidget();

  await service.deleteWidget('user-1', widget.id);

  assert.equal(S.widgets.length, 0);
  assert.equal(S.audits[0].action, AUDIT_ACTIONS.DASHBOARD_WIDGET_DELETED);
});

test('deleteWidget: an Operator can still remove a graph after losing the Workspace', async () => {
  reset();
  const widget = seedWidget();
  S.member = false;

  await service.deleteWidget('user-1', widget.id);

  assert.equal(S.widgets.length, 0);
});

test("deleteWidget: another Operator's graph is a 404 and is left alone", async () => {
  reset();
  const widget = seedWidget({ userId: 'user-2' });

  await assert.rejects(
    service.deleteWidget('user-1', widget.id),
    fails(404, ERROR_CODES.NOT_FOUND),
  );
  assert.equal(S.widgets.length, 1);
});

/* ---- chains -------------------------------------------------------------- */

const STEPS = [
  {
    command: 'aws ec2 describe-instances --output json',
    rowsPath: 'Reservations[].Instances[].{id: InstanceId}',
  },
  {
    command:
      'aws cloudwatch get-metric-statistics --dimensions Name=InstanceId,Value={{item.id}} --start-time {{start}}T00:00:00Z --output json',
    rowsPath: 'Datapoints[].{date: Timestamp, amount: Average}',
  },
];

test('createWidget: a chain is run and stored with its first command as the graph command', async () => {
  reset();
  const { commandTemplate, ...body } = BODY;
  assert.ok(commandTemplate);

  const widget = await service.createWidget('user-1', { ...body, steps: STEPS });

  assert.deepEqual(S.runs[0].steps, STEPS);
  assert.deepEqual(widget.steps, STEPS);
  assert.equal(widget.commandTemplate, STEPS[0].command);
  assert.deepEqual(S.audits.at(-1).metadata.steps, STEPS);
});

test('refreshWidget: a chained graph re-runs its steps; a one-command graph has none', async () => {
  reset();
  const chained = seedWidget({ steps: STEPS, commandTemplate: STEPS[0].command });
  const single = seedWidget();

  await service.refreshWidget('user-1', chained.id);
  const listed = await service.listWidgets('user-1', { workspaceId: 'ws-1', mode: 'FINOPS' });

  assert.deepEqual(S.runs[0].steps, STEPS);
  assert.equal(listed.widgets.find((w) => w.id === single.id).steps, null);
});

test('updateWidget: a period change is checked against every step of a chain', async () => {
  reset();
  const widget = seedWidget({ steps: STEPS, commandTemplate: STEPS[0].command });

  await assert.rejects(
    service.updateWidget('user-1', widget.id, { period: 'NONE' }),
    fails(422, ERROR_CODES.DASHBOARD_WIDGET_INVALID),
  );
  await service.updateWidget('user-1', widget.id, { period: 'LAST_7_DAYS' });
  assert.equal(S.runs.at(-1).period, 'LAST_7_DAYS');
});
