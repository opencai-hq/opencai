const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stepsSchema, chainProblem, renderStep, stepsOf, ItemValueError } = require('./chain');
const { resolvePeriod } = require('./period');

const LIST = {
  command: 'aws ec2 describe-instances --output json',
  rowsPath: 'Reservations[].Instances[].{id: InstanceId}',
};
const CPU = {
  command:
    'aws cloudwatch get-metric-statistics --dimensions Name=InstanceId,Value={{item.id}} --start-time {{start}}T00:00:00Z --end-time {{end}}T00:00:00Z --output json',
  rowsPath: 'Datapoints[].{date: Timestamp, cpu: Average}',
};

test('a chain is 1 to 5 steps, and every step of a longer chain has a rowsPath', () => {
  assert.equal(stepsSchema.safeParse([{ command: 'aws s3api list-buckets' }]).success, true);
  assert.equal(stepsSchema.safeParse([LIST, CPU]).success, true);
  assert.equal(stepsSchema.safeParse([]).success, false);
  assert.equal(stepsSchema.safeParse(Array(6).fill(LIST)).success, false);
  assert.equal(stepsSchema.safeParse([LIST, { command: CPU.command }]).success, false);
});

test('a single step follows the single-command rules', () => {
  assert.equal(chainProblem([{ command: 'aws ec2 describe-volumes' }], 'NONE'), null);
  assert.match(chainProblem([{ command: 'aws ec2 describe-volumes' }], 'LAST_7_DAYS'), /dates/);
});

test('a chain takes its dates from any step', () => {
  assert.equal(chainProblem([LIST, CPU], 'LAST_7_DAYS'), null);
  assert.match(chainProblem([LIST, CPU], 'NONE'), /must not use date placeholders/);
  const undated = { ...CPU, command: 'aws ec2 describe-volumes --volume-ids {{item.id}}' };
  assert.equal(chainProblem([LIST, undated], 'NONE'), null);
  assert.match(chainProblem([LIST, undated], 'LAST_7_DAYS'), /must take its dates/);
});

test('only later steps use the item, and they must', () => {
  const itemFirst = { ...LIST, command: 'aws ec2 describe-instances --instance-ids {{item.id}}' };
  assert.match(chainProblem([itemFirst, CPU], 'LAST_7_DAYS'), /step 1 runs once/);
  const noItem = { ...CPU, command: CPU.command.replace('{{item.id}}', 'i-1') };
  assert.match(chainProblem([LIST, noItem], 'LAST_7_DAYS'), /step 2 .* must use \{\{item/);
});

test('a chain refuses fixed dates, unknown placeholders and a missing rowsPath', () => {
  const fixed = { ...CPU, command: CPU.command.replace('{{start}}T00:00:00Z', '2026-01-01') };
  assert.match(chainProblem([LIST, fixed], 'LAST_7_DAYS'), /step 2 contains a fixed date/);
  const unknown = { ...CPU, command: `${CPU.command} {{evil}}` };
  assert.match(chainProblem([LIST, unknown], 'LAST_7_DAYS'), /only placeholders/);
  assert.match(chainProblem([LIST, { command: CPU.command }], 'LAST_7_DAYS'), /rowsPath/);
  assert.match(chainProblem(Array(6).fill(LIST), 'NONE'), /at most 5 steps/);
});

test('renderStep fills in dates and the item', () => {
  const dates = resolvePeriod('LAST_7_DAYS', new Date('2026-10-10T12:00:00Z'));
  const rendered = renderStep(CPU.command, dates, { id: 'i-0abc123' });
  assert.match(rendered, /Value=i-0abc123 /);
  assert.match(rendered, /--start-time 2026-10-04T00:00:00Z --end-time 2026-10-11T00:00:00Z/);
  assert.equal(renderStep('x --size {{item.n}}', null, { n: 40 }), 'x --size 40');
});

test('renderStep never substitutes a value that could change the command', () => {
  for (const id of ['a b', '--debug', '"q"', '$(whoami)', 'a;b', 'a|b', '', 'x\ny', '`id`']) {
    assert.throws(
      () => renderStep('aws ec2 describe-instances --instance-ids {{item.id}}', null, { id }),
      ItemValueError,
      `refuses ${JSON.stringify(id)}`,
    );
  }
  assert.throws(() => renderStep('x {{item.id}}', null, { other: 1 }), ItemValueError);
  assert.throws(() => renderStep('x {{item.id}}', null, { id: null }), ItemValueError);
});

test('stepsOf turns a single command into a one-step chain', () => {
  assert.deepEqual(stepsOf({ commandTemplate: 'aws s3api list-buckets' }), [
    { command: 'aws s3api list-buckets' },
  ]);
  assert.deepEqual(stepsOf({ steps: [LIST, CPU], commandTemplate: LIST.command }), [LIST, CPU]);
  assert.deepEqual(stepsOf({ steps: null, commandTemplate: 'a' }), [{ command: 'a' }]);
});
