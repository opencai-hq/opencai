// gcloud commands are `gcloud [alpha|beta] <group>... <verb> [names] [--flags]`.

const READONLY_EXACT_VERBS = ['list', 'describe', 'read', 'search', 'ls', 'cat', 'du'];
const READONLY_PREFIXES = ['list-', 'describe-', 'get-', 'search-'];

// Curated, non-exhaustive. A command with no recognised verb is rejected,
// never assumed safe.
const MUTATING_EXACT_VERBS = [
  'create',
  'delete',
  'update',
  'patch',
  'set',
  'add',
  'remove',
  'start',
  'stop',
  'restart',
  'reset',
  'resize',
  'deploy',
  'submit',
  'run',
  'execute',
  'enable',
  'disable',
  'move',
  'rename',
  'import',
  'export',
  'apply',
  'replace',
  'rollback',
  'cancel',
  'undelete',
  'restore',
  'resume',
  'suspend',
  'attach',
  'detach',
  'promote',
  'failover',
  'clone',
  'migrate',
  'upgrade',
  'link',
  'unlink',
  'publish',
  'drain',
  'undrain',
  'abandon',
  'recreate',
  'deprecate',
  'cp',
  'mv',
  'rm',
  'rsync',
];

const MUTATING_PREFIXES = [
  'create-',
  'delete-',
  'update-',
  'set-',
  'add-',
  'remove-',
  'attach-',
  'detach-',
  'start-',
  'stop-',
  'reset-',
  'resize-',
  'enable-',
  'disable-',
  'move-',
];

// Command paths refused outright, whatever their verb: they change or reveal
// the sandbox's own sign-in rather than acting on cloud resources.
const BLOCKED_PATHS = [
  ['auth'],
  ['config'],
  ['init'],
  ['components'],
  ['cloud-shell'],
  ['container', 'clusters', 'get-credentials'],
];

module.exports = {
  READONLY_EXACT_VERBS,
  READONLY_PREFIXES,
  MUTATING_EXACT_VERBS,
  MUTATING_PREFIXES,
  BLOCKED_PATHS,
};
