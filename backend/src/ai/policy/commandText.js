const { parse } = require('shell-quote');

/**
 * The command text for an argv: what is shown for approval, persisted, and
 * re-parsed by `classify()` at confirm time. It must round-trip, i.e.
 * `parse(commandTextFromArgv(argv))` deep-equals `argv`, or what runs after
 * confirmation could differ from what was approved.
 *
 * A word that already parses back to itself is left bare, so ordinary commands
 * read as typed. Any other word (spaces, quotes, `$`, globs, backslashes...) is
 * single-quoted, with each embedded `'` written as `'"'"'`. shell-quote's own
 * `quote()` is not used: it backslash-escapes `*`, which `parse()` then reads
 * back as a glob.
 *
 * @param {string[]} argv
 * @returns {string}
 */
function commandTextFromArgv(argv) {
  return argv
    .map((word) => {
      let bare = false;
      try {
        const tokens = parse(word);
        bare = tokens.length === 1 && tokens[0] === word;
      } catch {
        // parse() throws on an unclosed `${`; such a word is simply quoted.
      }
      if (bare) return word;
      return `'${word.replace(/'/g, `'"'"'`)}'`;
    })
    .join(' ');
}

module.exports = { commandTextFromArgv };
