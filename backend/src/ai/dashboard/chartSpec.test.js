const { test } = require('node:test');
const assert = require('node:assert/strict');

const { chartSpecSchema, shapeRows, ChartDataError, OTHER_LABEL } = require('./chartSpec');
const { MAX_ROWS, MAX_SERIES, MAX_RESULT_BYTES } = require('../../constants/dashboard');

const valid = (spec) => chartSpecSchema.safeParse(spec).success;

// What `aws ce get-cost-and-usage --group-by ...` returns.
const COST_BY_SERVICE = {
  ResultsByTime: [
    {
      TimePeriod: { Start: '2026-10-01', End: '2026-10-02' },
      Groups: [
        { Keys: ['EC2'], Metrics: { UnblendedCost: { Amount: '12.5', Unit: 'USD' } } },
        { Keys: ['S3'], Metrics: { UnblendedCost: { Amount: '3.25', Unit: 'USD' } } },
      ],
    },
    {
      TimePeriod: { Start: '2026-10-02', End: '2026-10-03' },
      Groups: [{ Keys: ['EC2'], Metrics: { UnblendedCost: { Amount: '10', Unit: 'USD' } } }],
    },
  ],
};

const COST_SPEC = {
  type: 'bar',
  rowsPath:
    'ResultsByTime[].{date: TimePeriod.Start, groups: Groups[].{service: Keys[0], amount: Metrics.UnblendedCost.Amount}}',
  unnest: 'groups',
  x: 'date',
  y: ['amount'],
  series: 'service',
  unit: 'USD',
};

test('schema: each chart type states what it needs', () => {
  assert.ok(valid(COST_SPEC));
  assert.ok(valid({ type: 'line', rowsPath: 'a', x: 'd', y: ['a', 'b'] }));
  assert.ok(!valid({ type: 'line', rowsPath: 'a', y: ['a'] }));
  assert.ok(!valid({ type: 'line', rowsPath: 'a', x: 'd', y: ['a', 'b'], series: 's' }));
  assert.ok(valid({ type: 'pie', rowsPath: 'a', x: 'name', y: ['v'] }));
  assert.ok(!valid({ type: 'pie', rowsPath: 'a', x: 'name', y: ['v', 'w'] }));
  assert.ok(valid({ type: 'stat', rowsPath: 'a', y: ['v'], agg: 'sum' }));
  assert.ok(valid({ type: 'stat', rowsPath: 'a', agg: 'count' }));
  assert.ok(!valid({ type: 'stat', rowsPath: 'a' }));
  assert.ok(valid({ type: 'table', rowsPath: 'a' }));
});

test('schema: unknown keys and chart types are refused', () => {
  assert.ok(!valid({ type: 'table', rowsPath: 'a', script: 'x' }));
  assert.ok(!valid({ type: 'radar', rowsPath: 'a' }));
  assert.ok(!valid({ type: 'table' }));
});

test('shapeRows: unnest flattens grouped cost output and keeps the date', () => {
  const result = shapeRows(COST_BY_SERVICE, COST_SPEC);
  assert.deepEqual(result.columns, ['date', 'service', 'amount']);
  assert.deepEqual(result.rows, [
    { date: '2026-10-01', service: 'EC2', amount: 12.5 },
    { date: '2026-10-01', service: 'S3', amount: 3.25 },
    { date: '2026-10-02', service: 'EC2', amount: 10 },
  ]);
  assert.equal(result.rowCount, 3);
  assert.equal(result.truncated, false);
});

test('shapeRows: string amounts become numbers, unusable ones become null', () => {
  const result = shapeRows(
    {
      items: [{ d: 'a', v: '1.5' }, { d: 'b', v: 'n/a' }, { d: 'c', v: '' }, { d: 'd' }],
    },
    { type: 'line', rowsPath: 'items', x: 'd', y: ['v'] },
  );
  assert.deepEqual(
    result.rows.map((r) => r.v),
    [1.5, null, null, null],
  );
});

test('shapeRows: an empty list is a valid, empty result', () => {
  const result = shapeRows({ items: [] }, { type: 'line', rowsPath: 'items', x: 'd', y: ['v'] });
  assert.deepEqual(result.rows, []);
  assert.equal(result.rowCount, 0);
});

test('shapeRows: a path that matches nothing, or not a list of objects, is an error', () => {
  assert.throws(
    () => shapeRows({ items: [] }, { type: 'table', rowsPath: 'missing' }),
    ChartDataError,
  );
  assert.throws(
    () => shapeRows({ a: { b: 1 } }, { type: 'table', rowsPath: 'a' }),
    /did not return a list/,
  );
  assert.throws(
    () => shapeRows({ a: [1, 2] }, { type: 'table', rowsPath: 'a' }),
    /list of objects/,
  );
  assert.throws(() => shapeRows({}, { type: 'table', rowsPath: 'a[' }), /not a valid JMESPath/);
});

test('shapeRows: a field that is not in the rows names the fields that are', () => {
  assert.throws(
    () =>
      shapeRows(
        { items: [{ day: 'a', cost: 1 }] },
        { type: 'line', rowsPath: 'items', x: 'date', y: ['cost'] },
      ),
    /"x" names the field "date".*day, cost/,
  );
  assert.throws(
    () =>
      shapeRows(
        { items: [{ day: 'a' }] },
        { type: 'bar', rowsPath: 'items', unnest: 'groups', x: 'day', y: ['v'] },
      ),
    /"unnest" names "groups"/,
  );
});

test('shapeRows: a series chart keeps the largest categories and folds the rest', () => {
  const items = [];
  for (let s = 0; s < MAX_SERIES + 4; s += 1) {
    for (const day of ['d1', 'd2']) items.push({ day, name: `svc${s}`, cost: s + 1 });
  }
  const result = shapeRows(
    { items },
    { type: 'bar', rowsPath: 'items', x: 'day', y: ['cost'], series: 'name' },
  );
  const names = new Set(result.rows.map((r) => r.name));
  assert.equal(names.size, MAX_SERIES);
  assert.ok(names.has(OTHER_LABEL));
  assert.ok(names.has(`svc${MAX_SERIES + 3}`), 'the largest category is kept');
  assert.ok(!names.has('svc0'), 'the smallest category is folded');
  assert.equal(result.truncated, true);
  // svc0..svc4 (costs 1..5) are folded: 15 per day.
  assert.deepEqual(
    result.rows.filter((r) => r.name === OTHER_LABEL),
    [
      { day: 'd1', name: OTHER_LABEL, cost: 15 },
      { day: 'd2', name: OTHER_LABEL, cost: 15 },
    ],
  );
});

test('shapeRows: a pie folds small slices into Other', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ name: `s${i}`, v: i + 1 }));
  const result = shapeRows({ items }, { type: 'pie', rowsPath: 'items', x: 'name', y: ['v'] });
  assert.equal(result.rows.length, MAX_SERIES);
  assert.deepEqual(result.rows.at(-1), { name: OTHER_LABEL, v: 15 });
});

test('shapeRows: a table keeps chosen columns, drops nested values and trims long text', () => {
  const result = shapeRows(
    {
      items: [
        { id: 'i-1', tags: [{ k: 'a' }], state: { name: 'on' }, note: 'x'.repeat(500), n: 3 },
      ],
    },
    { type: 'table', rowsPath: 'items' },
  );
  assert.deepEqual(result.columns, ['id', 'note', 'n']);
  assert.equal(result.rows[0].note.length, 200);

  const chosen = shapeRows(
    { items: [{ id: 'i-1', n: 3, z: 1 }] },
    { type: 'table', rowsPath: 'items', columns: ['n', 'id'] },
  );
  assert.deepEqual(chosen.rows, [{ n: 3, id: 'i-1' }]);
});

test('shapeRows: rows are capped by count and by size', () => {
  const many = Array.from({ length: MAX_ROWS + 50 }, (_, i) => ({ d: `d${i}`, v: i }));
  const capped = shapeRows({ items: many }, { type: 'line', rowsPath: 'items', x: 'd', y: ['v'] });
  assert.equal(capped.rows.length, MAX_ROWS);
  assert.equal(capped.rowCount, MAX_ROWS + 50);
  assert.equal(capped.truncated, true);

  const wide = Array.from({ length: 900 }, (_, i) => ({
    a: `${i}`.padEnd(200, 'x'),
    b: 'y'.repeat(200),
  }));
  const sized = shapeRows({ items: wide }, { type: 'table', rowsPath: 'items' });
  assert.ok(Buffer.byteLength(JSON.stringify(sized.rows)) <= MAX_RESULT_BYTES);
  assert.equal(sized.truncated, true);
});
