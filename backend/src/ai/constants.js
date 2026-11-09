// Limits on model turns and wall-clock orchestration time
const MAX_MODEL_TURNS_PER_MESSAGE = 8;
const MAX_ORCHESTRATION_WALL_CLOCK_MS = 120000;

// Sandbox runtime configuration
// One image per cloud provider, each holding only that provider's CLI. These are
// deliberately LOCAL tags, built from backend/sandbox/<provider>/Dockerfile (see
// that directory's README). They must not be upstream-resolvable references: if
// an image hasn't been built, createContainer must fail loudly with "no such
// image" rather than silently pulling an unhardened upstream image and running
// the sandbox as root. Each tag carries the version of the CLI inside it.
const SANDBOX_IMAGE_TAGS = Object.freeze({
  AWS: 'opencai-sandbox-aws:2.15.30',
  AZURE: 'opencai-sandbox-azure:2.91.0',
  GCP: 'opencai-sandbox-gcp:588.0.0',
  VSPHERE: 'opencai-sandbox-vsphere:0.46.3',
  SSH: 'opencai-sandbox-ssh:9.7p1',
  KUBERNETES: 'opencai-sandbox-kubernetes:1.31.4',
});
const SANDBOX_DEFAULT_MEMORY_BYTES = 536870912; // 512 MB
const SANDBOX_DEFAULT_NANO_CPUS = 1000000000; // 1 vCPU
const SANDBOX_DEFAULT_PIDS_LIMIT = 64;

module.exports = {
  MAX_MODEL_TURNS_PER_MESSAGE,
  MAX_ORCHESTRATION_WALL_CLOCK_MS,
  SANDBOX_IMAGE_TAGS,
  SANDBOX_DEFAULT_MEMORY_BYTES,
  SANDBOX_DEFAULT_NANO_CPUS,
  SANDBOX_DEFAULT_PIDS_LIMIT,
};
