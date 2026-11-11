const { test } = require('node:test');
const assert = require('node:assert/strict');

const { looksLikeStepDescription, TOOL_CALL_RULES } = require('./conversation');

test('a bare step description is recognised', () => {
  for (const text of [
    'Start and enable the Redis service to run on boot',
    "Install Redis using Alpine's package manager with root privileges",
    '  Check the disk usage on web-01  ',
    // Announcing the next step in sentence form, then stopping.
    'Redis is not currently running. Let me start it.',
    "Redis is installed. I'll now enable it on boot.",
    'The service is stopped.\nNow I will restart it.',
    'Okay, let me check the logs.',
    "Next, I'm going to check the disk usage.",
  ]) {
    assert.equal(looksLikeStepDescription(text), true, text);
  }
});

test('answers, questions and multi-line replies are not step descriptions', () => {
  for (const text of [
    'Redis is installed and running.',
    'Do you want me to start Redis and enable it on boot?',
    'Done!',
    'Disk usage on web-01:',
    'Redis 8.8.0 is installed.\nIt is not running yet',
    'Start Redis (needs approval)',
    'Let me know if you want me to start it.',
    "Redis is not running. Shall I start it? Let me know.",
    'Should I start Redis and enable it on boot? Let me start once you confirm?',
    'I started Redis earlier. It is running now.',
    "Let me explain: Redis isn't running because nothing manages services in this container, so it can't be started here.\nYou'd need a server with OpenRC or systemd.",
    'ok',
    '',
    '   ',
    'x'.repeat(161).replace(/x{10}/g, 'xxxxxxxxx '),
    null,
    undefined,
  ]) {
    assert.equal(looksLikeStepDescription(text), false, JSON.stringify(text));
  }
});

test('the rules tell the model a plain reply ends its turn', () => {
  assert.match(TOOL_CALL_RULES, /A reply without a tool call ends your turn/);
  assert.match(TOOL_CALL_RULES, /ending with "\?"/);
});
