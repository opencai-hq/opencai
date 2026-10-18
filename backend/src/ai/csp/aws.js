const { z } = require('zod');

const { SANDBOX_IMAGE_TAGS } = require('../constants');
const {
  READONLY_PREFIXES,
  MUTATING_PREFIXES,
  MUTATING_EXACT_OPERATIONS,
  DRY_RUN_SUPPORTED_EC2_OPERATIONS,
} = require('../policy/patterns/aws');

const credentialSchema = z.object({
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
});

function startsWithAny(operation, prefixes) {
  return prefixes.some((prefix) => operation.startsWith(prefix));
}

/**
 * Map a decrypted AWS credential payload onto the environment variables the
 * AWS CLI expects. Injected per-exec, never baked into the container.
 */
async function buildEnv(credential) {
  if (!credential || typeof credential !== 'object') {
    throw new Error('Missing credential payload for CSP: AWS');
  }
  const { accessKeyId, secretAccessKey } = credential;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Incomplete AWS credential payload');
  }
  return {
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
  };
}

/** Classify `aws <service> <operation> [args...]`. */
function classifyOperation(argv) {
  // --help is always a lookup: the AWS CLI prints locally bundled usage text
  // without touching the network or mutating anything, whatever verb it is
  // attached to and whether or not that verb is recognised.
  if (argv.includes('--help')) {
    return { kind: 'lookup', verb: argv[1] ?? null, dryRunCapable: false };
  }

  // `help` is how AWS CLI v2 prints documentation (it rejects `--help`). It is
  // a help request only as the final token directly after the binary, service
  // or operation -- `aws help`, `aws ec2 help`, `aws ec2 describe-instances
  // help` -- so only those exact shapes count. Anywhere else "help" is an
  // ordinary argument and gets classified below.
  if (argv.length >= 2 && argv.length <= 4 && argv[argv.length - 1] === 'help') {
    return { kind: 'lookup', verb: argv[1], dryRunCapable: false };
  }

  if (argv.length < 3) {
    return { reject: 'Command is missing a service or operation' };
  }

  // Mutating patterns are checked first so that an operation matching both
  // lists is treated as the more dangerous one.
  const operation = argv[2];

  const isMutating =
    MUTATING_EXACT_OPERATIONS.includes(operation) || startsWithAny(operation, MUTATING_PREFIXES);

  if (isMutating) {
    const dryRunCapable = argv[1] === 'ec2' && DRY_RUN_SUPPORTED_EC2_OPERATIONS.includes(operation);
    return { kind: 'mutating', verb: operation, dryRunCapable };
  }

  if (startsWithAny(operation, READONLY_PREFIXES)) {
    return { kind: 'readonly', verb: operation, dryRunCapable: false };
  }

  return {
    reject: `Unrecognized operation "${operation}" -- neither a known read-only nor mutating pattern`,
  };
}

const promptRules = [
  'To check syntax, use run_lookup with "aws <service> <operation> help" (this AWS CLI does not accept --help).',
  'To run the same read-only command in several AWS regions, call the tool once with the "regions" argument (a list of region names, or ["all"] for every enabled region) instead of making one call per region. Leave --region out of that command.',
  'Global services — Cost Explorer (ce), IAM, Organizations, Route 53, and listing S3 buckets — return the same data in every region. Run them once, without "regions" (use --region us-east-1 for Cost Explorer).',
  'If no AWS region is configured and you cannot tell which one the Operator means, ask them.',
];

module.exports = {
  label: 'AWS',
  binary: 'aws',
  sandboxImage: SANDBOX_IMAGE_TAGS.AWS,
  credentialSchema,
  buildEnv,
  classifyOperation,
  supportsRegions: true,
  promptRules,
};
