const { z } = require('zod');

const { SANDBOX_IMAGE_TAGS } = require('../constants');
const { commandPath, blockedPrefix, matchesVerb } = require('./grammar');
const {
  READONLY_EXACT_VERBS,
  READONLY_PREFIXES,
  MUTATING_EXACT_VERBS,
  MUTATING_PREFIXES,
  BLOCKED_PATHS,
} = require('../policy/patterns/gcp');

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

const serviceAccountKeySchema = z.object({
  type: z.literal('service_account'),
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
});

// The admin pastes the service-account key file's JSON. Only the fields needed
// to mint tokens are kept, so the stored blob holds nothing else from the file.
const credentialSchema = z
  .object({
    serviceAccountKey: z.string().min(1),
    projectId: z.string().regex(PROJECT_ID, 'Invalid project ID').optional(),
  })
  .transform((value, ctx) => {
    let parsed;
    try {
      parsed = JSON.parse(value.serviceAccountKey);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'The service account key is not valid JSON' });
      return z.NEVER;
    }
    const key = serviceAccountKeySchema.safeParse(parsed);
    if (!key.success) {
      ctx.addIssue({
        code: 'custom',
        message:
          'The service account key must be a key file of type "service_account" with project_id, client_email and private_key',
      });
      return z.NEVER;
    }
    return {
      clientEmail: key.data.client_email,
      privateKey: key.data.private_key,
      projectId: value.projectId ?? key.data.project_id,
    };
  });

async function mintAccessToken({ clientEmail, privateKey }) {
  // Required here so the policy and prompt code paths never load the library.
  const { JWT } = require('google-auth-library');
  const client = new JWT({ email: clientEmail, key: privateKey, scopes: [CLOUD_PLATFORM_SCOPE] });
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Google returned no access token');
  return token;
}

/**
 * Exchange the stored key for a short-lived access token and hand gcloud only
 * that. The key itself never enters the sandbox.
 */
async function buildEnv(credential, { mintToken = mintAccessToken } = {}) {
  const { clientEmail, privateKey, projectId } = credential ?? {};
  if (!clientEmail || !privateKey || !projectId) {
    throw new Error('Incomplete GCP credential payload');
  }
  return {
    CLOUDSDK_AUTH_ACCESS_TOKEN: await mintToken({ clientEmail, privateKey }),
    CLOUDSDK_CORE_PROJECT: projectId,
    // A confirmed command must not then stall on gcloud's own y/N prompt.
    CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
  };
}

/**
 * Classify `gcloud [alpha|beta] <group>... <verb> [names] [--flags]`.
 *
 * gcloud puts resource names after the verb, so the verb cannot be found by
 * position. The first recognised verb after the top-level group decides.
 *
 * Known limitation: a mutating verb missing from MUTATING_* that acts on a
 * resource named exactly like a read-only verb ("list", "get-x", ...) would be
 * classified read-only. Keep the mutating list broad.
 */
function classifyOperation(argv) {
  // After a bare `--` gcloud passes the rest to another program (ssh, kubectl).
  if (argv.includes('--')) {
    return { reject: 'A bare "--" is not allowed' };
  }

  let path = commandPath(argv);

  // Help is printed from the CLI's bundled text, whatever it is attached to.
  if (argv.includes('--help') || argv.includes('-h') || path[0] === 'help') {
    return { kind: 'lookup', verb: path[path.length - 1] ?? null, dryRunCapable: false };
  }

  if (path.length === 0) {
    return { reject: 'Write the command first and its flags after it' };
  }

  if (path[0] === 'alpha' || path[0] === 'beta') path = path.slice(1);

  const blocked = blockedPrefix(path, BLOCKED_PATHS);
  if (blocked) {
    return { reject: `"gcloud ${blocked.join(' ')}" is not available in this environment` };
  }

  if (path.length < 2) {
    return { reject: 'Command is missing a command group or operation' };
  }

  // path[0] is always a group (and some groups, like `run`, share a name with a
  // verb). Within one word, mutating is checked before read-only.
  for (const word of path.slice(1)) {
    if (matchesVerb(word, MUTATING_EXACT_VERBS, MUTATING_PREFIXES)) {
      return { kind: 'mutating', verb: word, dryRunCapable: false };
    }
    if (matchesVerb(word, READONLY_EXACT_VERBS, READONLY_PREFIXES)) {
      return { kind: 'readonly', verb: word, dryRunCapable: false };
    }
  }

  return {
    reject: `Unrecognized operation "${path.join(' ')}" -- neither a known read-only nor mutating pattern`,
  };
}

const promptRules = [
  'To check syntax, use run_lookup with "gcloud <group> <command> --help".',
  'The sandbox is already signed in and the project is already selected. Do not run gcloud auth, gcloud config or gcloud init; they are rejected. To look at another project this service account can see, add --project to the command.',
  'Write the command first and its flags after it, for example "gcloud compute instances list --format=json". A bare "--" is not accepted.',
  'The "regions" tool argument is not available on Google Cloud. List commands already cover every region and zone in the project; narrow them with --filter, --regions or --zones.',
  'Only gcloud is installed. Use "gcloud storage" where you would use gsutil. bq is not available, so billing data exported to BigQuery cannot be queried from here; say so if the Operator asks for it.',
];

module.exports = {
  label: 'Google Cloud',
  binary: 'gcloud',
  sandboxImage: SANDBOX_IMAGE_TAGS.GCP,
  credentialSchema,
  buildEnv,
  classifyOperation,
  supportsRegions: false,
  promptRules,
};
