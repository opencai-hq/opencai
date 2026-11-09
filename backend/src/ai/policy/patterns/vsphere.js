// govc commands are `govc <command> [options] [args]`, where <command> is a
// dotted name such as `vm.info`. Classification keys on that one word.

// Checked first: these win over any read-only or mutating match.
const REJECTED_EXACT = ['env'];
const REJECTED_PREFIXES = [
  'guest.', // runs code inside VMs
  'datastore.upload', // file transfer from the sandbox
  'datastore.download', // file transfer to the sandbox
  'session.',
  'vm.console',
  'import.',
  'export.',
];

// Global client flags that redirect, weaken or log the authenticated session.
const BLOCKED_FLAGS = [
  'u',
  'k',
  'cert',
  'key',
  'cacert',
  'tls-ca-certs',
  'tls-known-hosts',
  'trace',
  'verbose',
  'debug',
  'persist-session',
];
const BLOCKED_FLAG_PREFIXES = ['vim-'];

const READONLY_EXACT = [
  'about',
  'ls',
  'find',
  'tree',
  'events',
  'tasks',
  'metric.ls',
  'metric.sample',
  'object.collect',
  'datastore.ls',
  'datastore.info',
  'host.info',
  'cluster.usage',
  'vm.ip',
  'snapshot.tree',
];
const READONLY_SUFFIXES = ['.info', '.ls', '.tree'];

// Curated, non-exhaustive. A command in no list is rejected, never assumed safe.
const MUTATING_EXACT = [
  'vm.power',
  'vm.create',
  'vm.clone',
  'vm.destroy',
  'vm.change',
  'vm.migrate',
  'tags.attach',
  'tags.detach',
  'tags.create',
  'tags.rm',
];
const MUTATING_PREFIXES = ['snapshot.', 'host.maintenance.'];
const MUTATING_SUFFIXES = ['.rm', '.create', '.add'];

module.exports = {
  REJECTED_EXACT,
  REJECTED_PREFIXES,
  BLOCKED_FLAGS,
  BLOCKED_FLAG_PREFIXES,
  READONLY_EXACT,
  READONLY_SUFFIXES,
  MUTATING_EXACT,
  MUTATING_PREFIXES,
  MUTATING_SUFFIXES,
};
