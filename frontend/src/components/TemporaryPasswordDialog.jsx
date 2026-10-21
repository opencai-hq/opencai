import { Dialog } from './Dialog';
import { useToast } from '../lib/ToastContext';

/** Shows a just-issued temporary password once, with a copy button. */
export function TemporaryPasswordDialog({ username, temporaryPassword, onClose }) {
  const toast = useToast();

  async function copy() {
    try {
      await navigator.clipboard.writeText(temporaryPassword);
      toast.success('Copied');
    } catch {
      toast.error('Could not copy. Select the password and copy it by hand.');
    }
  }

  return (
    <Dialog title="Temporary password" onClose={onClose}>
      <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">
        Give this to {username}. It is shown only once; they will choose a new password at their
        next sign-in.
      </p>
      <div className="mt-4 flex gap-2">
        <input
          readOnly
          value={temporaryPassword}
          onFocus={(e) => e.target.select()}
          className="w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        />
        <button
          type="button"
          onClick={copy}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          Copy
        </button>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="mt-5 w-full rounded-lg bg-teal-600 py-2 text-sm font-medium text-white hover:bg-teal-700"
      >
        Done
      </button>
    </Dialog>
  );
}
