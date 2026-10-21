import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import logo from '../assets/opencai-logo.png';
import { confirmPasswordReset } from '../lib/authApi';

const linkClass = 'font-medium text-teal-700 hover:underline dark:text-teal-400';
const inputClass =
  'mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm font-normal focus:border-teal-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100';
const INVALID_LINK = 'This reset link is invalid or has expired. Request a new one.';

// Opened from the emailed link. Sets the password but does not sign in: the
// user signs in afterwards and still enters their MFA code.
export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  // Set when the link itself is bad: the form is replaced by a request-again link.
  const [linkError, setLinkError] = useState(token ? '' : INVALID_LINK);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      await confirmPasswordReset(token, newPassword);
      setDone(true);
    } catch (err) {
      if (err.code === 'PASSWORD_RESET_TOKEN_INVALID') setLinkError(err.message);
      else setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100 p-4 dark:bg-gray-950">
      <div className="w-full max-w-sm rounded-3xl bg-white p-8 shadow-sm dark:bg-gray-900">
        <img src={logo} alt="OpenCAI" className="h-8 w-auto" />
        <h1 className="mt-6 text-2xl font-bold text-gray-900 dark:text-gray-50">
          Choose a new password
        </h1>

        {done && (
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            Your password has been changed. Sign in with your new password.{' '}
            <Link to="/login" className={linkClass}>
              Sign in
            </Link>
          </p>
        )}

        {!done && linkError && (
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            {linkError}{' '}
            <Link to="/forgot-password" className={linkClass}>
              Request a new link
            </Link>
          </p>
        )}

        {!done && !linkError && (
          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
              New password
              <input
                type="password"
                required
                autoFocus
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
              Confirm new password
              <input
                type="password"
                required
                minLength={8}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={inputClass}
              />
            </label>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-teal-600 py-2.5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
            >
              {submitting ? 'Saving...' : 'Set new password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
