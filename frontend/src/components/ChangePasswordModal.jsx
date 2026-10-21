import { useState } from 'react';
import { ChangePasswordForm } from './ChangePasswordForm';

export function ChangePasswordModal({ onClose }) {
  const [success, setSuccess] = useState(false);

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Change Password</h2>

        {success ? (
          <>
            <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">
              Your password has been updated.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-5 w-full rounded-lg bg-teal-600 py-2 text-sm font-medium text-white hover:bg-teal-700"
            >
              Done
            </button>
          </>
        ) : (
          <ChangePasswordForm onChanged={() => setSuccess(true)} onCancel={onClose} />
        )}
      </div>
    </div>
  );
}
