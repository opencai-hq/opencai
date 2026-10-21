import { apiRequest } from './api';

export function login(username, password) {
  return apiRequest('/api/auth/login', { method: 'POST', body: { username, password } });
}

export function startEnrollment(mfaToken) {
  return apiRequest('/api/auth/mfa/enroll/start', { method: 'POST', body: { mfaToken } });
}

export function confirmEnrollment(enrollmentToken, code) {
  return apiRequest('/api/auth/mfa/enroll/confirm', {
    method: 'POST',
    body: { enrollmentToken, code },
  });
}

export function verifyMfa(mfaToken, code) {
  return apiRequest('/api/auth/mfa/verify', { method: 'POST', body: { mfaToken, code } });
}

export function changePassword(token, currentPassword, newPassword) {
  return apiRequest('/api/auth/change-password', {
    method: 'POST',
    token,
    body: { currentPassword, newPassword },
  });
}

export function getPasswordResetAvailability() {
  return apiRequest('/api/auth/password-reset/available');
}

export function requestPasswordReset(identifier) {
  return apiRequest('/api/auth/password-reset/request', { method: 'POST', body: { identifier } });
}

export function confirmPasswordReset(token, newPassword) {
  return apiRequest('/api/auth/password-reset/confirm', {
    method: 'POST',
    body: { token, newPassword },
  });
}
