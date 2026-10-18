const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getCsp } = require('./index');
const { classify } = require('../policy/commandPolicy');
const { POLICY_VERDICTS } = require('../policy/policyVerdicts');

const azure = getCsp('AZURE');

const CREDENTIAL = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  clientId: '22222222-2222-2222-2222-222222222222',
  clientSecret: 'sp-secret',
  subscriptionId: '33333333-3333-3333-3333-333333333333',
};

function run(commandString, personaAllowedBinaries = ['aws', 'az', 'gcloud']) {
  return classify({
    mode: 'CLOUDOPS',
    subMode: null,
    csp: 'AZURE',
    commandString,
    personaAllowedBinaries,
  });
}

// --- grammar ---------------------------------------------------------------

const READONLY = [
  ['az vm list', 'list'],
  ['az vm show --name web --resource-group rg', 'show'],
  ['az vm get-instance-view -n web -g rg', 'get-instance-view'],
  ['az network vnet subnet list --vnet-name v -g rg', 'list'],
  ['az vm list-skus --location westeurope', 'list-skus'],
  ['az costmanagement query --type Usage --scope /subscriptions/x', 'query'],
  ['az group exists --name rg', 'exists'],
];

for (const [command, verb] of READONLY) {
  test(`read-only: ${command}`, () => {
    const result = run(command);
    assert.equal(result.verdict, POLICY_VERDICTS.ALLOW_READONLY);
    assert.equal(result.verb, verb);
    assert.equal(result.dryRunCapable, false);
  });
}

const MUTATING = [
  ['az vm delete --name web -g rg --yes', 'delete'],
  ['az group create --name rg --location westeurope', 'create'],
  ['az vm deallocate -n web -g rg', 'deallocate'],
  ['az role assignment create --assignee x --role Owner', 'create'],
  ['az ad sp create-for-rbac --name x', 'create-for-rbac'],
  ['az storage account keys renew -n a -g rg --key primary', 'renew'],
  ['az resource tag --tags env=prod --ids /subscriptions/x', 'tag'],
];

for (const [command, verb] of MUTATING) {
  test(`mutating, needs confirmation: ${command}`, () => {
    const result = run(command);
    assert.equal(result.verdict, POLICY_VERDICTS.REQUIRE_CONFIRMATION);
    assert.equal(result.verb, verb);
    assert.equal(result.dryRunCapable, false);
  });
}

test('help is a lookup, whatever it is attached to', () => {
  for (const command of [
    'az vm delete --help',
    'az vm create -h',
    'az --help',
    'az login --help',
  ]) {
    assert.equal(run(command).verdict, POLICY_VERDICTS.ALLOW_LOOKUP, command);
  }
});

test('a bare -- cannot disguise a real command as a help request', () => {
  const result = run('az vm delete -n web -g rg --yes -- --help');
  assert.equal(result.verdict, POLICY_VERDICTS.REJECTED);
});

const BLOCKED = [
  'az login',
  'az login --service-principal -u a -p b --tenant c',
  'az logout',
  'az account set --subscription other',
  'az account clear',
  'az account get-access-token',
  'az account get-access-token --resource https://vault.azure.net',
  'az config set core.output=json',
  'az configure --defaults group=rg',
  'az extension add --name ssh',
  'az extension list',
  'az rest --method delete --url https://management.azure.com/x',
  'az aks get-credentials -n c -g rg',
  'az acr login --name r',
];

for (const command of BLOCKED) {
  test(`blocked: ${command}`, () => {
    const result = run(command);
    assert.equal(result.verdict, POLICY_VERDICTS.REJECTED);
  });
}

test('account show and account list stay readable although account set is blocked', () => {
  assert.equal(run('az account show').verdict, POLICY_VERDICTS.ALLOW_READONLY);
  assert.equal(run('az account list').verdict, POLICY_VERDICTS.ALLOW_READONLY);
});

test('default-deny: an unrecognised verb is rejected, not assumed safe', () => {
  const result = run('az vm run-command invoke -n web -g rg --command-id RunShellScript');
  assert.equal(result.verdict, POLICY_VERDICTS.REJECTED);
  assert.match(result.reason, /Unrecognized operation "invoke"/);
});

test('rejects a group with no operation, and options before the command', () => {
  assert.equal(run('az vm').verdict, POLICY_VERDICTS.REJECTED);
  assert.equal(run('az').verdict, POLICY_VERDICTS.REJECTED);
  assert.equal(run('az --output json vm list').verdict, POLICY_VERDICTS.REJECTED);
});

test('the CLI of another provider is rejected even when the persona allows it', () => {
  for (const command of ['aws ec2 describe-instances', 'gcloud compute instances list']) {
    const result = run(command);
    assert.equal(result.verdict, POLICY_VERDICTS.REJECTED, command);
    assert.match(result.reason, /is not allowed in this mode/);
  }
});

test('az is rejected when the persona does not allow it', () => {
  assert.equal(run('az vm list', ['aws']).verdict, POLICY_VERDICTS.REJECTED);
});

test('shell operators are rejected before the grammar is consulted', () => {
  assert.equal(run('az vm list && az vm delete -n x').verdict, POLICY_VERDICTS.REJECTED);
  assert.equal(run('az vm list --query "$(whoami)"').verdict, POLICY_VERDICTS.REJECTED);
});

// --- credentials -----------------------------------------------------------

test('the credential schema wants four fields, three of them GUIDs', () => {
  const parses = (value) => azure.credentialSchema.safeParse(value).success;
  assert.equal(parses(CREDENTIAL), true);
  assert.equal(parses({ ...CREDENTIAL, tenantId: 'contoso' }), false);
  assert.equal(parses({ ...CREDENTIAL, subscriptionId: 'x; rm -rf /' }), false);
  assert.equal(parses({ ...CREDENTIAL, clientSecret: '' }), false);
});

test('the per-command environment holds no credential at all', async () => {
  const env = await azure.buildEnv(CREDENTIAL);
  assert.ok(!JSON.stringify(env).includes('sp-secret'));
  assert.ok(!Object.keys(env).some((key) => /CLIENT|TENANT|SECRET/.test(key)));
});

test('sign-in passes the secret through the environment, never argv', async () => {
  const calls = [];
  await azure.prepareSandbox({
    credential: CREDENTIAL,
    exec: async (argv, env) => {
      calls.push({ argv, env });
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    },
  });

  assert.equal(calls.length, 1);
  const [{ argv, env }] = calls;
  assert.deepEqual(argv.slice(0, 2), ['sh', '-c']);
  assert.equal(argv.length, 3);
  for (const value of Object.values(CREDENTIAL)) {
    assert.ok(!argv[2].includes(value), 'no credential value may be interpolated into the script');
  }
  assert.equal(env.AZURE_CLIENT_SECRET, 'sp-secret');
  assert.equal(env.AZURE_TENANT_ID, CREDENTIAL.tenantId);
  assert.equal(env.AZURE_CLIENT_ID, CREDENTIAL.clientId);
  assert.equal(env.AZURE_SUBSCRIPTION_ID, CREDENTIAL.subscriptionId);
});

test('sign-in fails loudly on a non-zero exit, a timeout or an incomplete payload', async () => {
  const failing = (result) => () =>
    azure.prepareSandbox({ credential: CREDENTIAL, exec: async () => result });

  await assert.rejects(failing({ exitCode: 1, timedOut: false }), /Azure sign-in exited 1/);
  await assert.rejects(failing({ exitCode: null, timedOut: true }), /timed out/);
  await assert.rejects(
    () =>
      azure.prepareSandbox({ credential: { tenantId: 'x' }, exec: async () => ({ exitCode: 0 }) }),
    /Incomplete Azure credential payload/,
  );
});
