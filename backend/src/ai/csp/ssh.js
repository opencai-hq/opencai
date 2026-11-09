const net = require('node:net');
const path = require('node:path');
const { z } = require('zod');

const { SANDBOX_IMAGE_TAGS } = require('../constants');
const { READONLY, MUTATING, READABLE_DIR, READABLE_FILES } = require('../policy/patterns/linux');

// --- credential ----------------------------------------------------------------

const USERNAME = /^[a-z_][a-z0-9_.-]{0,31}$/;
const HOST_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DNS_NAME =
  /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** A hostname, IPv4 or IPv6 address safe to write into ssh_config. */
function isAddress(value) {
  if (typeof value !== 'string' || /[\s%#'"\\]/.test(value) || value.startsWith('-')) return false;
  if (net.isIPv4(value) || net.isIPv6(value)) return true;
  return DNS_NAME.test(value) && !/^[\d.]+$/.test(value);
}

const OPENSSH_MAGIC = Buffer.from('openssh-key-v1\0');

/** An error message for an unusable private key, or null. */
function privateKeyProblem(text) {
  if (!text.includes('-----BEGIN') || !text.includes('PRIVATE KEY-----')) {
    return 'Private key must be a PEM or OpenSSH private key';
  }
  if (text.includes('\0')) return 'Private key contains invalid characters';
  if (text.includes('Proc-Type: 4,ENCRYPTED') || text.includes('BEGIN ENCRYPTED PRIVATE KEY')) {
    return 'Private key must not be passphrase-protected';
  }
  const openssh =
    /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(text);
  if (openssh) {
    const body = Buffer.from(openssh[1].replace(/\s+/g, ''), 'base64');
    const at = OPENSSH_MAGIC.length;
    const ok =
      body.length >= at + 8 &&
      body.subarray(0, at).equals(OPENSSH_MAGIC) &&
      body.readUInt32BE(at) === 4 &&
      body.subarray(at + 4, at + 8).toString('latin1') === 'none';
    if (!ok) return 'Private key must not be passphrase-protected';
  }
  return null;
}

const hostSchema = z.object({
  name: z.string().regex(HOST_NAME, 'Host name must be lowercase letters, digits and hyphens'),
  address: z.string().refine(isAddress, 'Address must be a hostname or IP address'),
  port: z.number().int().min(1).max(65535).default(22),
});

const credentialSchema = z.object({
  username: z.string().regex(USERNAME, 'Username must be a valid Linux user name'),
  privateKey: z
    .string()
    .max(16384)
    .superRefine((text, ctx) => {
      const problem = privateKeyProblem(text);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    }),
  hosts: z
    .array(hostSchema)
    .min(1)
    .max(50)
    .refine(
      (hosts) => new Set(hosts.map((h) => h.name)).size === hosts.length,
      'Host names must be unique',
    ),
  knownHosts: z
    .string()
    .max(65536)
    .refine((text) => !text.includes('\0'), 'known_hosts contains invalid characters')
    .optional(),
});

// --- sandbox -------------------------------------------------------------------

// The key and host list are written by prepareSandbox; model-proposed commands
// get no secret in their environment.
async function buildEnv() {
  return {};
}

/**
 * The client config. Hardening comes before the Host blocks because ssh keeps
 * the first value it reads for each option; the final `Host *` sends any alias
 * that is not a configured host to a name that cannot resolve.
 */
function renderSshConfig(credential) {
  const { username, hosts, knownHosts } = credential;
  const global = [
    `StrictHostKeyChecking ${knownHosts ? 'yes' : 'accept-new'}`,
    'BatchMode yes',
    'IdentitiesOnly yes',
    'IdentityFile ~/.ssh/id',
    'IdentityAgent none',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'ProxyCommand none',
    'ProxyJump none',
    'PermitLocalCommand no',
    'RemoteCommand none',
    'ForwardAgent no',
    'ForwardX11 no',
    'ClearAllForwardings yes',
    'RequestTTY no',
    'EscapeChar none',
    'ControlMaster no',
    'ControlPath none',
    'CanonicalizeHostname no',
    'VerifyHostKeyDNS no',
    'GlobalKnownHostsFile /dev/null',
    'UserKnownHostsFile ~/.ssh/known_hosts',
    'UpdateHostKeys no',
    'LogLevel ERROR',
    'ConnectTimeout 15',
    'ServerAliveInterval 15',
    'ServerAliveCountMax 2',
  ];
  const blocks = hosts.map(
    (h) => `Host ${h.name}\n  HostName ${h.address}\n  Port ${h.port}\n  User ${username}`,
  );
  return `${global.join('\n')}\n\n${blocks.join('\n\n')}\n\nHost *\n  HostName invalid.invalid\n`;
}

// A key pasted on Windows arrives with CRLF, which ssh cannot parse.
const lf = (text) => text.replace(/\r\n/g, '\n');

// Fixed and backend-owned; every value arrives through the exec env.
const SETUP_SCRIPT = [
  'umask 077',
  'mkdir -p "$HOME/.ssh"',
  'printf \'%s\\n\' "$OPENCAI_SSH_KEY" > "$HOME/.ssh/id"',
  'printf \'%s\' "$OPENCAI_SSH_CONFIG" > "$HOME/.ssh/config"',
  '{ [ -z "$OPENCAI_KNOWN_HOSTS" ] || printf \'%s\\n\' "$OPENCAI_KNOWN_HOSTS" > "$HOME/.ssh/known_hosts"; }',
].join(' && ');

/**
 * Write the key, client config and known_hosts into a new sandbox's tmpfs home.
 *
 * @param {{ credential: object,
 *           exec: (argv: string[], env: Record<string, string>) => Promise<object> }} params
 */
async function prepareSandbox({ credential, exec }) {
  // Re-validated: the config is generated from these fields.
  const parsed = credentialSchema.safeParse(credential);
  if (!parsed.success) throw new Error('Invalid SSH credential payload');
  const cred = parsed.data;
  const env = {
    OPENCAI_SSH_KEY: lf(cred.privateKey),
    OPENCAI_SSH_CONFIG: renderSshConfig(cred),
    ...(cred.knownHosts ? { OPENCAI_KNOWN_HOSTS: lf(cred.knownHosts) } : {}),
  };
  const result = await exec(['sh', '-c', SETUP_SCRIPT], env);
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(
      result.timedOut ? 'SSH setup timed out' : `SSH setup exited ${result.exitCode}`,
    );
  }
}

// --- policy hooks ------------------------------------------------------------------

/** The configured host names. Total: anything malformed yields no hosts. */
function policyContext(credential) {
  const hosts = Array.isArray(credential?.hosts) ? credential.hosts : [];
  const hostNames = hosts
    .map((h) => h?.name)
    .filter((name) => typeof name === 'string' && HOST_NAME.test(name));
  return { hostNames };
}

const shQuote = (word) => `'${String(word).replace(/'/g, "'\\''")}'`;

/**
 * The remote command is a string run by the login shell, so every word is
 * single-quoted. Quoted words start with "'" and follow "--", so ssh never reads
 * them as its own options.
 */
function toExecArgv(argv) {
  if (!Array.isArray(argv)) return argv;
  return ['ssh', argv[1], '--', ...argv.slice(2).map(shQuote)];
}

// --- classification ----------------------------------------------------------------

// Plain words only: no quotes, backslashes, `$`, globs or non-ASCII, which some
// remote shells treat specially even inside single quotes.
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./ -]+$/;
const FOLLOW = new Set(['-f', '-F', '--follow']);
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

const PATH_CHARS = /^\/[A-Za-z0-9_.@+,:=/-]*$/;

function readablePath(p) {
  if (!PATH_CHARS.test(p) || path.posix.normalize(p) !== p) return false;
  return READABLE_FILES.has(p) || p === READABLE_DIR || p.startsWith(`${READABLE_DIR}/`);
}

/** Why `args` do not fit `spec`, or null. */
function argsProblem(spec, args, label) {
  if (spec.check) return spec.check(args);
  const flags = spec.flags ?? {};
  const seen = new Set();
  const positionals = [];
  const refuse = (t) =>
    FOLLOW.has(t.split('=')[0])
      ? `Following output is not available for "${label}"; read a fixed number of lines instead`
      : `The option "${t}" is not available for "${label}"`;

  for (let i = 0; i < args.length; i += 1) {
    const t = args[i];
    if (t === '--') return 'A bare "--" is not allowed';
    if (!t.startsWith('-') || t === '-') {
      positionals.push(t);
      continue;
    }
    const eq = t.startsWith('--') ? t.indexOf('=') : -1;
    const name = eq === -1 ? t : t.slice(0, eq);
    const rule = own(flags, name);
    if (rule === true || rule === 'solo') {
      if (eq !== -1) return refuse(t);
      seen.add(name);
    } else if (rule instanceof RegExp) {
      const value = eq !== -1 ? t.slice(eq + 1) : args[(i += 1)];
      if (value === undefined || !rule.test(value)) return refuse(t);
      seen.add(name);
    } else if (rule?.optional) {
      let value = eq !== -1 ? t.slice(eq + 1) : null;
      if (value === null && args[i + 1] !== undefined && !args[i + 1].startsWith('-')) {
        value = args[(i += 1)];
      }
      if (value !== null && !rule.optional.test(value)) return refuse(t);
      seen.add(name);
    } else {
      // A cluster of no-value short flags, e.g. -tlnp.
      const chars = t.startsWith('--') ? [] : [...t.slice(1)];
      if (chars.length < 2 || !chars.every((c) => own(flags, `-${c}`) === true)) return refuse(t);
      chars.forEach((c) => seen.add(`-${c}`));
    }
  }

  const missing = (spec.require ?? []).find((f) => !seen.has(f));
  if (missing) return `"${label}" requires ${missing}`;
  const { re, path: isPath, oneOf, min = 0, max = 0 } = spec.args ?? {};
  if (positionals.length < min) return `"${label}" needs at least ${min} argument(s)`;
  if (positionals.length > max) return `"${label}" accepts at most ${max} argument(s)`;
  for (const p of positionals) {
    if (isPath && !readablePath(p)) {
      return `"${p}" is not readable here; only ${READABLE_DIR}/ and ${[...READABLE_FILES].join(', ')}`;
    }
    if ((re && !re.test(p)) || (oneOf && !oneOf.has(p))) {
      return `"${label}" does not accept "${p}"`;
    }
  }
  return null;
}

/** Classify the remote words (after any sudo). */
function classifyRemote(words) {
  const [cmd, sub] = words;
  const tables = [
    ['readonly', own(READONLY, cmd)],
    ['mutating', own(MUTATING, cmd)],
  ].filter(([, entry]) => entry);
  if (tables.length === 0) return { reject: `Remote command "${cmd}" is not available` };

  for (const [kind, entry] of tables) {
    if (!entry.subs) {
      const problem = argsProblem(entry, words.slice(1), cmd);
      return problem ? { reject: problem } : { kind, verb: cmd };
    }
    const spec = typeof sub === 'string' ? own(entry.subs, sub) : undefined;
    if (spec) {
      const verb = `${cmd} ${sub}`;
      const problem = argsProblem(spec, words.slice(2), verb);
      return problem ? { reject: problem } : { kind, verb };
    }
  }
  return { reject: sub ? `"${cmd} ${sub}" is not available` : `"${cmd}" needs a sub-command` };
}

/** Classify `ssh <host> [sudo] <command> [args]`. */
function classifyOperation(argv, context) {
  const hostNames = Array.isArray(context?.hostNames) ? context.hostNames : [];
  if (!Array.isArray(argv) || argv[0] !== 'ssh' || argv.some((t) => typeof t !== 'string')) {
    return { reject: 'Command could not be parsed' };
  }
  const [, host, ...remote] = argv;
  if ([argv[1], argv[2]].some((t) => t?.startsWith('-'))) {
    return { reject: 'SSH options are not allowed' };
  }
  if (!host || !HOST_NAME.test(host) || !hostNames.includes(host)) {
    return { reject: `Unknown host "${host ?? ''}"; use one of: ${hostNames.join(', ')}` };
  }
  if (remote.length === 0) return { reject: 'A remote command is required' };
  if (remote.some((t) => /[\n\r\0]/.test(t))) {
    return { reject: 'Remote arguments may not contain line breaks or NUL characters' };
  }
  const bad = remote.find((t) => !SAFE_WORD.test(t));
  if (bad !== undefined) {
    return { reject: `The argument "${bad}" contains characters that are not allowed` };
  }

  let words = remote;
  const sudo = words[0] === 'sudo';
  if (sudo) {
    words = words.slice(1);
    if (words.length === 0) return { reject: 'A command must follow sudo' };
    if (words[0].startsWith('-')) return { reject: 'sudo options are not allowed' };
  }
  const result = classifyRemote(words);
  if (result.reject) return result;
  return {
    kind: sudo ? 'mutating' : result.kind,
    verb: sudo ? `sudo ${result.verb}` : result.verb,
    dryRunCapable: false,
  };
}

// --- prompt ----------------------------------------------------------------------

function promptRules(credential) {
  const { hostNames } = policyContext(credential);
  return [
    `Run commands as "ssh <host> <command> [args]". The hosts are: ${hostNames.join(', ') || '(none configured)'}. Use these names exactly; never an address or user@host.`,
    'Do not pass ssh options; the connection is preconfigured.',
    'Help lookups are not available for SSH commands; use only the documented flags.',
    'Each command runs as plain words: no pipes, redirects, globs, quotes, variables, ";" or "&&". Run one command per step.',
    'Prefix sudo only when the command needs root. Any command with sudo needs Operator approval.',
    'Read logs with "journalctl -u <unit> -n <lines> --no-pager" or "--since"; never follow output (-f).',
    'Use "top -b -n 1"; interactive programs, editors, shells and interpreters are unavailable.',
    'Prefer JSON-capable flags: ip -j, lsblk -J, systemctl <verb> --output=json, docker <verb> --format json.',
    `Files are readable only under ${READABLE_DIR}/ and at ${[...READABLE_FILES].join(', ')}.`,
  ];
}

module.exports = {
  label: 'Linux servers (SSH)',
  binary: 'ssh',
  sandboxImage: SANDBOX_IMAGE_TAGS.SSH,
  credentialSchema,
  buildEnv,
  prepareSandbox,
  renderSshConfig,
  policyContext,
  toExecArgv,
  classifyOperation,
  supportsRegions: false,
  promptRules,
  dashboardOutputHint:
    'use JSON-capable flags: ip -j, lsblk -J, systemctl --output=json, docker … --format json',
};
