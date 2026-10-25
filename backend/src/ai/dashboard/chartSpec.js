// A graph's chart definition, and the step that turns a command's JSON output
// into the flat rows that definition draws.

const { z } = require('zod');
const { search } = require('./extract');
const {
  CHART_TYPES,
  MAX_ROWS,
  MAX_SERIES,
  MAX_RESULT_BYTES,
  MAX_CELL_CHARS,
} = require('../../constants/dashboard');

const OTHER_LABEL = 'Other';
const MAX_TABLE_COLUMNS = 12;

const FIELD = z.string().min(1).max(64);
const AXIS_TYPES = [CHART_TYPES.LINE, CHART_TYPES.BAR, CHART_TYPES.AREA];

const chartSpecSchema = z
  .strictObject({
    type: z.enum(Object.values(CHART_TYPES)),
    // JMESPath over the command's JSON output, giving a list of objects.
    rowsPath: z.string().min(1).max(500),
    // A row field holding a list of objects. Each of them becomes its own row,
    // carrying its parent's plain fields.
    unnest: FIELD.optional(),
    x: FIELD.optional(),
    y: z.array(FIELD).min(1).max(6).optional(),
    // A category field: one line / bar segment per distinct value.
    series: FIELD.optional(),
    // stat only: how the rows collapse into one number.
    agg: z.enum(['sum', 'avg', 'min', 'max', 'count', 'first']).optional(),
    // table only: which fields to show, in order.
    columns: z.array(FIELD).min(1).max(MAX_TABLE_COLUMNS).optional(),
    unit: z.string().max(12).optional(),
  })
  .superRefine((spec, ctx) => {
    const problem = (message) => ctx.addIssue({ code: 'custom', message });
    if (AXIS_TYPES.includes(spec.type)) {
      if (!spec.x || !spec.y) problem(`a ${spec.type} chart needs "x" and "y"`);
      if (spec.series && spec.y && spec.y.length !== 1) {
        problem('"series" can only be used with a single "y" field');
      }
    } else if (spec.type === CHART_TYPES.PIE) {
      if (!spec.x || !spec.y || spec.y.length !== 1) {
        problem('a pie chart needs "x" and exactly one "y" field');
      }
    } else if (spec.type === CHART_TYPES.STAT) {
      if (spec.agg !== 'count' && (!spec.y || spec.y.length !== 1)) {
        problem('a stat needs exactly one "y" field, or agg "count"');
      }
    }
  });

/** Thrown when command output cannot be turned into rows for a chart. */
class ChartDataError extends Error {}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A row's plain values only; nested objects and lists are dropped. */
function scalarFields(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'string') out[key] = value.slice(0, MAX_CELL_CHARS);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value;
    }
  }
  return out;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function requireField(rows, field, label) {
  if (rows.length === 0 || rows.some((row) => Object.hasOwn(row, field))) return;
  const available = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, 20);
  throw new ChartDataError(
    `"${label}" names the field "${field}", which is not in the rows. Fields available: ${available.join(', ') || '(none)'}`,
  );
}

/**
 * Keep the `MAX_SERIES` categories with the largest totals and fold the rest
 * into one "Other" category, summed per `groupBy` value.
 */
function foldSmallCategories(rows, { category, value, groupBy }) {
  const totals = new Map();
  for (const row of rows) {
    const key = String(row[category]);
    totals.set(key, (totals.get(key) ?? 0) + Math.abs(row[value] ?? 0));
  }
  if (totals.size <= MAX_SERIES) return { rows, folded: false };

  const kept = new Set(
    [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SERIES - 1)
      .map(([key]) => key),
  );

  const out = [];
  const others = new Map();
  for (const row of rows) {
    if (kept.has(String(row[category]))) {
      out.push(row);
      continue;
    }
    const group = groupBy ? row[groupBy] : OTHER_LABEL;
    others.set(group, (others.get(group) ?? 0) + (row[value] ?? 0));
  }
  for (const [group, total] of others) {
    out.push(
      groupBy
        ? { [groupBy]: group, [category]: OTHER_LABEL, [value]: total }
        : { [category]: OTHER_LABEL, [value]: total },
    );
  }
  return { rows: out, folded: true };
}

/**
 * The list of objects a JMESPath `rowsPath` selects from command output.
 *
 * @throws {ChartDataError} when the expression is invalid or selects anything
 *   but a list of objects.
 */
function selectObjects(json, rowsPath) {
  let found;
  try {
    found = search(json, rowsPath);
  } catch (err) {
    throw new ChartDataError(`"rowsPath" is not a valid JMESPath expression: ${err.message}`);
  }
  if (!Array.isArray(found)) {
    throw new ChartDataError(
      '"rowsPath" did not return a list. It must select a list of objects from the command output.',
    );
  }
  if (found.some((row) => !isObject(row))) {
    throw new ChartDataError(
      '"rowsPath" must return a list of objects, e.g. Items[].{name: Name, value: Value}',
    );
  }
  return found;
}

/**
 * Turn a command's parsed JSON output into the rows one chart draws.
 *
 * @returns {{ columns: string[], rows: object[], rowCount: number, truncated: boolean }}
 *   `rowCount` is the number of rows before any cap; `truncated` is true when
 *   rows were dropped or folded together.
 * @throws {ChartDataError} when the output does not fit the definition.
 */
function shapeRows(json, spec) {
  const found = selectObjects(json, spec.rowsPath);

  let rows;
  if (spec.unnest) {
    if (found.length > 0 && !found.some((row) => Array.isArray(row[spec.unnest]))) {
      throw new ChartDataError(`"unnest" names "${spec.unnest}", which is not a list in the rows`);
    }
    rows = found.flatMap((parent) => {
      const children = Array.isArray(parent[spec.unnest]) ? parent[spec.unnest] : [];
      const base = scalarFields(parent);
      return children.filter(isObject).map((child) => ({ ...base, ...scalarFields(child) }));
    });
  } else {
    rows = found.map(scalarFields);
  }

  const yFields = spec.y ?? [];
  if (spec.x) requireField(rows, spec.x, 'x');
  if (spec.series) requireField(rows, spec.series, 'series');
  for (const field of yFields) requireField(rows, field, 'y');
  for (const field of spec.columns ?? []) requireField(rows, field, 'columns');

  // Cloud APIs often return amounts as strings.
  if (spec.type !== CHART_TYPES.TABLE) {
    rows = rows.map((row) => {
      const out = { ...row };
      for (const field of yFields) out[field] = toNumber(row[field]);
      return out;
    });
  }

  let columns;
  if (spec.type === CHART_TYPES.TABLE) {
    columns = spec.columns ?? Object.keys(rows[0] ?? {}).slice(0, MAX_TABLE_COLUMNS);
  } else {
    columns = [...new Set([spec.x, spec.series, ...yFields].filter(Boolean))];
  }
  rows = rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c] ?? null])));

  const rowCount = rows.length;
  let truncated = false;

  if (AXIS_TYPES.includes(spec.type) && spec.series) {
    const folded = foldSmallCategories(rows, {
      category: spec.series,
      value: yFields[0],
      groupBy: spec.x,
    });
    rows = folded.rows;
    truncated = folded.folded;
  } else if (spec.type === CHART_TYPES.PIE) {
    const folded = foldSmallCategories(rows, { category: spec.x, value: yFields[0] });
    rows = folded.rows;
    truncated = folded.folded;
  }

  if (rows.length > MAX_ROWS) {
    rows = rows.slice(0, MAX_ROWS);
    truncated = true;
  }
  while (rows.length > 1 && Buffer.byteLength(JSON.stringify(rows)) > MAX_RESULT_BYTES) {
    rows = rows.slice(0, Math.ceil(rows.length / 2));
    truncated = true;
  }

  return { columns, rows, rowCount, truncated };
}

module.exports = {
  chartSpecSchema,
  shapeRows,
  selectObjects,
  scalarFields,
  ChartDataError,
  OTHER_LABEL,
};
