const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const otplib = require('otplib');
const QRCode = require('qrcode');

const config = require('../../config/env');
const prisma = require('../../config/db');
const envelope = require('../../crypto/envelope');
const { AppError } = require('../../middleware/errorHandler');
const { ERROR_CODES } = require('../../constants/errors');
const { AUDIT_ACTIONS, AUDIT_OUTCOMES } = require('../../constants/auditActions');
const { BCRYPT_COST, setUserPassword } = require('./passwords');

const SESSION_TOKEN_EXPIRY = '12h';
const MFA_TOKEN_EXPIRY = '10m';
const ENROLLMENT_TOKEN_EXPIRY = '10m';
const BACKUP_CODE_COUNT = 10;

function signToken(payload, expiresIn) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn });
}

// `sv` ties the session to the user's current sessionVersion: middleware/auth
// rejects it once a password change or reset has moved the version on.
function issueSessionToken(user) {
  return signToken(
    { sub: user.id, username: user.username, role: user.role, sv: user.sessionVersion },
    SESSION_TOKEN_EXPIRY,
  );
}

// An mfa-pending token from before a password reset must not finish signing in.
function assertSessionVersion(payload, user) {
  if ((payload.sv ?? 0) !== user.sessionVersion) {
    throw new AppError(401, ERROR_CODES.MFA_TOKEN_INVALID);
  }
}

function verifyToken(token, expectedPurpose, errorCode) {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (expectedPurpose && payload.purpose !== expectedPurpose) {
      throw new Error('purpose mismatch');
    }
    return payload;
  } catch {
    throw new AppError(401, errorCode || ERROR_CODES.MFA_TOKEN_INVALID);
  }
}

// epochTolerance is in seconds (not steps, despite the name pattern elsewhere
// in otplib) -- 30 allows the previous or next 30-second step, absorbing
// clock drift and the time a person takes to read and type a code.
const TOTP_EPOCH_TOLERANCE_SECONDS = 30;

async function verifyTotpCode(secret, code) {
  try {
    const result = await otplib.verify({
      secret,
      token: code,
      strategy: 'totp',
      epochTolerance: TOTP_EPOCH_TOLERANCE_SECONDS,
    });
    return result.valid;
  } catch {
    // otplib throws on malformed input (e.g. a non-6-digit backup code)
    // rather than returning { valid: false } -- treat that as simply invalid.
    return false;
  }
}

function generateBackupCodes(count = BACKUP_CODE_COUNT) {
  return Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

async function login(username, password) {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    throw new AppError(401, ERROR_CODES.INVALID_CREDENTIALS);
  }
  if (!user.isActive) {
    throw new AppError(403, ERROR_CODES.ACCOUNT_INACTIVE);
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    throw new AppError(401, ERROR_CODES.INVALID_CREDENTIALS);
  }

  const mfaEnrolled = Boolean(user.totpSecretEncrypted);
  const mfaToken = signToken(
    { sub: user.id, purpose: 'mfa-pending', sv: user.sessionVersion },
    MFA_TOKEN_EXPIRY,
  );

  return { mfaToken, mfaEnrolled };
}

async function startEnrollment(mfaToken) {
  const payload = verifyToken(mfaToken, 'mfa-pending');

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) {
    throw new AppError(401, ERROR_CODES.MFA_TOKEN_INVALID);
  }
  assertSessionVersion(payload, user);
  if (user.totpSecretEncrypted) {
    throw new AppError(409, ERROR_CODES.MFA_ALREADY_ENROLLED);
  }

  const secret = otplib.generateSecret({ length: 20 });
  const otpauthUri = otplib.generateURI({
    strategy: 'totp',
    issuer: config.totpIssuerName,
    label: user.username,
    secret,
  });
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUri);

  const enrollmentToken = signToken(
    { sub: user.id, purpose: 'mfa-enroll', secret, sv: user.sessionVersion },
    ENROLLMENT_TOKEN_EXPIRY,
  );

  return { enrollmentToken, otpauthUri, qrCodeDataUrl };
}

async function confirmEnrollment(enrollmentToken, code) {
  const payload = verifyToken(enrollmentToken, 'mfa-enroll');
  const { sub: userId, secret } = payload;

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) {
    throw new AppError(401, ERROR_CODES.MFA_TOKEN_INVALID);
  }
  assertSessionVersion(payload, existing);

  if (!(await verifyTotpCode(secret, code))) {
    throw new AppError(401, ERROR_CODES.MFA_CODE_INVALID);
  }

  const backupCodes = generateBackupCodes();
  const backupCodesHashed = await Promise.all(
    backupCodes.map((code_) => bcrypt.hash(code_, BCRYPT_COST)),
  );

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      totpSecretEncrypted: envelope.encrypt(secret),
      backupCodesHashed,
    },
  });

  return {
    token: issueSessionToken(user),
    backupCodes,
    mustChangePassword: user.mustChangePassword,
  };
}

async function verifyMfa(mfaToken, code) {
  const payload = verifyToken(mfaToken, 'mfa-pending');
  const userId = payload.sub;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.totpSecretEncrypted) {
    throw new AppError(409, ERROR_CODES.MFA_NOT_ENROLLED);
  }
  assertSessionVersion(payload, user);
  const session = () => ({
    token: issueSessionToken(user),
    mustChangePassword: user.mustChangePassword,
  });

  const secret = envelope.decrypt(user.totpSecretEncrypted);
  if (await verifyTotpCode(secret, code)) {
    return session();
  }

  // Fall back to a one-time backup code.
  for (const hashedCode of user.backupCodesHashed) {
    if (await bcrypt.compare(code, hashedCode)) {
      await prisma.user.update({
        where: { id: userId },
        data: { backupCodesHashed: user.backupCodesHashed.filter((c) => c !== hashedCode) },
      });
      return session();
    }
  }

  throw new AppError(401, ERROR_CODES.MFA_CODE_INVALID);
}

async function changePassword(userId, currentPassword, newPassword) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppError(401, ERROR_CODES.UNAUTHENTICATED);
  }

  const passwordMatches = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!passwordMatches) {
    throw new AppError(401, ERROR_CODES.INVALID_CREDENTIALS);
  }

  const updated = await setUserPassword(userId, newPassword, { mustChangePassword: false });
  await prisma.auditLog.create({
    data: {
      actorUserId: userId,
      action: AUDIT_ACTIONS.PASSWORD_CHANGED,
      outcome: AUDIT_OUTCOMES.SUCCESS,
    },
  });

  // The change signed out every older session, this one included -- hand
  // back a fresh token so the user stays signed in where they made it.
  return { token: issueSessionToken(updated) };
}

module.exports = {
  login,
  startEnrollment,
  confirmEnrollment,
  verifyMfa,
  changePassword,
  issueSessionToken,
};
