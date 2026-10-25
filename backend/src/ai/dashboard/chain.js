// A graph built from a chain of commands. Step 1 runs once; every later step
// runs once for each row of the step before it, with that row's fields
// written into the command as {{item.<field>}}.
//
// As with dates (see period.js), nothing but a value that cannot change the
// shape of the command is ever substituted: one token with no spaces, quotes
// or leading dash, so an item can never add an argument.

const { z } = require('zod');
const {
  DASHBOARD_PERIODS,
  MAX_TEMPLATE_CHARS,
  MAX_CHAIN_STEPS,
} = require('../../constants/dashboard');
const { templateProblem, PLACEHOLDER, DATE, LITERAL_DATE } = require('./period');

const ITEM_PLACEHOLDER = /\{\{item\.([A-Za-z_][A-Za-z0-9_]{0,63})\}\}/g;
const SAFE_ITEM_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,255}$/;

const stepSchema = z.strictObject({
  command: z.string().trim().min(1).max(MAX_TEMPLATE_CHARS),
  // JMESPath over this step's JSON output, giving a list of objects.
  rowsPath: z.string().min(1).max(500).optional(),
});

const stepsSchema = z
  .array(stepSchema)
  .min(1)
  .max(MAX_CHAIN_STEPS)
  .superRefine((steps, ctx) => {
    if (steps.length < 2) return;
    steps.forEach((step, i) => {
      if (!step.rowsPath) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'rowsPath'],
          message: `step ${i + 1} needs a "rowsPath": every step of a chain turns its output into rows`,
        });
      }
    });
  });

/** Thrown when a row cannot be written into a step's command. */
class ItemValueError extends Error {}

/** Why these steps cannot be used with this period, or null when they can. */
function chainProblem(steps, period) {
  if (!Array.isArray(steps) || steps.length === 0) return 'there are no commands';
  if (steps.length > MAX_CHAIN_STEPS) return `a graph has at most ${MAX_CHAIN_STEPS} steps`;
  if (steps.length === 1) return templateProblem(steps[0].command, period);
  if (!Object.hasOwn(DASHBOARD_PERIODS, period)) return `"${period}" is not a known period`;

  let usesDates = false;
  for (const [i, step] of steps.entries()) {
    const label = `step ${i + 1}`;
    const command = step.command;
    if (typeof command !== 'string' || command.trim().length === 0) return `${label} is empty`;
    if (command.length > MAX_TEMPLATE_CHARS) {
      return `${label} is longer than ${MAX_TEMPLATE_CHARS} characters`;
    }
    if (!step.rowsPath) return `${label} needs a "rowsPath"`;

    const items = command.match(ITEM_PLACEHOLDER) ?? [];
    if (i === 0 && items.length > 0) {
      return `${label} runs once, so it cannot use {{item.<field>}}`;
    }
    if (i > 0 && items.length === 0) {
      return `${label} runs once for each row of step ${i}, so it must use {{item.<field>}}`;
    }
    if ((command.match(PLACEHOLDER) ?? []).length > 0) usesDates = true;

    const rest = command.replace(PLACEHOLDER, '').replace(ITEM_PLACEHOLDER, '');
    if (rest.includes('{{') || rest.includes('}}')) {
      return `${label}: the only placeholders allowed are {{start}}, {{end}}, {{end_inclusive}} and {{item.<field>}}`;
    }
    if (LITERAL_DATE.test(rest)) {
      return `${label} contains a fixed date; use {{start}}, {{end}} or {{end_inclusive}} instead`;
    }
  }

  if (period === DASHBOARD_PERIODS.NONE && usesDates) {
    return 'a graph with period NONE must not use date placeholders';
  }
  if (period !== DASHBOARD_PERIODS.NONE && !usesDates) {
    return `a graph with period ${period} must take its dates from {{start}}, {{end}} or {{end_inclusive}}`;
  }
  return null;
}

/**
 * One step's command as it runs: dates and the item's fields filled in. The
 * steps must already have passed chainProblem.
 *
 * @param {?{ start, end, endInclusive }} dates from resolvePeriod.
 * @param {?object} item the row of the previous step, for steps after the first.
 * @throws {ItemValueError} when a field is missing or is not a safe value.
 */
function renderStep(command, dates, item) {
  const values = dates
    ? { start: dates.start, end: dates.end, end_inclusive: dates.endInclusive }
    : {};
  return command
    .replace(PLACEHOLDER, (_match, name) => {
      const value = values[name];
      if (!DATE.test(value ?? ''))
        throw new Error(`Refusing to substitute a non-date for {{${name}}}`);
      return value;
    })
    .replace(ITEM_PLACEHOLDER, (_match, field) => {
      const value = item?.[field];
      if (value === null || value === undefined) {
        throw new ItemValueError(`the row has no value for "${field}"`);
      }
      const text = String(value);
      if (!SAFE_ITEM_VALUE.test(text)) {
        throw new ItemValueError(`the value of "${field}" cannot be put in a command`);
      }
      return text;
    });
}

/** The steps a saved or drafted graph runs: its chain, or its one command. */
function stepsOf({ steps, commandTemplate }) {
  return Array.isArray(steps) && steps.length > 0 ? steps : [{ command: commandTemplate }];
}

module.exports = { stepsSchema, chainProblem, renderStep, stepsOf, ItemValueError };
