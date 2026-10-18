const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getCsp } = require('./index');
const { classify } = require('../policy/commandPolicy');
const { POLICY_VERDICTS } = require('../policy/policyVerdicts');

const gcp = getCsp('GCP');

function run(commandString, personaAllowedBinaries = ['aws', 'az', 'gcloud']) {
  return classify({
    mode: 'CLOUDOPS',
    subMode: null,
    csp: 'GCP',
    commandString,
    personaAllowedBinaries,
  });
}

// --- grammar ---------------------------------------------------------------

const READONLY = [
  ['gcloud compute instances list', 'list'],
  ['gcloud compute instances describe web-1 --zone us-central1-a', 'describe'],
  ['gcloud projects get-iam-policy my-project --format=json', 'get-iam-policy'],
  ['gcloud beta billing accounts list', 'list'],
  ['gcloud storage ls gs://bucket', 'ls'],
  ['gcloud logging read severity=ERROR --limit 10', 'read'],
  ['gcloud asset search-all-resources --scope=projects/p', 'search-all-resources'],
  // `run` is a top-level group here, not the verb.
  ['gcloud run services list --region us-central1', 'list'],
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
  ['gcloud compute instances delete web-1 --zone us-central1-a', 'delete'],
  ['gcloud compute instances create web-2 --machine-type e2-small', 'create'],
  ['gcloud compute instances set-machine-type web-1 --machine-type e2-medium', 'set-machine-type'],
  ['gcloud projects add-iam-policy-binding p --member user:a@b.c', 'add-iam-policy-binding'],
  ['gcloud scheduler jobs run nightly', 'run'],
  ['gcloud dataproc jobs submit spark --cluster c', 'submit'],
  ['gcloud storage rm gs://bucket/object', 'rm'],
  ['gcloud alpha compute instances stop web-1', 'stop'],
  // A resource named like a read-only verb must not hide the mutating verb.
  ['gcloud compute instances delete list', 'delete'],
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
    'gcloud compute instances delete --help',
    'gcloud compute instances create -h',
    'gcloud help compute instances list',
    'gcloud --help',
  ]) {
    assert.equal(run(command).verdict, POLICY_VERDICTS.ALLOW_LOOKUP, command);
  }
});

test('a bare -- is rejected: gcloud hands what follows to another program', () => {
  assert.equal(run('gcloud compute ssh web-1 -- --help').verdict, POLICY_VERDICTS.REJECTED);
  assert.equal(
    run('gcloud compute instances delete web-1 -- --help').verdict,
    POLICY_VERDICTS.REJECTED,
  );
});

const BLOCKED = [
  'gcloud auth print-access-token',
  'gcloud auth list',
  'gcloud auth activate-service-account --key-file k.json',
  'gcloud config set project other',
  'gcloud config list',
  'gcloud init',
  'gcloud components update',
  'gcloud container clusters get-credentials c --zone z',
  'gcloud beta auth print-identity-token',
];

for (const command of BLOCKED) {
  test(`blocked: ${command}`, () => {
    assert.equal(run(command).verdict, POLICY_VERDICTS.REJECTED);
  });
}

test('default-deny: commands with no recognised verb are rejected', () => {
  for (const command of [
    'gcloud compute ssh web-1',
    'gcloud secrets versions access latest --secret db-password',
    'gcloud kms decrypt --key k --ciphertext-file c --plaintext-file p',
    'gcloud info',
    'gcloud',
  ]) {
    assert.equal(run(command).verdict, POLICY_VERDICTS.REJECTED, command);
  }
});

test('flags must come after the command, so a flag value is never read as the verb', () => {
  const result = run('gcloud --format list compute instances frobnicate');
  assert.equal(result.verdict, POLICY_VERDICTS.REJECTED);
});

// Pins the limitation documented on classifyOperation: gcloud takes resource
// names after the verb, so an unlisted verb followed by a name that looks like
// a read-only verb reads as read-only. If this starts failing because the
// grammar got stricter, delete it.
test('known limitation: an unlisted verb plus a resource named like a read-only verb', () => {
  const result = run('gcloud compute instances frobnicate list');
  assert.equal(result.verdict, POLICY_VERDICTS.ALLOW_READONLY);
});

test('the CLI of another provider is rejected even when the persona allows it', () => {
  for (const command of ['aws ec2 describe-instances', 'az vm list', 'gsutil ls', 'bq ls']) {
    assert.equal(run(command).verdict, POLICY_VERDICTS.REJECTED, command);
  }
});

// --- credentials -----------------------------------------------------------

const KEY_FILE = {
  type: 'service_account',
  project_id: 'acme-prod-123',
  private_key_id: 'abc',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n',
  client_email: 'opencai@acme-prod-123.iam.gserviceaccount.com',
  client_id: '1234',
};

const STORED = {
  clientEmail: KEY_FILE.client_email,
  privateKey: KEY_FILE.private_key,
  projectId: 'acme-prod-123',
};

test('the credential schema keeps only what is needed to mint tokens', () => {
  const result = gcp.credentialSchema.safeParse({ serviceAccountKey: JSON.stringify(KEY_FILE) });
  assert.equal(result.success, true);
  assert.deepEqual(result.data, STORED);
});

test('an explicit project ID overrides the key file, and must look like one', () => {
  const serviceAccountKey = JSON.stringify(KEY_FILE);
  const ok = gcp.credentialSchema.safeParse({ serviceAccountKey, projectId: 'other-project-9' });
  assert.equal(ok.data.projectId, 'other-project-9');
  assert.equal(
    gcp.credentialSchema.safeParse({ serviceAccountKey, projectId: 'x --impersonate' }).success,
    false,
  );
});

test('the credential schema rejects non-JSON and non-service-account keys with a clear message', () => {
  const notJson = gcp.credentialSchema.safeParse({ serviceAccountKey: 'not json' });
  assert.equal(notJson.success, false);
  assert.match(notJson.error.issues[0].message, /not valid JSON/);

  const userKey = gcp.credentialSchema.safeParse({
    serviceAccountKey: JSON.stringify({ ...KEY_FILE, type: 'authorized_user' }),
  });
  assert.equal(userKey.success, false);
  assert.match(userKey.error.issues[0].message, /service_account/);
});

test('the sandbox gets a short-lived token and the project, never the private key', async () => {
  const minted = [];
  const env = await gcp.buildEnv(STORED, {
    mintToken: async (args) => {
      minted.push(args);
      return 'ya29.short-lived';
    },
  });

  assert.deepEqual(env, {
    CLOUDSDK_AUTH_ACCESS_TOKEN: 'ya29.short-lived',
    CLOUDSDK_CORE_PROJECT: 'acme-prod-123',
    CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
  });
  assert.deepEqual(minted, [{ clientEmail: STORED.clientEmail, privateKey: STORED.privateKey }]);
  assert.ok(!JSON.stringify(env).includes('PRIVATE KEY'));
  assert.equal(gcp.prepareSandbox, undefined);
});

test('an incomplete payload fails before any token is requested', async () => {
  let called = false;
  const mintToken = async () => {
    called = true;
    return 't';
  };
  await assert.rejects(
    () => gcp.buildEnv({ clientEmail: 'a@b.c' }, { mintToken }),
    /Incomplete GCP credential payload/,
  );
  assert.equal(called, false);
});
