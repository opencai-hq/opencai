// kubectl is `kubectl [-n ns] <verb> [<subverb>] [args] [flags]`. Classification
// keys on the verb (and, for grouped verbs, the sub-verb right after it).

// Global and connection flags that redirect, expose or widen the credential, or
// read local files, whatever the verb is. Matched on the flag name with
// underscores normalised to hyphens (kubectl treats `--log_file` as `--log-file`).
const BLOCKED_LONG_FLAGS = new Set([
  'kubeconfig',
  'kuberc',
  'server',
  'token',
  'as',
  'as-group',
  'as-uid',
  'as-user-extra',
  'context',
  'cluster',
  'user',
  'username',
  'password',
  'certificate-authority',
  'client-certificate',
  'client-key',
  'insecure-skip-tls-verify',
  'insecure-skip-tls-verify-backend',
  'tls-server-name',
  'proxy-url',
  'cache-dir',
  'raw', // bypasses resource rules, e.g. get --raw /api/v1/namespaces/x/secrets
  'v', // -v >= 8 logs request headers
  'vmodule',
  'log-file',
  'profile',
  'profile-output',
  'filename',
  'kustomize',
  'follow', // would hold the exec open until the timeout
]);
const BLOCKED_LONG_PREFIXES = ['log-'];

// Single-character flags, scanned inside short-flag clusters.
const BLOCKED_SHORT_FLAGS = new Set(['s', 'v', 'f', 'k', 'R']);
// Short flags that take a value; the rest of their cluster is that value.
const VALUE_SHORT_FLAGS = new Set(['n', 'l', 'o', 'c', 'L']);

// `--from-file`, `--patch-file`... and `-o go-template-file=` read sandbox files,
// and the kubeconfig is one of them.
const FILE_READING_FLAG = /^--?[a-z-]*-file(=|$)/i;
const FILE_READING_FORMAT = /(go-template|jsonpath|custom-columns|template)-file/i;

const GROUPED_VERBS = new Set(['rollout', 'auth', 'set', 'create', 'top']);

const READONLY_VERBS = new Set([
  'get',
  'describe',
  'logs',
  'events',
  'cluster-info',
  'api-resources',
  'api-versions',
  'version',
  'explain',
]);
const READONLY_SUBVERBS = {
  rollout: new Set(['status', 'history']),
  auth: new Set(['can-i', 'whoami']),
  top: new Set(['pods', 'pod', 'po', 'nodes', 'node', 'no']),
};

const MUTATING_VERBS = new Set([
  'scale',
  'delete',
  'cordon',
  'uncordon',
  'drain',
  'label',
  'annotate',
  'taint',
  'patch',
  'expose',
  'autoscale',
]);
const MUTATING_SUBVERBS = {
  rollout: new Set(['restart', 'undo', 'pause', 'resume']),
  set: new Set(['image', 'resources', 'selector', 'serviceaccount', 'subject', 'env']),
  // No `secret` (secret material would pass through the model) and no `token`
  // (it prints a minted ServiceAccount token).
  create: new Set([
    'namespace',
    'deployment',
    'service',
    'configmap',
    'serviceaccount',
    'role',
    'rolebinding',
    'clusterrole',
    'clusterrolebinding',
    'job',
    'cronjob',
    'ingress',
    'quota',
    'poddisruptionbudget',
    'priorityclass',
  ]),
};

// `set env --from=secret/x --list` (or --resolve) prints secret values.
const SET_ENV_BLOCKED_PREFIXES = ['--from', '--resolve'];

module.exports = {
  BLOCKED_LONG_FLAGS,
  BLOCKED_LONG_PREFIXES,
  BLOCKED_SHORT_FLAGS,
  VALUE_SHORT_FLAGS,
  FILE_READING_FLAG,
  FILE_READING_FORMAT,
  GROUPED_VERBS,
  READONLY_VERBS,
  READONLY_SUBVERBS,
  MUTATING_VERBS,
  MUTATING_SUBVERBS,
  SET_ENV_BLOCKED_PREFIXES,
};
