import { useState } from 'react';
import { useAuth } from '../lib/AuthContext';
import { changePassword } from '../lib/authApi';

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100';

function PasswordField({ label, value, onChange, minLength, autoFocus }) {
  return (
    <div>
      <label className="text-sm font-medium text-gray-700 dark:text-gray-200">
        {label}
        <input
          type="password"
          required
          minLength={minLength}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT_CLASS}
        />
      </label>
    </div>
  );
}

// Changing the password signs out every older session, this one included, so
// the fresh token the server returns is stored straight away.
export function ChangePasswordForm({
  currentLabel = 'Current password',
  submitLabel = 'Save',
  onChanged,
  onCancel,
}) {
  const { token, login: storeSession } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
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
      const { token: newToken } = await changePassword(token, currentPassword, newPassword);
      storeSession(newToken);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 space-y-3">
      <PasswordField
        label={currentLabel}
        value={currentPassword}
        onChange={setCurrentPassword}
        autoFocus
      />
      <PasswordField
        label="New password"
        value={newPassword}
        onChange={setNewPassword}
        minLength={8}
      />
      <PasswordField
        label="Confirm new password"
        value={confirmPassword}
        onChange={setConfirmPassword}
        minLength={8}
      />

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-2 pt-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-lg border border-gray-300 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="flex-1 rounded-lg bg-teal-600 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-60"
        >
          {submitting ? 'Saving...' : submitLabel}
        </button>
      </div>
    </form>
  );
}
