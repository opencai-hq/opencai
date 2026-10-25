const prisma = require('../../config/db');
const { AppError } = require('../../middleware/errorHandler');
const { ERROR_CODES, ERROR_MESSAGES } = require('../../constants/errors');
const { AUDIT_ACTIONS, AUDIT_OUTCOMES } = require('../../constants/auditActions');
const {
  MAX_WIDGETS_PER_DASHBOARD,
  WIDGET_TTL_MS,
  MAX_ERROR_CHARS,
} = require('../../constants/dashboard');
const { loadWorkspaceForOperator } = require('../../ai/workspaceAccess');
const { chainProblem, stepsOf } = require('../../ai/dashboard/chain');
const { runWidget, writeDashboardAudit } = require('../../ai/dashboard/widgetRunner');
const { authorWidget, redrawPage } = require('../../ai/dashboard/widgetAuthor');
const { singleFlight } = require('../../ai/dashboard/runLimiter');

// What the browser gets for one graph. `stale` says whether the dashboard
// should re-run it on open; a graph that failed recently is not stale, so a
// broken one is not re-run every time the page loads.
function toWidget(row, now = Date.now()) {
  return {
    id: row.id,
    title: row.title,
    query: row.query,
    commandTemplate: row.commandTemplate,
    steps: row.steps ?? null,
    period: row.period,
    chartSpec: row.chartSpec,
    chartHtml: row.chartHtml ?? null,
    lastResult: row.lastResult,
    lastRunAt: row.lastRunAt,
    lastAttemptAt: row.lastAttemptAt,
    lastError: row.lastError,
    stale: !row.lastAttemptAt || now - new Date(row.lastAttemptAt).getTime() > WIDGET_TTL_MS,
  };
}

function invalid(detail) {
  return new AppError(
    422,
    ERROR_CODES.DASHBOARD_WIDGET_INVALID,
    `${ERROR_MESSAGES[ERROR_CODES.DASHBOARD_WIDGET_INVALID]} ${detail}`,
  );
}

async function findOwnWidget(userId, widgetId) {
  const widget = await prisma.dashboardWidget.findFirst({ where: { id: widgetId, userId } });
  if (!widget) throw new AppError(404, ERROR_CODES.NOT_FOUND);
  return widget;
}

/** Store how a run went. A failed run keeps the graph's previous result. */
async function saveRun(widgetId, run) {
  const now = new Date();
  const row = await prisma.dashboardWidget.update({
    where: { id: widgetId },
    data: run.ok
      ? { lastResult: run.result, lastRunAt: now, lastAttemptAt: now, lastError: null }
      : { lastAttemptAt: now, lastError: run.error.slice(0, MAX_ERROR_CHARS) },
  });
  return toWidget(row);
}

function runFor(userId, access, widget, trigger) {
  return runWidget({
    userId,
    ...access,
    mode: widget.mode,
    commandTemplate: widget.commandTemplate,
    steps: widget.steps,
    period: widget.period,
    chartSpec: widget.chartSpec,
    trigger,
    widgetId: widget.id,
  });
}

async function listWidgets(userId, { workspaceId, mode }) {
  await loadWorkspaceForOperator(userId, workspaceId, { withCredential: false });
  const rows = await prisma.dashboardWidget.findMany({
    where: { userId, workspaceId, mode },
    orderBy: { createdAt: 'asc' },
  });
  const now = Date.now();
  return {
    widgets: rows.map((row) => toWidget(row, now)),
    ttlSeconds: WIDGET_TTL_MS / 1000,
    maxWidgets: MAX_WIDGETS_PER_DASHBOARD,
  };
}

/** Build a graph from a plain-language request and run it once. Saves nothing. */
async function previewWidget(userId, { workspaceId, mode, query }) {
  const access = await loadWorkspaceForOperator(userId, workspaceId);
  return authorWidget({ userId, ...access, mode, query });
}

/**
 * Save a graph. The definition comes from the browser, so it is run here first
 * and saved only if it works; the stored result is the server's own.
 */
async function createWidget(userId, body) {
  const { workspaceId, mode, query, title, steps, period, chartSpec, chartHtml } = body;
  const commandTemplate = steps ? steps[0].command : body.commandTemplate;
  const access = await loadWorkspaceForOperator(userId, workspaceId);

  const count = await prisma.dashboardWidget.count({ where: { userId, workspaceId, mode } });
  if (count >= MAX_WIDGETS_PER_DASHBOARD) {
    throw new AppError(409, ERROR_CODES.DASHBOARD_WIDGET_LIMIT);
  }

  const run = await runWidget({
    userId,
    ...access,
    mode,
    commandTemplate,
    steps,
    period,
    chartSpec,
    trigger: 'save',
  });
  if (!run.ok) throw invalid(run.error);

  const now = new Date();
  const row = await prisma.dashboardWidget.create({
    data: {
      userId,
      workspaceId,
      mode,
      title,
      query,
      commandTemplate,
      steps: steps ?? undefined,
      period,
      chartSpec,
      chartHtml,
      lastResult: run.result,
      lastRunAt: now,
      lastAttemptAt: now,
    },
  });
  await writeDashboardAudit({
    userId,
    workspaceId,
    action: AUDIT_ACTIONS.DASHBOARD_WIDGET_CREATED,
    outcome: AUDIT_OUTCOMES.SUCCESS,
    metadata: { widgetId: row.id, title, commandTemplate, steps: steps ?? null, period },
  });
  return toWidget(row);
}

/** Rename a graph or change its period. */
async function updateWidget(userId, widgetId, { title, period }) {
  const widget = await findOwnWidget(userId, widgetId);
  const access = await loadWorkspaceForOperator(userId, widget.workspaceId);

  const data = {};
  if (title !== undefined) data.title = title;

  const periodChanged = period !== undefined && period !== widget.period;
  if (periodChanged) {
    const problem = chainProblem(stepsOf(widget), period);
    if (problem) throw invalid(`This graph's period cannot be changed to that: ${problem}.`);
    data.period = period;
  }

  let row = widget;
  if (Object.keys(data).length > 0) {
    row = await prisma.dashboardWidget.update({ where: { id: widget.id }, data });
    await writeDashboardAudit({
      userId,
      workspaceId: widget.workspaceId,
      action: AUDIT_ACTIONS.DASHBOARD_WIDGET_UPDATED,
      outcome: AUDIT_OUTCOMES.SUCCESS,
      metadata: { widgetId: widget.id, changed: Object.keys(data) },
    });
  }

  // A new period means new data.
  if (!periodChanged) return toWidget(row);
  return singleFlight(widget.id, async () =>
    saveRun(widget.id, await runFor(userId, access, row, 'refresh')),
  );
}

/**
 * Re-run a graph's saved command and store the outcome. Access is checked
 * again here, so a graph stops refreshing as soon as the Operator loses the
 * Workspace.
 */
async function refreshWidget(userId, widgetId) {
  const widget = await findOwnWidget(userId, widgetId);
  const access = await loadWorkspaceForOperator(userId, widget.workspaceId);
  return singleFlight(widget.id, async () =>
    saveRun(widget.id, await runFor(userId, access, widget, 'refresh')),
  );
}

/**
 * Have the AI write a new page for a graph, from the data it already has. The
 * command is not run and the data does not change.
 */
async function redrawWidget(userId, widgetId) {
  const widget = await findOwnWidget(userId, widgetId);
  await loadWorkspaceForOperator(userId, widget.workspaceId, { withCredential: false });
  if (!widget.lastResult) throw invalid('This graph has no data to draw yet. Refresh it first.');

  return singleFlight(`redraw:${widget.id}`, async () => {
    const chartHtml = await redrawPage({
      title: widget.title,
      query: widget.query,
      chartSpec: widget.chartSpec,
      result: widget.lastResult,
    });
    const row = await prisma.dashboardWidget.update({
      where: { id: widget.id },
      data: { chartHtml },
    });
    await writeDashboardAudit({
      userId,
      workspaceId: widget.workspaceId,
      action: AUDIT_ACTIONS.DASHBOARD_WIDGET_UPDATED,
      outcome: AUDIT_OUTCOMES.SUCCESS,
      metadata: { widgetId: widget.id, changed: ['chartHtml'] },
    });
    return toWidget(row);
  });
}

async function deleteWidget(userId, widgetId) {
  const widget = await findOwnWidget(userId, widgetId);
  await prisma.dashboardWidget.delete({ where: { id: widget.id } });
  await writeDashboardAudit({
    userId,
    workspaceId: widget.workspaceId,
    action: AUDIT_ACTIONS.DASHBOARD_WIDGET_DELETED,
    outcome: AUDIT_OUTCOMES.SUCCESS,
    metadata: { widgetId: widget.id, title: widget.title },
  });
}

module.exports = {
  listWidgets,
  previewWidget,
  createWidget,
  updateWidget,
  refreshWidget,
  redrawWidget,
  deleteWidget,
};
