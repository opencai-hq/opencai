const test = require('node:test');
const assert = require('node:assert/strict');

const { currentDateRule } = require('./currentDate');

test('currentDateRule: states the UTC date', () => {
  assert.match(
    currentDateRule(new Date('2026-10-25T12:00:00Z')),
    /^Today's date is 2026-10-25 \(UTC\)\./,
  );
});

test('currentDateRule: the date turns over at UTC midnight, not local midnight', () => {
  assert.match(currentDateRule(new Date('2026-10-25T23:59:59Z')), /2026-10-25/);
  assert.match(currentDateRule(new Date('2026-10-26T00:00:00Z')), /2026-10-26/);
  // 05:00 on the 26th in India is still the 25th in UTC.
  assert.match(currentDateRule(new Date('2026-10-26T05:00:00+05:30')), /2026-10-25/);
});

test('currentDateRule: tells the model to work periods out from it', () => {
  assert.match(currentDateRule(), /never assume a different year/);
});
