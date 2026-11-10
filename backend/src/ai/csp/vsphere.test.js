const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getCsp } = require('./index');

const vsphere = getCsp('VSPHERE');
const classify = (command) => vsphere.classifyOperation(command.split(' '));

// --- schema ----------------------------------------------------------------

const base = { url: 'https://vc.lab/sdk', username: 'a', password: 'p' };

test('schema: defaults insecure to false', () => {
  assert.equal(vsphere.credentialSchema.parse(base).insecure, false);
});

for (const value of [true, 'true']) {
  test(`schema: accepts insecure ${JSON.stringify(value)}`, () => {
    assert.equal(vsphere.credentialSchema.parse({ ...base, insecure: value }).insecure, true);
  });
}

test('schema: insecure "false" is false', () => {
  assert.equal(vsphere.credentialSchema.parse({ ...base, insecure: 'false' }).insecure, false);
});

test('schema: rejects non-https url', () => {
  assert.equal(vsphere.credentialSchema.safeParse({ ...base, url: 'http://vc.lab/sdk' }).success, false);
  assert.equal(vsphere.credentialSchema.safeParse({ ...base, url: 'not a url' }).success, false);
});

test('schema: rejects empty password', () => {
  assert.equal(vsphere.credentialSchema.safeParse({ ...base, password: '' }).success, false);
});

// --- buildEnv --------------------------------------------------------------

test('buildEnv: maps credential to GOVC_* env', async () => {
  assert.deepEqual(await vsphere.buildEnv({ ...base, insecure: true }), {
    GOVC_URL: 'https://vc.lab/sdk',
    GOVC_USERNAME: 'a',
    GOVC_PASSWORD: 'p',
    GOVC_INSECURE: '1',
  });
});

test('buildEnv: GOVC_DATACENTER only when set; insecure 0 otherwise', async () => {
  const env = await vsphere.buildEnv({ ...base, insecure: false, datacenter: 'dc1' });
  assert.equal(env.GOVC_DATACENTER, 'dc1');
  assert.equal(env.GOVC_INSECURE, '0');
});

test('module surface', () => {
  assert.equal(vsphere.binary, 'govc');
  assert.equal(vsphere.supportsRegions, false);
  assert.equal(vsphere.dashboardOutputHint, 'add -json');
  assert.equal(vsphere.sandboxImage, 'opencai-sandbox-vsphere:0.46.3');
});

// --- grammar ---------------------------------------------------------------

const READONLY = [
  'govc about',
  'govc ls /dc1/vm',
  'govc find / -type m',
  'govc vm.info -json web-01',
  'govc datastore.info -json',
  'govc datastore.ls -json /ds',
  'govc host.info',
  'govc metric.sample -json vm/web-01 cpu.usage.average',
  'govc events',
  'govc snapshot.tree -vm web-01',
  'govc cluster.usage c1',
  'govc vm.ip web-01',
  'govc network.info x',
];

for (const command of READONLY) {
  test(`read-only: ${command}`, () => {
    const result = classify(command);
    assert.equal(result.kind, 'readonly');
    assert.equal(result.verb, command.split(' ')[1]);
    assert.equal(result.dryRunCapable, false);
  });
}

for (const command of ['govc vm.info -h', 'govc help', 'govc -h', 'govc help vm.info', 'govc vm.destroy -h']) {
  test(`lookup: ${command}`, () => {
    const result = classify(command);
    assert.equal(result.kind, 'lookup');
    assert.equal(result.dryRunCapable, false);
  });
}

const MUTATING = [
  'govc vm.power -off web-01',
  'govc vm.destroy web-01',
  'govc snapshot.create -vm web-01 s1',
  'govc snapshot.remove -vm web-01 s1',
  'govc vm.change -vm web-01 -m 4096',
  'govc tags.attach t1 /dc1/vm/web-01',
  'govc host.maintenance.enter h1',
  'govc datastore.rm /ds/old',
  'govc folder.create /dc1/vm/f',
];

for (const command of MUTATING) {
  test(`mutating: ${command}`, () => {
    const result = classify(command);
    assert.equal(result.kind, 'mutating');
    assert.equal(result.verb, command.split(' ')[1]);
    assert.equal(result.dryRunCapable, false);
  });
}

const REJECTED = [
  'govc guest.run -vm x ls',
  'govc guest.ls -vm x /',
  'govc datastore.upload a b',
  'govc datastore.download a b',
  'govc session.login',
  'govc session.ls',
  'govc env',
  'govc import.ova x',
  'govc export.ovf x',
  'govc vm.console web-01',
  'govc license.ls',
  'govc Option.ls',
  'govc License.ls',
  'govc SSO.user.ls',
  'govc VM.INFO web-01',
  'govc license.assigned.ls',
  'govc license.add KEY',
  'govc sso.user.ls',
  'govc sso.service.ls',
  'govc sso.group.create g',
  'govc option.ls',
  'govc option.ls -json config.vpxd',
  'govc option.set k v',
  'govc permissions.ls /dc1',
  'govc permissions.set -principal u /dc1',
  'govc frobnicate',
  'govc datastore.mkdir x',
  'govc',
  'govc -json vm.info',
];

for (const command of REJECTED) {
  test(`rejected: ${command}`, () => {
    assert.ok(classify(command).reject);
  });
}

// "-h" can be another flag's value, so these are classified as normal commands.
test('-h as a flag value is not lookup', () => {
  assert.equal(classify('govc vm.change -vm web-01 -annotation -h').kind, 'mutating');
  assert.equal(classify('govc vm.change -vm web-01 -name -h').kind, 'mutating');
  assert.ok(classify('govc guest.run -vm x -C -h rm -rf /tmp').reject);
  assert.equal(classify('govc vm.destroy web-01 -h').kind, 'mutating');
  assert.ok(classify('govc help vm.info extra').reject);
});

const BLOCKED = [
  '-u https://evil.example/sdk',
  '--u=https://evil.example/sdk',
  '-k',
  '-k=true',
  '--k',
  '-cert=/x',
  '-key /x',
  '-cacert /x',
  '--tls-ca-certs=/x',
  '-tls-known-hosts /x',
  '-trace',
  '--trace=true',
  '-verbose',
  '-debug',
  '-persist-session=false',
  '-vim-namespace x',
  '--vim-version=1',
];

for (const flags of BLOCKED) {
  test(`rejected flag: govc about ${flags}`, () => {
    assert.ok(classify(`govc about ${flags}`).reject);
    assert.ok(classify(`govc vm.power -off ${flags}`).reject);
  });
}
