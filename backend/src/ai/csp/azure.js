const { z } = require('zod');

const { SANDBOX_IMAGE_TAGS } = require('../constants');
const { commandPath, blockedPrefix, matchesVerb } = require('./grammar');
const {
  READONLY_EXACT_VERBS,
  READONLY_PREFIXES,
  MUTATING_EXACT_VERBS,
  MUTATING_PREFIXES,
  BLOCKED_PATHS,
} = require('../policy/patterns/azure');

// A service principal with a client secret, scoped to one subscription.
const credentialSchema = z.object({
  tenantId: z.guid(),
  clientId: z.guid(),
  clientSecret: z.string().min(1),
  subscriptionId: z.guid(),
});

// Non-secret settings only. The Azure CLI cannot authenticate from environment
// variables, so the secret is used once, by prepareSandbox, and model-proposed
// commands never have it in their environment.
async function buildEnv() {
  return {
    AZURE_CORE_COLLECT_TELEMETRY: 'false',
    AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no',
  };
}

// Fixed and backend-owned: the only shell string in the product. Nothing in it
// comes from the model or the Operator, and the secret reaches it through the
// exec's environment, never through argv.
const LOGIN_SCRIPT =
  'az login --service-principal --username "$AZURE_CLIENT_ID" --password "$AZURE_CLIENT_SECRET" --tenant "$AZURE_TENANT_ID" --output none && az account set --subscription "$AZURE_SUBSCRIPTION_ID"';

/**
 * Sign a newly created sandbox in. The token cache lives in the container's
 * tmpfs home and is gone when the container is.
 *
 * @param {{ credential: object,
 *           exec: (argv: string[], env: Record<string, string>) => Promise<object> }} params
 */
async function prepareSandbox({ credential, exec }) {
  const { tenantId, clientId, clientSecret, subscriptionId } = credential ?? {};
  if (!tenantId || !clientId || !clientSecret || !subscriptionId) {
    throw new Error('Incomplete Azure credential payload');
  }
  const result = await exec(['sh', '-c', LOGIN_SCRIPT], {
    ...(await buildEnv()),
    AZURE_TENANT_ID: tenantId,
    AZURE_CLIENT_ID: clientId,
    AZURE_CLIENT_SECRET: clientSecret,
    AZURE_SUBSCRIPTION_ID: subscriptionId,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(
      result.timedOut ? 'Azure sign-in timed out' : `Azure sign-in exited ${result.exitCode}`,
    );
  }
}

/** Classify `az <group> [subgroup...] <verb> [--options]`. */
function classifyOperation(argv) {
  // After a bare `--` the CLI stops reading options, so a later "--help" would
  // be an ordinary value while still looking like a help request here.
  if (argv.includes('--')) {
    return { reject: 'A bare "--" is not allowed' };
  }

  const path = commandPath(argv);

  // Help is printed from the CLI's bundled text, whatever it is attached to.
  if (argv.includes('--help') || argv.includes('-h')) {
    return { kind: 'lookup', verb: path[path.length - 1] ?? null, dryRunCapable: false };
  }

  const blocked = blockedPrefix(path, BLOCKED_PATHS);
  if (blocked) {
    return { reject: `"az ${blocked.join(' ')}" is not available in this environment` };
  }

  if (path.length < 2) {
    return { reject: 'Command is missing a command group or operation' };
  }

  // Mutating patterns are checked first so that a verb matching both lists is
  // treated as the more dangerous one.
  const verb = path[path.length - 1];
  if (matchesVerb(verb, MUTATING_EXACT_VERBS, MUTATING_PREFIXES)) {
    return { kind: 'mutating', verb, dryRunCapable: false };
  }
  if (matchesVerb(verb, READONLY_EXACT_VERBS, READONLY_PREFIXES)) {
    return { kind: 'readonly', verb, dryRunCapable: false };
  }

  return {
    reject: `Unrecognized operation "${verb}" -- neither a known read-only nor mutating pattern`,
  };
}

const promptRules = [
  'To check syntax, use run_lookup with "az <group> <command> --help".',
  'The sandbox is already signed in and the subscription is already selected. Do not run az login, az account set, az configure or az extension; they are rejected.',
  'Write the command words first and every option after them, for example "az vm list --resource-group my-rg --output json".',
  'The "regions" tool argument is not available on Azure. List commands already cover every location in the subscription; narrow them with --query or the command\'s own location option.',
  'For cost questions use "az costmanagement query" or "az consumption usage list". To search across resource types use "az graph query" or "az resource list".',
];

module.exports = {
  label: 'Microsoft Azure',
  dashboardOutputHint: '--output json',
  binary: 'az',
  sandboxImage: SANDBOX_IMAGE_TAGS.AZURE,
  credentialSchema,
  buildEnv,
  prepareSandbox,
  classifyOperation,
  supportsRegions: false,
  promptRules,
};
