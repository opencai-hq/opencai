const { z } = require('zod');

const { SANDBOX_IMAGE_TAGS } = require('../constants');
const { matchesVerb } = require('./grammar');
const {
  REJECTED_EXACT,
  REJECTED_PREFIXES,
  BLOCKED_FLAGS,
  BLOCKED_FLAG_PREFIXES,
  READONLY_EXACT,
  READONLY_SUFFIXES,
  MUTATING_EXACT,
  MUTATING_PREFIXES,
  MUTATING_SUFFIXES,
} = require('../policy/patterns/vsphere');

const httpsUrl = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'url must be an https URL');

// The admin form may send either a boolean or its string form.
const insecure = z
  .union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')])
  .default(false);

const credentialSchema = z.object({
  url: httpsUrl,
  username: z.string().min(1),
  password: z.string().min(1),
  insecure,
  datacenter: z.string().min(1).optional(),
});

// govc authenticates from GOVC_* environment variables, as the AWS CLI does, so
// there is no prepareSandbox.
async function buildEnv(credential) {
  const { url, username, password, insecure: skipVerify, datacenter } = credential ?? {};
  if (!url || !username || !password) {
    throw new Error('Incomplete vSphere credential payload');
  }
  const env = {
    GOVC_URL: url,
    GOVC_USERNAME: username,
    GOVC_PASSWORD: password,
    GOVC_INSECURE: skipVerify === true || skipVerify === 'true' ? '1' : '0',
  };
  if (datacenter) env.GOVC_DATACENTER = datacenter;
  return env;
}

/** Classify `govc <command> [options] [args]`; the command is argv[1]. */
function classifyOperation(argv) {
  const command = argv[1];

  // Global client flags can redirect or expose the credential, whatever the
  // command is, so they are refused before any verdict.
  const blockedFlag = argv.slice(1).find((arg) => {
    const m = /^--?([^=]+)/.exec(arg);
    if (!m) return false;
    return BLOCKED_FLAGS.includes(m[1]) || BLOCKED_FLAG_PREFIXES.some((p) => m[1].startsWith(p));
  });
  if (blockedFlag) {
    return { reject: `The option "${blockedFlag}" is not available in this environment` };
  }

  // Go's flag parser can take "-h" as another flag's value, so only these exact
  // shapes are help: `-h`, `<cmd> -h`, `help`, `help <cmd>`.
  const isHelp =
    (argv.length === 2 && command === '-h') ||
    (argv.length === 3 && argv[2] === '-h' && !command.startsWith('-')) ||
    (command === 'help' && argv.length <= 3);
  if (isHelp) {
    const verb = argv[1] === 'help' ? (argv[2] ?? null) : command === '-h' ? null : command;
    return { kind: 'lookup', verb, dryRunCapable: false };
  }

  if (!command || command.startsWith('-')) {
    return { reject: 'Command is missing a govc command name' };
  }

  if (matchesVerb(command, REJECTED_EXACT, REJECTED_PREFIXES)) {
    return { reject: `"govc ${command}" is not available in this environment` };
  }

  // Read-only is checked before mutating so `*.info` beats any mutating prefix.
  if (
    READONLY_EXACT.includes(command) ||
    READONLY_SUFFIXES.some((suffix) => command.endsWith(suffix))
  ) {
    return { kind: 'readonly', verb: command, dryRunCapable: false };
  }

  if (
    matchesVerb(command, MUTATING_EXACT, MUTATING_PREFIXES) ||
    MUTATING_SUFFIXES.some((suffix) => command.endsWith(suffix))
  ) {
    return { kind: 'mutating', verb: command, dryRunCapable: false };
  }

  return {
    reject: `Unrecognized operation "${command}" -- neither a known read-only nor mutating pattern`,
  };
}

const promptRules = [
  'Use -json for structured output, for example "govc vm.info -json my-vm".',
  'To check syntax, use run_lookup with "govc <command> -h".',
  'The datacenter is preselected when one is configured; do not pass -dc unless you need another.',
  'guest.* commands and datastore file transfer (upload and download) are unavailable.',
];

module.exports = {
  label: 'VMware vSphere',
  binary: 'govc',
  sandboxImage: SANDBOX_IMAGE_TAGS.VSPHERE,
  credentialSchema,
  buildEnv,
  classifyOperation,
  supportsRegions: false,
  promptRules,
  dashboardOutputHint: 'add -json',
};
