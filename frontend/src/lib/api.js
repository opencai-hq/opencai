export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

// Fired on window so the auth layer can react without every caller handling it:
// a signed-in request answered 401 means the session was revoked (password
// changed elsewhere, account deactivated); PASSWORD_CHANGE_REQUIRED means an
// admin reset is waiting for a new password.
export const SESSION_EXPIRED_EVENT = 'opencai:session-expired';
export const PASSWORD_CHANGE_REQUIRED_EVENT = 'opencai:password-change-required';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function apiRequest(path, { method = 'GET', body, token } = {}) {
  const isFormData = body instanceof FormData;
  const headers = isFormData ? {} : { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : isFormData ? body : JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const code = data?.error?.code || 'UNKNOWN_ERROR';
    // Only UNAUTHENTICATED: a wrong current password on change-password is
    // also a 401 (INVALID_CREDENTIALS) but must not sign the user out.
    if (res.status === 401 && token && code === 'UNAUTHENTICATED') {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    } else if (res.status === 403 && code === 'PASSWORD_CHANGE_REQUIRED') {
      window.dispatchEvent(new Event(PASSWORD_CHANGE_REQUIRED_EVENT));
    }
    throw new ApiError(
      res.status,
      code,
      data?.error?.message || `Request failed with status ${res.status}`,
    );
  }

  return data;
}
