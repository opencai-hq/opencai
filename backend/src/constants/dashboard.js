// Dashboard graph vocabulary and limits.

// The time window a graph covers, relative to the day it runs. NONE is a
// snapshot graph whose command takes no dates.
const DASHBOARD_PERIODS = Object.freeze({
  NONE: 'NONE',
  LAST_7_DAYS: 'LAST_7_DAYS',
  LAST_30_DAYS: 'LAST_30_DAYS',
  LAST_90_DAYS: 'LAST_90_DAYS',
  MONTH_TO_DATE: 'MONTH_TO_DATE',
  LAST_6_MONTHS: 'LAST_6_MONTHS',
  LAST_12_MONTHS: 'LAST_12_MONTHS',
});

const CHART_TYPES = Object.freeze({
  LINE: 'line',
  BAR: 'bar',
  AREA: 'area',
  PIE: 'pie',
  STAT: 'stat',
  TABLE: 'table',
});

const MAX_WIDGETS_PER_DASHBOARD = 12;
// A graph older than this is re-run when its dashboard is opened.
const WIDGET_TTL_MS = 60 * 60 * 1000;

const MAX_TEMPLATE_CHARS = 2000;
// The AI-written page that draws one graph.
const MAX_CHART_HTML_CHARS = 12000;
// Limits on what one graph stores and sends to the browser.
const MAX_ROWS = 1000;
const MAX_SERIES = 8;
const MAX_RESULT_BYTES = 200000;
const MAX_CELL_CHARS = 200;
const MAX_ERROR_CHARS = 500;

module.exports = {
  DASHBOARD_PERIODS,
  CHART_TYPES,
  MAX_WIDGETS_PER_DASHBOARD,
  WIDGET_TTL_MS,
  MAX_TEMPLATE_CHARS,
  MAX_CHART_HTML_CHARS,
  MAX_ROWS,
  MAX_SERIES,
  MAX_RESULT_BYTES,
  MAX_CELL_CHARS,
  MAX_ERROR_CHARS,
};
