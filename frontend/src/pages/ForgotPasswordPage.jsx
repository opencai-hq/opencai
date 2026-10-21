import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import logo from '../assets/opencai-logo.png';
import { getPasswordResetAvailability, requestPasswordReset } from '../lib/authApi';

const linkClass = 'font-medium text-teal-700 hover:underline dark:text-teal-400';

export function ForgotPasswordPage() {
  // null while loading, then true/false: is email reset set up on this instance?
  const [available, setAvailable] = useState(null);
  const [identifier, setIdentifier] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    getPasswordResetAvailability()
      .then(({ available: isAvailable }) => setAvailable(isAvailable))
      .catch(() => setAvailable(false));
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await requestPasswordReset(identifier);
      setSent(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100 p-4 dark:bg-gray-950">
      <div className="w-full max-w-sm rounded-3xl bg-white p-8 shadow-sm dark:bg-gray-900">
        <img src={logo} alt="OpenCAI" className="h-8 w-auto" />
        <h1 className="mt-6 text-2xl font-bold text-gray-900 dark:text-gray-50">
          Forgot your password?
        </h1>

        {available === false && (
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            Contact your administrator to reset your password.
          </p>
        )}

        {available && sent && (
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            If an account matches, we&apos;ve sent a reset link to its email address. The link
            expires in 30 minutes.
          </p>
        )}

        {available && !sent && (
          <>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              Enter your username or email and we&apos;ll email you a link to choose a new password.
            </p>
            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
                Username or email
                <input
                  type="text"
                  required
                  autoFocus
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm font-normal focus:border-teal-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                />
              </label>

              {error && <p className="text-sm text-red-600">{error}</p>}

              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-lg bg-teal-600 py-2.5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
              >
                {submitting ? 'Sending...' : 'Send reset link'}
              </button>
            </form>
          </>
        )}

        <p className="mt-6 text-sm">
          <Link to="/login" className={linkClass}>
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
