const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolvePeriod, templateProblem, renderCommand } = require('./period');
const { DASHBOARD_PERIODS } = require('../../constants/dashboard');

const at = (iso) => new Date(`${iso}T15:30:00Z`);

test('resolvePeriod: day-based periods count back from today, inclusive', () => {
  const now = at('2026-10-10');
  assert.deepEqual(resolvePeriod('LAST_7_DAYS', now), {
    start: '2026-10-04',
    end: '2026-10-11',
    endInclusive: '2026-10-10',
  });
  assert.equal(resolvePeriod('LAST_30_DAYS', now).start, '2026-09-11');
  assert.equal(resolvePeriod('LAST_90_DAYS', now).start, '2026-07-13');
});

test('resolvePeriod: month-based periods start on the first of a month', () => {
  const now = at('2026-10-10');
  assert.equal(resolvePeriod('MONTH_TO_DATE', now).start, '2026-10-01');
  assert.equal(resolvePeriod('LAST_6_MONTHS', now).start, '2026-05-01');
  assert.equal(resolvePeriod('LAST_12_MONTHS', now).start, '2025-11-01');
});

test('resolvePeriod: on the first of a month, start is still before end', () => {
  const dates = resolvePeriod('MONTH_TO_DATE', at('2026-10-01'));
  assert.deepEqual(dates, { start: '2026-10-01', end: '2026-10-02', endInclusive: '2026-10-01' });
});

test('resolvePeriod: rolls over year and month ends', () => {
  assert.equal(resolvePeriod('LAST_6_MONTHS', at('2026-02-15')).start, '2025-09-01');
  assert.equal(resolvePeriod('LAST_7_DAYS', at('2026-01-03')).start, '2025-12-28');
  assert.equal(resolvePeriod('LAST_7_DAYS', at('2026-12-31')).end, '2027-01-01');
});

test('resolvePeriod: NONE has no dates, an unknown period throws', () => {
  assert.equal(resolvePeriod('NONE', at('2026-10-10')), null);
  assert.throws(() => resolvePeriod('LAST_CENTURY', at('2026-10-10')), /Unknown period/);
});

test('every period resolves to plain dates', () => {
  for (const period of Object.values(DASHBOARD_PERIODS)) {
    const dates = resolvePeriod(period, at('2026-03-31'));
    if (!dates) continue;
    for (const value of Object.values(dates)) assert.match(value, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('renderCommand: fills every placeholder', () => {
  const rendered = renderCommand(
    'aws ce get-cost-and-usage --time-period Start={{start}},End={{end}} --x {{end_inclusive}}T00:00:00Z',
    'LAST_7_DAYS',
    at('2026-10-10'),
  );
  assert.equal(
    rendered,
    'aws ce get-cost-and-usage --time-period Start=2026-10-04,End=2026-10-11 --x 2026-10-10T00:00:00Z',
  );
});

test('renderCommand: a NONE command is returned unchanged', () => {
  assert.equal(renderCommand('aws ec2 describe-volumes', 'NONE'), 'aws ec2 describe-volumes');
});

test('templateProblem: unknown placeholders and stray braces are refused', () => {
  assert.match(templateProblem('aws x --a {{today}}', 'LAST_7_DAYS'), /only placeholders/);
  assert.match(templateProblem('aws x --a {{start}} }}', 'LAST_7_DAYS'), /only placeholders/);
  assert.match(templateProblem('aws x --a {{ start }}', 'LAST_7_DAYS'), /only placeholders/);
  assert.throws(
    () => renderCommand('aws x {{start}} {{oops}}', 'LAST_7_DAYS'),
    /only placeholders/,
  );
});

test('templateProblem: a fixed date is refused', () => {
  assert.match(
    templateProblem('aws ce x --time-period Start=2026-09-01,End={{end}}', 'LAST_30_DAYS'),
    /fixed date/,
  );
});

test('templateProblem: placeholders must match the period', () => {
  assert.match(templateProblem('aws x {{start}}', 'NONE'), /must not use date placeholders/);
  assert.match(templateProblem('aws ec2 describe-volumes', 'LAST_7_DAYS'), /must take its dates/);
  assert.equal(templateProblem('aws ec2 describe-volumes', 'NONE'), null);
  assert.equal(templateProblem('aws x {{start}}', 'LAST_7_DAYS'), null);
});

test('templateProblem: empty, oversized and unknown-period templates are refused', () => {
  assert.match(templateProblem('   ', 'NONE'), /empty/);
  assert.match(templateProblem(undefined, 'NONE'), /empty/);
  assert.match(templateProblem(`aws ${'x'.repeat(2100)}`, 'NONE'), /longer than/);
  assert.match(templateProblem('aws x', 'toString'), /not a known period/);
});
