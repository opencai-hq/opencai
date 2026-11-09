// Remote commands an SSH Workspace may run: `ssh <host> [sudo] <cmd> [<sub>] [args]`.
//
// Every entry is an ALLOWLIST. `flags` names each accepted option exactly:
//   true      no-value flag, may be clustered with other `true` flags (-tlnp)
//   'solo'    no-value flag that must stand alone (optional-argument flags)
//   RegExp    takes a value, as `--x=v`, `--x v` or `-x v`, and the value must match
//   { optional: RegExp }  the next word is its value unless it starts with "-"
// `args` describes the positionals: { re | path | oneOf, min, max }; none by
// default. `require` lists flags that must be present. `check` replaces all of
// this with a custom validator returning a reason or null. Anything not listed
// (any other option, an abbreviation, `--x=v` on a no-value flag) is refused.

const UNIT = /^[A-Za-z0-9][A-Za-z0-9@_.:-]{0,254}$/;
const COUNT = /^\d{1,6}$/;
const TIME = /^[A-Za-z0-9][A-Za-z0-9: .+-]{0,39}$|^-\d{1,4}[smhdw]?$/; // journalctl/docker --since
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PID = /^[1-9]\d{0,9}$/;
const PACKAGE = /^[a-z0-9][a-z0-9+._:-]{0,127}(=[A-Za-z0-9.+:-]{1,64})?$/;
const JSON_ONLY = /^json$/;

// Files that can be read, after path.posix.normalize. Anything under /var/log.
const READABLE_DIR = '/var/log';
const READABLE_FILES = new Set([
  '/etc/os-release',
  '/proc/loadavg',
  '/proc/meminfo',
  '/proc/cpuinfo',
  '/proc/uptime',
]);
const PATHS = (min, max = 20) => ({ path: true, min, max });

const OUTPUT_MODE =
  /^(short|short-iso|short-precise|short-unix|verbose|json|json-pretty|cat|with-unit)$/;
const PRIORITY =
  /^([0-7]|emerg|alert|crit|err|warning|notice|info|debug)(\.\.([0-7]|[a-z]{3,7}))?$/;

// `bools('-a -b')` -> { '-a': true, '-b': true }
const bools = (list, rule = true) => Object.fromEntries(list.split(' ').map((f) => [f, rule]));

const SYSTEMCTL_READ = {
  flags: {
    ...bools('--no-pager --all -a --full -l --plain --no-legend --failed --quiet -q'),
    '--type': /^[a-z,]{1,64}$/,
    '-t': /^[a-z,]{1,64}$/,
    '--state': /^[a-z,-]{1,64}$/,
    '--output': OUTPUT_MODE,
    '-o': OUTPUT_MODE,
    '--lines': COUNT,
    '-n': COUNT,
  },
  args: { re: UNIT, max: 20 },
};
const SYSTEMCTL_WRITE = {
  flags: bools('--no-block --no-pager --quiet -q'),
  args: { re: UNIT, min: 1, max: 20 },
};
const SYSTEMCTL_ENABLE = { ...SYSTEMCTL_WRITE, flags: { ...SYSTEMCTL_WRITE.flags, '--now': true } };

const DOCKER_FORMAT = { '--format': JSON_ONLY };
const DOCKER_TIMEOUT = { '-t': COUNT, '--time': COUNT, '--timeout': COUNT };
const containers = (flags = {}) => ({ flags, args: { re: CONTAINER, min: 1, max: 10 } });

const pkgs = (min, flags) => ({ flags, args: { re: PACKAGE, min, max: 50 } });
const APT_FLAGS = bools('-y --yes --assume-yes -q --quiet');
const APT = {
  subs: {
    install: pkgs(1, { ...APT_FLAGS, '--no-install-recommends': true }),
    remove: pkgs(1, APT_FLAGS),
    purge: pkgs(1, APT_FLAGS),
    update: pkgs(0, APT_FLAGS),
    upgrade: pkgs(0, APT_FLAGS),
    autoremove: pkgs(0, APT_FLAGS),
  },
};
const DNF_FLAGS = bools('-y --assumeyes -q --quiet');
const DNF = {
  subs: {
    install: pkgs(1, DNF_FLAGS),
    remove: pkgs(1, DNF_FLAGS),
    update: pkgs(0, DNF_FLAGS),
    upgrade: pkgs(0, DNF_FLAGS),
  },
};

const SIGNAL = /^(TERM|KILL|HUP|INT|QUIT|USR1|USR2)$/;
const LEVELS = /^[a-z]{3,7}(,[a-z]{3,7}){0,7}$/;
const IDENT = /^[A-Za-z0-9_.@-]{1,64}$/;

/** `ip [opts] (addr|route|link) [show|list] [dev <ifname>]` and nothing else. */
const IP_OPTIONS = new Set(['-j', '-br', '-4', '-6', '-s', '-d']);
const IP_OBJECTS = new Set(['addr', 'address', 'a', 'route', 'r', 'link', 'l']);
const IFNAME = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,14}$/;
function checkIp(args) {
  let i = 0;
  while (IP_OPTIONS.has(args[i])) i += 1;
  if (!IP_OBJECTS.has(args[i])) return 'Only "ip [-j|-br|-4|-6|-s|-d] addr|route|link" is allowed';
  i += 1;
  if (args[i] === 'show' || args[i] === 'list') i += 1;
  if (args[i] === 'dev') {
    if (!IFNAME.test(args[i + 1] ?? '')) return 'Invalid interface name after "dev"';
    i += 2;
  }
  return i === args.length ? null : `"ip" does not accept "${args[i]}" here`;
}

const READONLY = {
  uptime: { flags: bools('-p -s') },
  free: { flags: bools('-b -k -m -g -h -t -w') },
  df: {
    flags: bools('-h -H -T -i -k -l -P -a'),
    // Absolute, with no "." or ".." segments.
    args: { re: /^\/$|^(\/[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]{0,254}){1,32}$/, max: 10 },
  },
  uname: { flags: bools('-a -s -n -r -v -m -o') },
  hostname: { flags: bools('-f -s -I -i -d', 'solo') },
  whoami: {},
  id: {},
  lscpu: { flags: bools('-J') },
  vmstat: { flags: { ...bools('-s -w'), '-S': /^[KM]$/ } },
  nproc: { flags: bools('--all') },
  who: { flags: bools('-b -r -q -H -u') },
  w: { flags: bools('-h -s') },
  last: { flags: { ...bools('-w -x -a -i'), '-n': COUNT } },
  top: {
    flags: { ...bools('-b -c', 'solo'), '-n': /^1$/, '-o': /^%?[A-Za-z]{1,12}$/ },
    require: ['-b', '-n'],
  },
  ps: {
    flags: {
      ...bools('-e -f -A -F -H -l -w --no-headers --forest'),
      '-o': /^[A-Za-z%][A-Za-z0-9_%,:=]{0,199}$/,
      '-p': /^\d{1,10}(,\d{1,10}){0,49}$/,
      '-u': /^[a-z_][a-z0-9_.-]{0,31}$/,
      '--sort': /^[+-]?[A-Za-z%_]{1,20}(,[+-]?[A-Za-z%_]{1,20}){0,9}$/,
    },
    // BSD forms without `e`, which would print every process's environment.
    args: { oneOf: new Set(['aux', 'auxww', 'auxf', 'ax', 'axf', 'axu']), max: 1 },
  },
  ip: { check: checkIp },
  ss: { flags: bools('-t -u -l -n -p -a -s -4 -6 -H -x -w -o -i -m -e') },
  dmesg: { flags: { ...bools('-T -x -k -t'), '-l': LEVELS, '--level': LEVELS } },
  lsblk: {
    flags: {
      ...bools('-J -b -d -p -f'),
      '-o': /^\+?[A-Za-z0-9_:-]{1,32}(,[A-Za-z0-9_:-]{1,32}){0,30}$/,
    },
    args: { re: /^\/dev\/[A-Za-z0-9_-]{1,64}$/, max: 10 },
  },
  lsof: {
    flags: {
      ...bools('-n -P'),
      '-i': {
        optional: /^[46]?(tcp|udp|TCP|UDP)?(@[A-Za-z0-9.:-]{1,64})?(:[A-Za-z0-9,-]{1,64})?$/,
      },
    },
    require: ['-i'],
  },
  journalctl: {
    flags: {
      ...bools('--no-pager --boot -k --dmesg -r --reverse --utc -q --quiet -x --catalog'),
      ...bools('--no-hostname --list-boots --disk-usage'),
      '-b': 'solo', // takes an optional argument: never clustered
      '-u': UNIT,
      '--unit': UNIT,
      '-n': COUNT,
      '--lines': COUNT,
      '-S': TIME,
      '--since': TIME,
      '-U': TIME,
      '--until': TIME,
      '-p': PRIORITY,
      '--priority': PRIORITY,
      '-o': OUTPUT_MODE,
      '--output': OUTPUT_MODE,
      '-t': IDENT,
      '--identifier': IDENT,
    },
  },
  systemctl: {
    subs: Object.fromEntries(
      'status is-active is-enabled is-failed list-units list-unit-files list-timers list-sockets'
        .split(' ')
        .map((sub) => [sub, SYSTEMCTL_READ]),
    ),
  },
  docker: {
    subs: {
      ps: {
        flags: {
          ...DOCKER_FORMAT,
          ...bools('-a --all -q --quiet -s --size --no-trunc'),
          '-n': COUNT,
          '--last': COUNT,
        },
      },
      images: { flags: { ...DOCKER_FORMAT, ...bools('-a --all -q --no-trunc') } },
      logs: {
        flags: {
          ...bools('-t --timestamps'),
          '-n': /^(\d{1,6}|all)$/,
          '--tail': /^(\d{1,6}|all)$/,
          '--since': TIME,
          '--until': TIME,
        },
        args: { re: CONTAINER, min: 1, max: 1 },
      },
      stats: {
        flags: { ...DOCKER_FORMAT, ...bools('--no-stream -a --all --no-trunc') },
        require: ['--no-stream'],
        args: { re: CONTAINER, max: 10 },
      },
      info: { flags: DOCKER_FORMAT },
      version: { flags: DOCKER_FORMAT },
    },
  },
  // Path-restricted: every positional must be a readable path (see READABLE_*).
  cat: { flags: bools('-n'), args: PATHS(1) },
  head: { flags: { ...bools('-q'), '-n': COUNT, '-c': COUNT }, args: PATHS(1) },
  tail: {
    flags: { ...bools('-q'), '-n': /^\+?\d{1,7}$/, '--lines': /^\+?\d{1,7}$/, '-c': COUNT },
    args: PATHS(1),
  },
  ls: { flags: bools('-l -a -A -h -t -r -S -1 -d -i'), args: PATHS(1) },
  stat: { flags: bools('-L -t'), args: PATHS(1) },
  du: {
    flags: { ...bools('-s -h -c -a -k -m -x'), '-d': /^\d{1,2}$/, '--max-depth': /^\d{1,2}$/ },
    args: PATHS(1),
  },
};

const MUTATING = {
  systemctl: {
    subs: {
      ...Object.fromEntries(
        'start stop restart reload try-restart reload-or-restart reset-failed'
          .split(' ')
          .map((sub) => [sub, SYSTEMCTL_WRITE]),
      ),
      enable: SYSTEMCTL_ENABLE,
      disable: SYSTEMCTL_ENABLE,
      'daemon-reload': {},
    },
  },
  docker: {
    subs: {
      start: containers(),
      stop: containers(DOCKER_TIMEOUT),
      restart: containers(DOCKER_TIMEOUT),
      kill: containers({ '-s': SIGNAL, '--signal': SIGNAL }),
      pause: containers(),
      unpause: containers(),
      rm: containers(bools('-f --force')),
    },
  },
  'apt-get': APT,
  apt: APT,
  dnf: DNF,
  yum: DNF,
  kill: {
    flags: { ...bools('-9 -15 -2 -TERM -KILL -HUP -INT -QUIT -USR1 -USR2', 'solo'), '-s': SIGNAL },
    args: { re: PID, min: 1, max: 20 },
  },
  reboot: {},
  poweroff: {},
  shutdown: {
    flags: bools('-r -h -P -c', 'solo'),
    args: { re: /^(now|\+\d{1,4}|\d{1,2}:\d{2})$/, max: 1 },
  },
};

module.exports = { READONLY, MUTATING, READABLE_DIR, READABLE_FILES };
