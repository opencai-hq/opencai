// A saved graph's command never holds a real date. It holds placeholders, and
// the dates are worked out from the graph's period each time it runs.

const { DASHBOARD_PERIODS, MAX_TEMPLATE_CHARS } = require('../../constants/dashboard');

const PLACEHOLDER = /\{\{(start|end|end_inclusive)\}\}/g;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LITERAL_DATE = /\b(19|20)\d{2}-\d{2}-\d{2}\b/;

const DAYS_BACK = Object.freeze({
  [DASHBOARD_PERIODS.LAST_7_DAYS]: 6,
  [DASHBOARD_PERIODS.LAST_30_DAYS]: 29,
  [DASHBOARD_PERIODS.LAST_90_DAYS]: 89,
});

const MONTHS_BACK = Object.freeze({
  [DASHBOARD_PERIODS.MONTH_TO_DATE]: 0,
  [DASHBOARD_PERIODS.LAST_6_MONTHS]: 5,
  [DASHBOARD_PERIODS.LAST_12_MONTHS]: 11,
});

const ymd = (date) => date.toISOString().slice(0, 10);

/**
 * The dates a period covers on the day `now` falls in (UTC).
 *
 * `end` is the day after today, for APIs whose end date is exclusive (AWS Cost
 * Explorer); `endInclusive` is today, for APIs whose end date is inclusive
 * (Azure Cost Management). Using tomorrow as the exclusive end also keeps
 * start < end on the first of a month.
 *
 * @returns {{ start: string, end: string, endInclusive: string } | null} null
 *   for NONE.
 */
function resolvePeriod(period, now = new Date()) {
  if (period === DASHBOARD_PERIODS.NONE) return null;

  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();

  let start;
  if (Object.hasOwn(DAYS_BACK, period)) {
    start = new Date(Date.UTC(year, month, day - DAYS_BACK[period]));
  } else if (Object.hasOwn(MONTHS_BACK, period)) {
    start = new Date(Date.UTC(year, month - MONTHS_BACK[period], 1));
  } else {
    throw new Error(`Unknown period: ${period}`);
  }

  return {
    start: ymd(start),
    end: ymd(new Date(Date.UTC(year, month, day + 1))),
    endInclusive: ymd(new Date(Date.UTC(year, month, day))),
  };
}

/** Why a command template cannot be used with this period, or null when it can. */
function templateProblem(template, period) {
  if (typeof template !== 'string' || template.trim().length === 0) {
    return 'the command is empty';
  }
  if (template.length > MAX_TEMPLATE_CHARS) {
    return `the command is longer than ${MAX_TEMPLATE_CHARS} characters`;
  }
  if (!Object.hasOwn(DASHBOARD_PERIODS, period)) {
    return `"${period}" is not a known period`;
  }

  const placeholders = template.match(PLACEHOLDER) ?? [];
  const rest = template.replace(PLACEHOLDER, '');
  if (rest.includes('{{') || rest.includes('}}')) {
    return 'the only placeholders allowed are {{start}}, {{end}} and {{end_inclusive}}';
  }
  if (LITERAL_DATE.test(rest)) {
    return 'the command contains a fixed date; use {{start}}, {{end}} or {{end_inclusive}} instead';
  }
  if (period === DASHBOARD_PERIODS.NONE && placeholders.length > 0) {
    return 'a graph with period NONE must not use date placeholders';
  }
  if (period !== DASHBOARD_PERIODS.NONE && placeholders.length === 0) {
    return `a graph with period ${period} must take its dates from {{start}}, {{end}} or {{end_inclusive}}`;
  }
  return null;
}

/**
 * The command that actually runs: the template with its placeholders replaced
 * by dates. Nothing but a YYYY-MM-DD date is ever substituted, so a template
 * cannot gain arguments by being rendered.
 */
function renderCommand(template, period, now = new Date()) {
  const problem = templateProblem(template, period);
  if (problem) throw new Error(problem);

  const dates = resolvePeriod(period, now);
  if (!dates) return template;

  const values = { start: dates.start, end: dates.end, end_inclusive: dates.endInclusive };
  return template.replace(PLACEHOLDER, (_match, name) => {
    const value = values[name];
    if (!DATE.test(value)) throw new Error(`Refusing to substitute a non-date for {{${name}}}`);
    return value;
  });
}

module.exports = { resolvePeriod, templateProblem, renderCommand, PLACEHOLDER, DATE, LITERAL_DATE };
