// Deterministic, pure, synchronous command policy classifier.
//
// This decides whether a command an LLM proposed may run immediately, may run
// only after an explicit human confirmation, or must never run at all. It does
// no I/O and has no state -- given the same inputs it always returns the same
// verdict. Every unknown is denied: there is no code path here that allows a
// command the rules do not positively recognise as safe.
const { parse } = require('shell-quote');

const { POLICY_VERDICTS } = require('./policyVerdicts');
const { getCsp } = require('../csp');

const VERDICT_FOR_KIND = Object.freeze({
  lookup: POLICY_VERDICTS.ALLOW_LOOKUP,
  readonly: POLICY_VERDICTS.ALLOW_READONLY,
  mutating: POLICY_VERDICTS.REQUIRE_CONFIRMATION,
});

function reject(reason, argv = [], binary = null) {
  return {
    verdict: POLICY_VERDICTS.REJECTED,
    reason,
    dryRunCapable: false,
    argv,
    binary,
    verb: null,
  };
}

/**
 * Classify a proposed shell command.
 *
 * `mode` / `subMode` are accepted for logging and future extensibility; they do
 * not influence classification today. The only persona-derived input that
 * matters here is `personaAllowedBinaries`, already resolved by the caller.
 * `csp` is the Workspace's cloud provider (a `CSP` value): it fixes the one
 * binary that may run and the grammar its commands are read with.
 *
 * @returns {{ verdict: string, reason: string|null, dryRunCapable: boolean,
 *             argv: string[], binary: string|null, verb: string|null }}
 */
function classify({ mode, subMode, csp, commandString, personaAllowedBinaries }) {
  void mode;
  void subMode;

  let provider;
  try {
    provider = getCsp(csp);
  } catch {
    return reject('Unsupported cloud provider');
  }

  // 1. Tokenize. Anything shell-quote cannot make sense of is rejected.
  if (typeof commandString !== 'string') {
    return reject('Command could not be parsed');
  }

  let tokens;
  try {
    tokens = parse(commandString);
  } catch {
    return reject('Command could not be parsed');
  }

  if (!Array.isArray(tokens)) {
    return reject('Command could not be parsed');
  }

  // 2. Reject shell metacharacters. shell-quote returns operator tokens
  //    (&&, ||, |, ;, >, <, globs, comments) as objects; ordinary arguments
  //    come back as plain strings. Any non-string token means the model tried
  //    to use shell syntax, which is never allowed.
  if (tokens.some((token) => typeof token !== 'string')) {
    return reject('Shell operators or metacharacters are not allowed');
  }

  const argv = tokens;

  // 3. Defense in depth. Every token is a plain string by now, but backticks
  //    and $( have no legitimate use in a cloud CLI argument. Rejecting them
  //    keeps this classifier safe even if some future caller ever hands the
  //    result to a real shell (today's sandbox execs argv directly).
  if (argv.some((token) => token.includes('`') || token.includes('$('))) {
    return reject('Command contains disallowed characters');
  }

  // 4. Empty command.
  if (argv.length === 0) {
    return reject('Empty command');
  }

  // 5. Binary allowlist. The binary must be the Workspace's own provider CLI
  //    and one this persona is allowed to run.
  const binary = argv[0];
  const allowedBinaries = Array.isArray(personaAllowedBinaries) ? personaAllowedBinaries : [];
  if (binary !== provider.binary || !allowedBinaries.includes(binary)) {
    return reject(`Binary "${binary}" is not allowed in this mode`, argv, binary);
  }

  // 6. Classify the operation with the provider's grammar. Default-deny:
  //    anything it does not positively recognise as help, read-only or
  //    mutating comes back as a rejection -- never assumed safe. This is the
  //    single most important rule in this file.
  const operation = provider.classifyOperation(argv);
  if (operation.reject) {
    return reject(operation.reject, argv, binary);
  }

  return {
    verdict: VERDICT_FOR_KIND[operation.kind] ?? POLICY_VERDICTS.REJECTED,
    reason: null,
    dryRunCapable: operation.dryRunCapable,
    argv,
    binary,
    verb: operation.verb,
  };
}

module.exports = { classify };
