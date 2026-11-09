const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getCsp } = require('./index');

const k8s = getCsp('KUBERNETES');
const classify = (command) => k8s.classifyOperation(command.split(' '));

// --- schema ----------------------------------------------------------------

const kubeconfig = (overrides = {}) => {
  const user = overrides.user ?? { token: 'tok-123' };
  const cluster = overrides.cluster ?? { server: 'https://k8s.lab:6443' };
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Config',
    'current-context': 'ctx',
    clusters: overrides.clusters ?? [{ name: 'c', cluster }],
    users: overrides.users ?? [{ name: 'u', user }],
    contexts: overrides.contexts ?? [{ name: 'ctx', context: { cluster: 'c', user: 'u' } }],
  }); // JSON is valid YAML
};
const parse = (value) => k8s.credentialSchema.safeParse(value);
const messageOf = (result) => result.error.issues.map((i) => i.message).join('|');

test('schema: accepts a single-context kubeconfig with token auth', () => {
  assert.equal(parse({ kubeconfig: kubeconfig() }).success, true);
});

test('schema: accepts embedded client certificate and key data', () => {
  const user = { 'client-certificate-data': 'Y2VydA==', 'client-key-data': 'a2V5' };
  assert.equal(parse({ kubeconfig: kubeconfig({ user }) }).success, true);
});

test('schema: rejects invalid YAML', () => {
  assert.equal(parse({ kubeconfig: 'a: [unclosed' }).success, false);
  assert.equal(parse({ kubeconfig: 'just a string' }).success, false);
});

test('schema: rejects zero or two contexts, clusters or users', () => {
  assert.equal(parse({ kubeconfig: kubeconfig({ contexts: [] }) }).success, false);
  const two = [
    { name: 'ctx', context: { cluster: 'c', user: 'u' } },
    { name: 'ctx2', context: { cluster: 'c', user: 'u' } },
  ];
  assert.equal(parse({ kubeconfig: kubeconfig({ contexts: two }) }).success, false);
  const clusters = [
    { name: 'c', cluster: { server: 'https://a' } },
    { name: 'c2', cluster: { server: 'https://b' } },
  ];
  assert.equal(parse({ kubeconfig: kubeconfig({ clusters }) }).success, false);
  const users = [
    { name: 'u', user: { token: 't' } },
    { name: 'u2', user: { token: 't' } },
  ];
  assert.equal(parse({ kubeconfig: kubeconfig({ users }) }).success, false);
});

test('schema: rejects exec and auth-provider plugins with the documented message', () => {
  for (const user of [
    { exec: { command: 'aws', apiVersion: 'client.authentication.k8s.io/v1' } },
    { 'auth-provider': { name: 'gcp' } },
    { token: 'x', exec: { command: 'aws' } },
  ]) {
    const result = parse({ kubeconfig: kubeconfig({ user }) });
    assert.equal(result.success, false);
    assert.equal(
      messageOf(result),
      'Kubeconfig exec/auth-provider plugins are not supported; use a token or client certificate',
    );
  }
});

test('schema: rejects credential file-path forms', () => {
  for (const user of [
    { 'client-certificate': '/c.crt', 'client-key-data': 'a2V5', token: 't' },
    { 'client-key': '/k.pem', token: 't' },
    { tokenFile: '/var/run/token' },
  ]) {
    const result = parse({ kubeconfig: kubeconfig({ user }) });
    assert.equal(result.success, false);
    assert.match(messageOf(result), /file paths are not supported/);
  }
  const cluster = { server: 'https://a', 'certificate-authority': '/ca.crt' };
  const result = parse({ kubeconfig: kubeconfig({ cluster, user: { token: 't' } }) });
  assert.equal(result.success, false);
  assert.match(messageOf(result), /file paths are not supported/);
});

test('schema: rejects a user with no embedded credential', () => {
  assert.equal(parse({ kubeconfig: kubeconfig({ user: {} }) }).success, false);
  assert.equal(
    parse({ kubeconfig: kubeconfig({ user: { 'client-certificate-data': 'Y2VydA==' } }) }).success,
    false,
  );
});

test('schema: namespace must be a valid name', () => {
  assert.equal(parse({ kubeconfig: kubeconfig(), namespace: 'kube-system' }).success, true);
  for (const namespace of ['Bad', '-a', 'a-', 'a_b', 'a'.repeat(64), '']) {
    assert.equal(parse({ kubeconfig: kubeconfig(), namespace }).success, false, namespace);
  }
});

// --- buildEnv / prepareSandbox ----------------------------------------------

test('buildEnv: only KUBECONFIG path, no kubeconfig text', async () => {
  const env = await k8s.buildEnv({ kubeconfig: kubeconfig() });
  assert.deepEqual(env, { KUBECONFIG: '/home/sandbox/.kube/config' });
});

test('module surface', () => {
  assert.equal(k8s.label, 'Kubernetes');
  assert.equal(k8s.binary, 'kubectl');
  assert.equal(k8s.supportsRegions, false);
  assert.equal(k8s.dashboardOutputHint, 'add -o json');
  assert.equal(k8s.sandboxImage, 'opencai-sandbox-kubernetes:1.31.4');
});

const ok = { stdout: '', stderr: '', exitCode: 0, timedOut: false };

test('prepareSandbox: kubeconfig only in env, script fixed across credentials', async () => {
  const run = async (cfg) => {
    const calls = [];
    await k8s.prepareSandbox({
      credential: { kubeconfig: cfg },
      exec: async (argv, env) => {
        calls.push({ argv, env });
        return ok;
      },
    });
    return calls;
  };
  const a = await run(kubeconfig());
  const b = await run(kubeconfig({ user: { token: 'other' } }));
  assert.equal(a.length, 1);
  assert.deepEqual(a[0].argv.slice(0, 2), ['sh', '-c']);
  assert.equal(a[0].argv.length, 3);
  assert.equal(a[0].argv[2], b[0].argv[2]);
  assert.ok(!a[0].argv[2].includes('tok-123'));
  assert.equal(a[0].env.OPENCAI_KUBECONFIG, kubeconfig());
  assert.equal(a[0].env.KUBECONFIG, '/home/sandbox/.kube/config');
  assert.ok(!JSON.stringify(a[0].argv).includes('tok-123'));
});

test('prepareSandbox: a namespace adds a second fixed step', async () => {
  const calls = [];
  await k8s.prepareSandbox({
    credential: { kubeconfig: kubeconfig(), namespace: 'dev' },
    exec: async (argv, env) => {
      calls.push({ argv, env });
      return ok;
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(
    calls[1].argv[2],
    'kubectl config set-context --current --namespace "$OPENCAI_NAMESPACE"',
  );
  assert.equal(calls[1].env.OPENCAI_NAMESPACE, 'dev');
  assert.ok(!('OPENCAI_KUBECONFIG' in calls[1].env));
  assert.ok(!calls[1].argv[2].includes('dev'));
});

test('prepareSandbox: fails loudly on non-zero exit, timeout or missing kubeconfig', async () => {
  const failing = (result) => () =>
    k8s.prepareSandbox({ credential: { kubeconfig: kubeconfig() }, exec: async () => result });
  await assert.rejects(failing({ exitCode: 1, timedOut: false }), /Kubernetes sign-in exited 1/);
  await assert.rejects(failing({ exitCode: null, timedOut: true }), /timed out/);
  await assert.rejects(
    () => k8s.prepareSandbox({ credential: {}, exec: async () => ok }),
    /Incomplete Kubernetes credential payload/,
  );
  let n = 0;
  await assert.rejects(
    () =>
      k8s.prepareSandbox({
        credential: { kubeconfig: kubeconfig(), namespace: 'dev' },
        exec: async () => ({ exitCode: (n += 1) === 2 ? 3 : 0, timedOut: false }),
      }),
    /Kubernetes sign-in exited 3/,
  );
});

// --- classification ---------------------------------------------------------

const expectKind = (kind, commands) => {
  for (const command of commands) {
    test(`${kind}: ${command}`, () => {
      const verdict = classify(command);
      assert.equal(verdict.kind, kind, JSON.stringify(verdict));
      assert.equal(verdict.dryRunCapable, false);
    });
  }
};
const expectReject = (commands) => {
  for (const command of commands) {
    test(`reject: ${command}`, () => {
      const verdict = classify(command);
      assert.ok(verdict.reject, `expected reject, got ${JSON.stringify(verdict)}`);
    });
  }
};

expectKind('readonly', [
  'kubectl get pods -A -o json',
  'kubectl describe node n1',
  'kubectl logs deploy/web --tail 100',
  'kubectl top pods',
  'kubectl top node',
  'kubectl get events',
  'kubectl events',
  'kubectl rollout status deploy/web',
  'kubectl rollout history deploy/web --revision=2',
  'kubectl auth can-i list pods',
  'kubectl auth can-i get secrets',
  'kubectl cluster-info',
  'kubectl -n kube-system get pods',
  'kubectl get pods -n dev -l app=web',
  'kubectl get all',
  'kubectl get pods -lapp=web',
  'kubectl api-resources -o wide',
  'kubectl explain pod --api-version=v1',
]);

expectKind('lookup', [
  'kubectl explain pod.spec',
  'kubectl explain pod.spec --recursive',
  'kubectl api-resources',
  'kubectl api-versions',
  'kubectl version',
  'kubectl version --client',
  'kubectl version --client -o json',
  'kubectl version -o yaml',
  'kubectl get --help',
  'kubectl get -h',
  'kubectl --help',
  'kubectl -h',
  'kubectl rollout --help',
  'kubectl rollout status --help',
  'kubectl create deployment -h',
  'kubectl top pods --help',
]);

expectKind('mutating', [
  'kubectl scale deploy/web --replicas 3',
  'kubectl delete pod p1',
  'kubectl rollout restart deploy/web',
  'kubectl rollout undo deploy/web',
  'kubectl cordon n1',
  'kubectl drain n1 --ignore-daemonsets',
  'kubectl label pod p1 a=b',
  'kubectl annotate pod p1 a=b',
  'kubectl set image deploy/web web=nginx:1.27',
  'kubectl create namespace dev',
  'kubectl -n dev scale deploy/web --replicas=2',
]);

expectReject([
  'kubectl exec p1 -- sh',
  'kubectl cp a b',
  'kubectl port-forward p1 80',
  'kubectl proxy',
  'kubectl run x --image y',
  'kubectl edit pod p1',
  'kubectl config view',
  'kubectl apply -f x.yaml',
  'kubectl create -f x.yaml',
  'kubectl debug p1',
  'kubectl attach p1',
  'kubectl replace --force',
  'kubectl certificate approve x',
  'kubectl plugin list',
  'kubectl cluster-info dump',
  'kubectl rollout',
  'kubectl rollout frobnicate deploy/web',
  'kubectl create',
  'kubectl',
]);

// R2: blocked global flags in every spelling, on any verb
expectReject([
  'kubectl get pods --kubeconfig /x',
  'kubectl get pods --kubeconfig=/x',
  'kubectl get pods --token t',
  'kubectl get pods --token=t',
  'kubectl get pods --server s',
  'kubectl get pods -s s',
  'kubectl get pods -s=s',
  'kubectl get pods --as admin',
  'kubectl get pods --as=admin',
  'kubectl get pods --as-group g',
  'kubectl get pods --as-uid u',
  'kubectl get pods --context c',
  'kubectl get pods --cluster c',
  'kubectl get pods --user u',
  'kubectl get pods --username u',
  'kubectl get pods --password p',
  'kubectl get pods --certificate-authority /ca',
  'kubectl get pods --client-certificate /c',
  'kubectl get pods --client-key /k',
  'kubectl get pods --insecure-skip-tls-verify',
  'kubectl get pods --insecure-skip-tls-verify=true',
  'kubectl get pods --tls-server-name x',
  'kubectl get pods --proxy-url http://evil',
  'kubectl get pods --cache-dir /tmp',
  'kubectl get pods --raw=/x',
  'kubectl get --raw /api/v1/namespaces/x/secrets',
  'kubectl get pods -v=9',
  'kubectl get pods -v 9',
  'kubectl get pods -v9',
  'kubectl get pods --v=8',
  'kubectl get pods --v 8',
  'kubectl get pods --vmodule=a=9',
  'kubectl get pods --log-file=/tmp/x',
  'kubectl get pods --log_file=/tmp/x',
  'kubectl get pods --profile=cpu',
  'kubectl get pods --profile-output=/tmp/x',
  'kubectl get pods -f x.yaml',
  'kubectl get pods -f=x.yaml',
  'kubectl get pods --filename x.yaml',
  'kubectl get pods --filename=x.yaml',
  'kubectl get pods -k dir',
  'kubectl get pods --kustomize dir',
  'kubectl delete -R -f dir',
  'kubectl get pods -R',
  'kubectl get pods -Af',
  'kubectl get pods -o json -v=9',
  'kubectl -s s get pods',
  'kubectl logs -f p1',
  'kubectl logs p1 --follow',
  'kubectl get pods -o go-template-file=/home/sandbox/.kube/config',
  'kubectl get pods -ojsonpath-file=/home/sandbox/.kube/config',
  'kubectl create configmap x --from-file=/home/sandbox/.kube/config',
  'kubectl create configmap x --from-env-file /home/sandbox/.kube/config',
  'kubectl get pods -- --help',
  'kubectl get pods -o --',
]);

// R1: --help anywhere else is not help
test('R1: help flag outside the exact shapes is classified normally', () => {
  assert.equal(classify('kubectl scale deploy/web --replicas --help').kind, 'mutating');
  assert.equal(classify('kubectl get pods --help').kind, 'readonly');
  assert.equal(classify('kubectl delete pod p1 --help').kind, 'mutating');
  assert.ok(classify('kubectl exec p1 --help x').reject);
  assert.ok(classify('kubectl --help get').reject);
  assert.notEqual(classify('kubectl rollout restart deploy/web -h x').kind, 'lookup');
  assert.ok(classify('kubectl get pods --kubeconfig --help').reject);
  assert.notEqual(classify('kubectl explain secrets --help').kind, 'lookup');
  assert.ok(classify('kubectl get secrets --help').reject);
  assert.notEqual(classify('kubectl rollout status deploy/web --help').kind, 'lookup');
});

test('R1: lookup is only the exact shapes', () => {
  for (const command of [
    'kubectl explain pod --recursive --help',
    'kubectl explain pod.spec -o json',
    'kubectl version --client -o wide',
    'kubectl version -o json --kubeconfig=/x',
    'kubectl version --short',
    'kubectl api-versions -o name',
  ]) {
    assert.notEqual(classify(command).kind, 'lookup', command);
  }
  assert.ok(classify('kubectl version -o json --kubeconfig=/x').reject);
});

// R3: secrets
expectReject([
  'kubectl get secrets',
  'kubectl get secret s -o yaml',
  'kubectl describe secret s',
  'kubectl get pods,secrets',
  'kubectl get pods,SECRETS',
  'kubectl get Secret.v1',
  'kubectl get secrets.v1.',
  'kubectl get secret/s',
  'kubectl get -n x secrets',
  'kubectl delete secret s',
  'kubectl patch secret s -p x',
  'kubectl create secret generic s --from-literal=a=b',
  'kubectl create token sa',
  'kubectl create token sa --duration 1h',
  'kubectl set env deploy/web --from=secret/s',
  'kubectl set env deploy/web --list --resolve',
]);

test('R3: secrets-free resources are still allowed', () => {
  assert.equal(classify('kubectl get all').kind, 'readonly');
  assert.equal(classify('kubectl get pods,services,configmaps').kind, 'readonly');
  assert.equal(classify('kubectl get serviceaccounts').kind, 'readonly');
  assert.equal(classify('kubectl set env deploy/web A=b').kind, 'mutating');
});

// Flag-value confusion: the verb and sub-verb cannot be smuggled behind a flag.
expectReject([
  'kubectl -o get delete pod p1',
  'kubectl --request-timeout 5s delete pod p1',
  'kubectl rollout -o status restart deploy/web',
  'kubectl rollout --namespace=x status restart deploy/web',
  'kubectl top --sort-by pods',
]);
test('flag-value confusion: -n before the verb is fine', () => {
  assert.equal(classify('kubectl -n dev rollout status deploy/web').kind, 'readonly');
  assert.equal(classify('kubectl --namespace dev rollout restart deploy/web').kind, 'mutating');
});

test('namespace before the verb: attached and = forms', () => {
  assert.equal(classify('kubectl -nkube-system get pods').kind, 'readonly');
  assert.equal(classify('kubectl --namespace=dev get pods').kind, 'readonly');
  assert.equal(classify('kubectl -nkube-system delete pod p').kind, 'mutating');
  assert.equal(classify('kubectl --namespace=dev -n dev delete pod p').kind, 'mutating');
  assert.equal(classify('kubectl -nkube-system get pods').verb, 'get');
});

expectReject([
  'kubectl -nkube-system get secrets',
  'kubectl --namespace=dev get secret s -o yaml',
  'kubectl -ndev describe secret s',
]);

// The namespace value is validated in every form, so no flag can hide in it.
expectReject([
  'kubectl -n Bad get pods',
  'kubectl -n -o get pods',
  'kubectl -n',
  'kubectl -nBad get pods',
  'kubectl -n=dev get pods',
  'kubectl --namespace= get pods',
  'kubectl --namespace=a_b get pods',
  'kubectl --namespace=-x get pods',
  'kubectl -nkube-system',
]);

// Fix round 1: -o is an allowlist; templatefile reads the stored kubeconfig.
expectReject([
  'kubectl get pods -o templatefile --template=/home/sandbox/.kube/config',
  'kubectl get pods -otemplatefile --template /home/sandbox/.kube/config',
  'kubectl get pods --output=templatefile --template=/home/sandbox/.kube/config',
  'kubectl get pods --output templatefile --template /home/sandbox/.kube/config',
  'kubectl get pods -o=templatefile',
  'kubectl get pods -Ao templatefile',
  'kubectl get pods -o',
  'kubectl get pods -o=',
  'kubectl get pods --output=',
  'kubectl get pods -o go-template-file=/x',
  'kubectl get pods -o go-template',
  'kubectl get pods -o JSON',
  'kubectl get pods --template={{.}}',
  'kubectl get pods --template {{.}}',
]);
expectKind('readonly', [
  'kubectl get pods -o json',
  'kubectl get pods -ojson',
  'kubectl get pods -o=json',
  'kubectl get pods -o yaml',
  'kubectl get pods -oyaml',
  'kubectl get pods --output yaml',
  'kubectl get pods --output=wide',
  'kubectl get pods -o name',
  'kubectl get pods -o jsonpath={.items[0].metadata.name}',
  'kubectl get pods -ocustom-columns=NAME:.metadata.name',
  'kubectl get pods -o go-template={{.items}}',
  'kubectl get pods -o template={{.items}}',
  'kubectl get pods -Ao json',
]);
test('fix round 1: version -o json|yaml is still lookup', () => {
  assert.equal(classify('kubectl version -o json').kind, 'lookup');
  assert.equal(classify('kubectl version --client -o yaml').kind, 'lookup');
  assert.ok(classify('kubectl version -o templatefile').kind !== 'lookup');
});
