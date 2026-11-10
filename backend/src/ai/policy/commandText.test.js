const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('shell-quote');

const { commandTextFromArgv } = require('./commandText');

// The approved text is re-parsed at confirm time, so it must give back exactly
// the argv that was proposed -- for every provider's CLI.
const CASES = [
  ['aws', 'ec2', 'describe-instances', '--query', 'Reservations[].Instances[].InstanceId'],
  ['aws', 'ec2', 'describe-instances', '--filters', 'Name=tag:Env,Values=prod'],
  ['aws', 'iam', 'get-role', '--role-arn', 'arn:aws:iam::123456789012:role/x'],
  ['aws', 'ec2', 'create-tags', '--resources', 'i-1', '--tags', 'Key=Name,Value=my web box'],
  ['az', 'vm', 'list', '--query', "[?location=='eastus'].name", '-o', 'json'],
  ['az', 'group', 'create', '-n', 'rg', '-l', 'eastus', '--tags', 'owner=a b'],
  ['gcloud', 'compute', 'instances', 'list', '--filter', 'labels.env=prod AND status=RUNNING'],
  ['gcloud', 'compute', 'instances', 'list', '--format=json'],
  ['govc', 'vm.info', '-json', '/DC1/vm/web 01'],
  ['govc', 'find', '/', '-type', 'm', '-name', 'web*'],
  ['govc', 'vm.power', '-off', 'web-01'],
  ['kubectl', 'patch', 'deploy', 'x', '-p', '{"spec":{"replicas":3}}'],
  ['kubectl', 'get', 'pods', '-o', "jsonpath={.items[*].metadata.name}"],
  ['kubectl', 'get', 'pods', '-l', 'app in (web,api)'],
  ['kubectl', '-n', 'kube-system', 'get', 'pods', '-o', 'json'],
  ['ssh', 'web-01', 'sudo', 'journalctl', '--since', '2026-11-09 10:00'],
  ['ssh', 'web-01', 'journalctl', '-u', 'nginx', '-n', '50', '--no-pager'],
  ['ssh', 'web-01', 'df', '-h', '/'],
  // Odd words: empty, quotes, `$`, backslash, `#`, operators as data.
  ['aws', '', "it's", 'a"b', '$HOME', 'a\\b', '#x', 'a#b', ';', '&&', '|', '>', '!x', '~/a'],
];

for (const argv of CASES) {
  test(`round-trips: ${argv.slice(0, 3).join(' ')} ...`, () => {
    assert.deepEqual(parse(commandTextFromArgv(argv)), argv);
  });
}

test('plain words are left bare so ordinary commands read as typed', () => {
  assert.equal(
    commandTextFromArgv(['aws', 'ec2', 'describe-instances', '--region', 'us-east-1']),
    'aws ec2 describe-instances --region us-east-1',
  );
  assert.equal(
    commandTextFromArgv(['aws', 'iam', 'get-role', '--role-arn', 'arn:aws:iam::1:role/x']),
    'aws iam get-role --role-arn arn:aws:iam::1:role/x',
  );
});

test('words that need it are quoted', () => {
  assert.equal(
    commandTextFromArgv(['kubectl', 'patch', 'deploy', 'x', '-p', '{"spec":{"replicas":3}}']),
    `kubectl patch deploy x -p '{"spec":{"replicas":3}}'`,
  );
  assert.equal(
    commandTextFromArgv(['ssh', 'web-01', 'journalctl', '--since', '2026-11-09 10:00']),
    "ssh web-01 journalctl --since '2026-11-09 10:00'",
  );
});

// shell-quote's parse() throws "Bad substitution" on an unclosed `${`. Such a
// word must be quoted, not crash the turn that tries to show it.
for (const word of ['x${', '${', 'a${b', '${x']) {
  test(`does not throw on an unclosed substitution: ${word}`, () => {
    const argv = ['aws', 's3', 'ls', word];
    assert.deepEqual(parse(commandTextFromArgv(argv)), argv);
  });
}
