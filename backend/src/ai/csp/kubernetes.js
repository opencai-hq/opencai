const { z } = require('zod');
const YAML = require('yaml');

const { SANDBOX_IMAGE_TAGS } = require('../constants');
const {
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
} = require('../policy/patterns/kubernetes');

const KUBECONFIG_PATH = '/home/sandbox/.kube/config';
const EXEC_MESSAGE =
  'Kubeconfig exec/auth-provider plugins are not supported; use a token or client certificate';
const FILE_PATH_MESSAGE =
  'Kubeconfig must embed its credentials (certificate-authority-data, client-certificate-data, client-key-data or token); file paths are not supported';
const NO_CREDENTIAL_MESSAGE =
  'Kubeconfig user needs a token or client-certificate-data with client-key-data';

const NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value.length > 0;

/** Returns an error message for an unusable kubeconfig, or null. */
function kubeconfigProblem(text) {
  let doc;
  try {
    doc = YAML.parse(text);
  } catch {
    return 'Kubeconfig is not valid YAML';
  }
  if (!isObject(doc)) return 'Kubeconfig must be a YAML mapping';

  const list = (key) => (Array.isArray(doc[key]) ? doc[key] : []);
  const users = list('users');
  const clusters = list('clusters');
  const contexts = list('contexts');

  // Plugins would run a binary the sandbox does not have; refuse them wherever
  // they appear.
  if (users.some((u) => isObject(u?.user) && ('exec' in u.user || 'auth-provider' in u.user))) {
    return EXEC_MESSAGE;
  }
  if (contexts.length !== 1) return 'Kubeconfig must contain exactly one context';
  if (clusters.length !== 1) return 'Kubeconfig must contain exactly one cluster';
  if (users.length !== 1) return 'Kubeconfig must contain exactly one user';

  const [context] = contexts;
  const [cluster] = clusters;
  const [user] = users;
  if (context?.context?.cluster !== cluster?.name || context?.context?.user !== user?.name) {
    return 'Kubeconfig context must reference its cluster and user by name';
  }
  if (doc['current-context'] !== context.name) {
    return 'Kubeconfig current-context must name the single context';
  }
  if (!isObject(cluster.cluster) || !nonEmpty(cluster.cluster.server)) {
    return 'Kubeconfig cluster needs a server';
  }
  const u = user.user;
  if (!isObject(u)) return NO_CREDENTIAL_MESSAGE;

  if (
    'certificate-authority' in cluster.cluster ||
    'client-certificate' in u ||
    'client-key' in u ||
    'tokenFile' in u ||
    'token-file' in u
  ) {
    return FILE_PATH_MESSAGE;
  }
  const hasToken = nonEmpty(u.token);
  const hasCert = nonEmpty(u['client-certificate-data']) && nonEmpty(u['client-key-data']);
  if (!hasToken && !hasCert) return NO_CREDENTIAL_MESSAGE;
  return null;
}

const credentialSchema = z.object({
  kubeconfig: z
    .string()
    .min(1)
    .superRefine((text, ctx) => {
      const problem = kubeconfigProblem(text);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    }),
  namespace: z
    .string()
    .regex(NAMESPACE, 'namespace must be a valid Kubernetes name')
    .optional(),
});

// The kubeconfig is a secret, so it is written by prepareSandbox and never put in
// the environment of a model-proposed command.
async function buildEnv() {
  return { KUBECONFIG: KUBECONFIG_PATH };
}

// Fixed and backend-owned, like the Azure sign-in: nothing in either script comes
// from the model or the Operator, and the values arrive through the exec env.
const WRITE_KUBECONFIG_SCRIPT =
  'mkdir -p "$HOME/.kube" && umask 077 && printf \'%s\' "$OPENCAI_KUBECONFIG" > "$HOME/.kube/config"';
const SET_NAMESPACE_SCRIPT =
  'kubectl config set-context --current --namespace "$OPENCAI_NAMESPACE"';

/**
 * Write the kubeconfig into a newly created sandbox's tmpfs home.
 *
 * @param {{ credential: object,
 *           exec: (argv: string[], env: Record<string, string>) => Promise<object> }} params
 */
async function prepareSandbox({ credential, exec }) {
  const { kubeconfig, namespace } = credential ?? {};
  if (!kubeconfig) {
    throw new Error('Incomplete Kubernetes credential payload');
  }
  const env = await buildEnv();
  const run = async (script, extraEnv) => {
    const result = await exec(['sh', '-c', script], { ...env, ...extraEnv });
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(
        result.timedOut
          ? 'Kubernetes sign-in timed out'
          : `Kubernetes sign-in exited ${result.exitCode}`,
      );
    }
  };
  await run(WRITE_KUBECONFIG_SCRIPT, { OPENCAI_KUBECONFIG: kubeconfig });
  if (namespace) {
    await run(SET_NAMESPACE_SCRIPT, { OPENCAI_NAMESPACE: namespace });
  }
}

/** The token if it is a forbidden flag, else null. Scans `--x`, `--x=v`, `-x`, `-x=v`, `-xv`. */
function blockedFlagReason(token) {
  // `-o go-template-file=/path` carries the file-reading format as a separate word.
  if (FILE_READING_FORMAT.test(token)) return token;
  if (!token.startsWith('-') || token === '-') return null;
  if (token.startsWith('--')) {
    const name = token.slice(2).split('=')[0].replace(/_/g, '-');
    if (BLOCKED_LONG_FLAGS.has(name) || BLOCKED_LONG_PREFIXES.some((p) => name.startsWith(p))) {
      return token;
    }
  } else {
    // pflag reads `-lapp=x` as -l with a value and `-Af` as two flags.
    const head = token.slice(1).split('=')[0];
    const chars = VALUE_SHORT_FLAGS.has(head[0]) ? head[0] : head;
    if ([...chars].some((c) => BLOCKED_SHORT_FLAGS.has(c))) return token;
  }
  if (FILE_READING_FLAG.test(token)) return token;
  return null;
}

// "pods,SECRETS", "Secret.v1", "secret/name" -> does any resource kind name a Secret?
function namesSecret(token) {
  return token
    .toLowerCase()
    .split(',')
    .some((part) => {
      const kind = part.split('/')[0].split('.')[0];
      return kind === 'secret' || kind === 'secrets';
    });
}

// Only these output formats. `templatefile`, `go-template-file` and friends read
// the file named by --template, and the kubeconfig is one of the sandbox's files.
const OUTPUT_FORMATS = new Set(['json', 'yaml', 'wide', 'name']);
const OUTPUT_PREFIXES = ['jsonpath=', 'custom-columns=', 'go-template=', 'template='];
const outputAllowed = (value) =>
  typeof value === 'string' &&
  (OUTPUT_FORMATS.has(value) || OUTPUT_PREFIXES.some((p) => value.startsWith(p)));

/** The reason an -o/--output (or --template) flag is refused, or null. All spellings. */
function outputFlagReason(t) {
  for (let i = 0; i < t.length; i += 1) {
    const token = t[i];
    if (token === '--template' || token.startsWith('--template=')) return token;
    let value;
    let found = false;
    if (token.startsWith('--')) {
      const [name, ...rest] = token.slice(2).split('=');
      if (name === 'output') {
        found = true;
        value = rest.length ? rest.join('=') : t[i + 1];
      }
    } else if (token.startsWith('-') && token.length > 1) {
      // pflag: bool flags, then the first value-taking flag takes the rest of the
      // cluster (after an optional "=") or the next word.
      const body = token.slice(1);
      for (let c = 0; c < body.length; c += 1) {
        if (!VALUE_SHORT_FLAGS.has(body[c])) continue;
        if (body[c] === 'o') {
          found = true;
          const rest = body.slice(c + 1);
          value = rest === '' ? t[i + 1] : rest.replace(/^=/, '');
        }
        break;
      }
    }
    if (found && !outputAllowed(value)) return token;
  }
  return null;
}

const WORD = /^[a-z][a-z-]*$/;
const isHelp = (token) => token === '--help' || token === '-h';

/** The exact shapes that only print help or schema text; null for anything else. */
function lookupShape(t) {
  // Go flag parsers take the next token as a flag's value even if it starts with
  // "-", so "--help" is help only where nothing precedes it that could consume it.
  if (t.length === 1 && isHelp(t[0])) return { verb: null };
  if (t.length === 2 && isHelp(t[1]) && WORD.test(t[0])) return { verb: t[0] };
  if (t.length === 3 && isHelp(t[2]) && GROUPED_VERBS.has(t[0]) && WORD.test(t[1])) {
    return { verb: `${t[0]} ${t[1]}` };
  }
  if (t[0] === 'explain' && (t.length === 2 || (t.length === 3 && t[2] === '--recursive'))) {
    if (/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(t[1])) return { verb: 'explain' };
  }
  if ((t[0] === 'api-resources' || t[0] === 'api-versions') && t.length === 1) {
    return { verb: t[0] };
  }
  if (t[0] === 'version') {
    const rest = t.slice(1);
    let ok = true;
    for (let i = 0; i < rest.length && ok; i += 1) {
      if (rest[i] === '--client') continue;
      if (rest[i] === '-o' && ['json', 'yaml'].includes(rest[i + 1])) i += 1;
      else ok = false;
    }
    if (ok) return { verb: 'version' };
  }
  return null;
}

/** Classify `kubectl [-n ns] <verb> [<subverb>] [args]`. */
function classifyOperation(argv) {
  const t = argv.slice(1);

  const help = lookupShape(t);
  if (help) return { kind: 'lookup', verb: help.verb, dryRunCapable: false };

  // After a bare `--` the CLI stops reading flags.
  if (t.includes('--')) return { reject: 'A bare "--" is not allowed' };

  const blocked = t.map(blockedFlagReason).find(Boolean) ?? outputFlagReason(t);
  if (blocked) {
    return { reject: `The option "${blocked}" is not available in this environment` };
  }

  // The verb is the first word, after only namespace flags (`-n X`, `-nX`,
  // `--namespace X`, `--namespace=X`). Any other flag before it could swallow the
  // next word as its value and change which command runs.
  let i = 0;
  for (;;) {
    let namespace;
    if (t[i] === '-n' || t[i] === '--namespace') {
      namespace = t[i + 1];
      i += 2;
    } else if (t[i]?.startsWith('--namespace=')) {
      namespace = t[i].slice('--namespace='.length);
      i += 1;
    } else if (t[i]?.startsWith('-n') && !t[i].startsWith('--')) {
      namespace = t[i].slice(2);
      i += 1;
    } else {
      break;
    }
    if (typeof namespace !== 'string' || !NAMESPACE.test(namespace)) {
      return { reject: `Invalid namespace "${namespace ?? ''}"` };
    }
  }
  const verb = t[i];
  if (!verb || verb.startsWith('-')) return { reject: 'Command is missing a kubectl verb' };

  // `auth can-i get secrets` only asks a question; every other command naming a
  // Secret could read or print one.
  if (verb !== 'auth' && t.slice(i).some((x) => !x.startsWith('-') && namesSecret(x))) {
    return { reject: 'Kubernetes Secrets are not available in this environment' };
  }

  if (GROUPED_VERBS.has(verb)) {
    // The sub-verb must follow the verb directly, for the same reason.
    const sub = t[i + 1];
    if (!sub || sub.startsWith('-')) return { reject: `"kubectl ${verb}" needs a sub-command` };
    const name = `${verb} ${sub}`;
    if (verb === 'create' && sub === 'token') {
      return { reject: '"kubectl create token" is not available in this environment' };
    }
    if (verb === 'create' && sub === 'secret') {
      return { reject: 'Kubernetes Secrets are not available in this environment' };
    }
    if (
      verb === 'set' &&
      sub === 'env' &&
      t.some((x) => SET_ENV_BLOCKED_PREFIXES.some((p) => x.startsWith(p)))
    ) {
      return { reject: 'The option --from/--resolve is not available for "kubectl set env"' };
    }
    if (READONLY_SUBVERBS[verb]?.has(sub)) {
      return { kind: 'readonly', verb: name, dryRunCapable: false };
    }
    if (MUTATING_SUBVERBS[verb]?.has(sub)) {
      return { kind: 'mutating', verb: name, dryRunCapable: false };
    }
    return { reject: `"kubectl ${name}" is not available in this environment` };
  }

  if (verb === 'cluster-info' && t.length > i + 1 && !t[i + 1].startsWith('-')) {
    return { reject: '"kubectl cluster-info dump" is not available in this environment' };
  }

  if (READONLY_VERBS.has(verb)) return { kind: 'readonly', verb, dryRunCapable: false };
  if (MUTATING_VERBS.has(verb)) return { kind: 'mutating', verb, dryRunCapable: false };

  return {
    reject: `Unrecognized operation "${verb}" -- neither a known read-only nor mutating pattern`,
  };
}

const promptRules = [
  'Use -o json for structured output, for example "kubectl get pods -A -o json".',
  'To check syntax, use run_lookup with "kubectl <verb> --help" or "kubectl explain <resource>".',
  'exec, cp, port-forward, proxy, run, edit, debug and attach are unavailable.',
  'Secrets are not readable or creatable.',
  'Applying from files (apply, create -f, -f/--filename) is unavailable; use imperative commands such as scale, set image and rollout restart.',
  'Do not pass --kubeconfig, --context, --server, --token or --as; the cluster and namespace are preselected.',
];

module.exports = {
  label: 'Kubernetes',
  binary: 'kubectl',
  sandboxImage: SANDBOX_IMAGE_TAGS.KUBERNETES,
  credentialSchema,
  buildEnv,
  prepareSandbox,
  classifyOperation,
  supportsRegions: false,
  promptRules,
  dashboardOutputHint: 'add -o json',
};
