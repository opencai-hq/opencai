// Best-effort secret scrubbing for command output before it is stored or shown.
//
// This is NOT a guarantee. It redacts a handful of well-known, high-signal
// secret shapes (AWS access key IDs, Google access tokens, JWTs, Azure storage
// connection strings and SAS signatures, PEM private key blocks, JSON and
// ini/env-style secret fields). Secrets in shapes it does not know about will
// pass through unchanged. Treat it as defence in depth, never as a reason to
// let untrusted output reach somewhere it should not.

const REDACTED = '[REDACTED]';

/**
 * Redact recognisable secrets from a block of command stdout/stderr.
 *
 * Every regex is constructed fresh on each call: a module-level /g regex
 * carries a mutable `lastIndex`, and leaking that state between calls would
 * silently skip secrets on subsequent invocations.
 *
 * Non-string input is coerced rather than passed through. This matters:
 * child_process stdout/stderr are Buffers unless the caller sets an encoding,
 * and handing a Buffer straight back would return every secret in it intact
 * while looking, at the call site, exactly like a successful sanitize.
 * String(buffer) decodes UTF-8, so the redaction rules below genuinely apply.
 * Always returning a string also matches this function's declared contract.
 *
 * @param {string|Buffer|*} text
 * @returns {string}
 */
function sanitizeOutput(text) {
  // Coerce, never pass through: failing open here would leak whole secrets.
  let result = typeof text === 'string' ? text : String(text);

  // 0. Terminal escape sequences (e.g. the bold headings in `aws ... help`).
  //    Stripped first so they cannot split a secret and hide it from the
  //    rules below.
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

  // 1. AWS access key IDs (long-lived AKIA..., temporary ASIA...).
  result = result.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED);

  // 1b. Google OAuth access tokens, and JWTs (Azure AD and Google ID tokens).
  result = result.replace(/\bya29\.[A-Za-z0-9_-]+/g, REDACTED);
  result = result.replace(
    /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g,
    REDACTED,
  );

  // 1c. Azure storage connection strings and SAS URL signatures.
  result = result.replace(
    /\b(AccountKey|SharedAccessKey|SharedAccessSignature)=[^;"'\s]+/gi,
    `$1=${REDACTED}`,
  );
  result = result.replace(/([?&]sig=)[^&"'\s]+/g, `$1${REDACTED}`);

  // 2. PEM private key blocks. Run before the narrower rules below so a key's
  //    base64 body can never be partially matched by them.
  result = result.replace(
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    '[REDACTED PRIVATE KEY]',
  );

  // 3. JSON-shaped secret fields, e.g. "SecretAccessKey", "SessionToken",
  //    "Password", "secretString", "client_secret", "private_key",
  //    "connectionString", "primaryKey".
  result = result.replace(
    /"([a-zA-Z_]*(?:secret|password|token|private_?key|connection_?string|(?:primary|secondary|account)_?key)[a-zA-Z_]*)"\s*:\s*"(?:[^"\\]|\\.)*"/gi,
    `"$1": "${REDACTED}"`,
  );

  // 4. ini/env-shaped secret fields, e.g. AWS credentials files and KEY=value
  //    environment dumps.
  result = result.replace(
    /^(\s*(?:aws_secret_access_key|aws_session_token|client_secret|password|secret|private_key)\s*=\s*).+$/gim,
    `$1${REDACTED}`,
  );

  return result;
}

/** Sanitize both streams independently and join them into one output blob. */
function combineOutput(execution) {
  const out = sanitizeOutput(execution?.stdout ?? '');
  const err = execution?.stderr ? sanitizeOutput(execution.stderr) : '';
  return err ? `${out}\n${err}` : out;
}

module.exports = { sanitizeOutput, combineOutput };
