// Helpers shared by the az and gcloud grammars, whose commands are both a
// path of words followed by options.

/** The words between the binary and the first option. */
function commandPath(argv) {
  const path = [];
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i].startsWith('-')) break;
    path.push(argv[i]);
  }
  return path;
}

/** The blocked path that `path` starts with, or null. */
function blockedPrefix(path, blockedPaths) {
  return (
    blockedPaths.find(
      (blocked) => blocked.length <= path.length && blocked.every((word, i) => path[i] === word),
    ) ?? null
  );
}

function matchesVerb(word, exact, prefixes) {
  return exact.includes(word) || prefixes.some((prefix) => word.startsWith(prefix));
}

module.exports = { commandPath, blockedPrefix, matchesVerb };
