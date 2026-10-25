import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/AuthContext';
import {
  listAdministrators,
  createAdministrator,
  deleteAdministrator,
  resetAdministratorMfa,
  resetAdministratorPassword,
  updateAdministrator,
} from '../../lib/adminApi';
import { MfaBadge } from '../../components/MfaBadge';
import { useToast } from '../../lib/ToastContext';
import { ConfirmDialog, Field, FormDialog } from '../../components/Dialog';
import { EditEmailDialog } from '../../components/EditEmailDialog';
import { TemporaryPasswordDialog } from '../../components/TemporaryPasswordDialog';
import { AdminLayout } from './AdminLayout';

function AddAdministratorDialog({ busy, onSubmit, onClose }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  return (
    <FormDialog
      title="Add administrator"
      submitLabel="Add administrator"
      submitting={busy}
      onSubmit={() => onSubmit({ username, password, email: email.trim() || undefined })}
      onClose={onClose}
    >
      <Field
        label="Username"
        required
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <Field
        label="Password"
        type="password"
        required
        minLength={8}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Field
        label="Email (optional)"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
    </FormDialog>
  );
}

export function ManageAdministrators() {
  const { token, user } = useAuth();
  const toast = useToast();
  const [admins, setAdmins] = useState(null);
  // Only the master admin may reset administrators' MFA or password, or edit
  // their emails (the backend enforces it).
  const iAmMaster = Boolean(admins?.some((a) => a.id === user?.id && a.isMasterAdmin));
  // { type: 'add' } | { type: 'delete' | 'resetMfa' | 'resetPassword' | 'email', admin }
  //   | { type: 'tempPassword', admin, temporaryPassword }
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);

  function refresh() {
    listAdministrators(token)
      .then(setAdmins)
      .catch((err) => toast.error(err.message || 'Could not load administrators.'));
  }

  useEffect(refresh, [token]);

  /** Runs a dialog's action; closes it on success, keeps it open on failure. */
  async function run(action, success, failure) {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      setDialog(null);
      refresh();
    } catch (err) {
      toast.error(err.message || failure);
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(admin) {
    setBusy(true);
    try {
      const { temporaryPassword } = await resetAdministratorPassword(token, admin.id);
      setDialog({ type: 'tempPassword', admin, temporaryPassword });
    } catch (err) {
      toast.error(err.message || 'Could not reset the password.');
    } finally {
      setBusy(false);
    }
  }

  const close = () => !busy && setDialog(null);

  return (
    <AdminLayout title="Manage Administrators">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-50">
          Manage Administrators
        </h1>
        <button
          type="button"
          onClick={() => setDialog({ type: 'add' })}
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
        >
          + Add administrator
        </button>
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            <tr>
              <th className="px-4 py-2 font-medium">Username</th>
              <th className="px-4 py-2 font-medium">Email</th>
              <th className="px-4 py-2 font-medium">MFA</th>
              <th className="px-4 py-2 font-medium">Created</th>
              <th className="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {admins?.map((admin) => (
              <tr key={admin.id}>
                <td className="px-4 py-2 text-gray-900 dark:text-gray-100">
                  {admin.username}
                  {admin.isMasterAdmin && (
                    <span className="ml-2 rounded-full bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-700 dark:bg-teal-950 dark:text-teal-300">
                      Protected
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-gray-500 dark:text-gray-400">
                  {admin.email || '—'}
                </td>
                <td className="px-4 py-2">
                  <MfaBadge enrolled={admin.mfaEnrolled} />
                </td>
                <td className="px-4 py-2 text-gray-500 dark:text-gray-400">
                  {new Date(admin.createdAt).toLocaleDateString()}
                </td>
                <td className="px-4 py-2 text-right">
                  <div className="flex justify-end gap-3">
                    {iAmMaster && (
                      <button
                        type="button"
                        onClick={() => setDialog({ type: 'email', admin })}
                        className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-400"
                      >
                        Edit email
                      </button>
                    )}
                    {iAmMaster && admin.id !== user?.id && (
                      <button
                        type="button"
                        onClick={() => setDialog({ type: 'resetPassword', admin })}
                        className="text-sm font-medium text-gray-600 hover:underline dark:text-gray-300"
                      >
                        Reset password
                      </button>
                    )}
                    {iAmMaster && admin.mfaEnrolled && (
                      <button
                        type="button"
                        onClick={() => setDialog({ type: 'resetMfa', admin })}
                        className="text-sm font-medium text-gray-600 hover:underline dark:text-gray-300"
                      >
                        Reset MFA
                      </button>
                    )}
                    {!admin.isMasterAdmin && (
                      <button
                        type="button"
                        onClick={() => setDialog({ type: 'delete', admin })}
                        className="text-sm font-medium text-red-600 hover:underline"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {admins?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                  No administrators yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {dialog?.type === 'add' && (
        <AddAdministratorDialog
          busy={busy}
          onClose={close}
          onSubmit={(body) =>
            run(
              () => createAdministrator(token, body),
              `Administrator "${body.username}" added.`,
              'Could not add the administrator.',
            )
          }
        />
      )}
      {dialog?.type === 'email' && (
        <EditEmailDialog
          username={dialog.admin.username}
          email={dialog.admin.email}
          busy={busy}
          onClose={close}
          onSubmit={(email) =>
            run(
              () => updateAdministrator(token, dialog.admin.id, { email }),
              `Email for "${dialog.admin.username}" updated.`,
              'Could not update the email.',
            )
          }
        />
      )}
      {dialog?.type === 'resetPassword' && (
        <ConfirmDialog
          title="Reset password?"
          message={`Reset ${dialog.admin.username}'s password? They will be signed out everywhere.`}
          confirmLabel="Reset password"
          busy={busy}
          onClose={close}
          onConfirm={() => resetPassword(dialog.admin)}
        />
      )}
      {dialog?.type === 'tempPassword' && (
        <TemporaryPasswordDialog
          username={dialog.admin.username}
          temporaryPassword={dialog.temporaryPassword}
          onClose={close}
        />
      )}
      {dialog?.type === 'delete' && (
        <ConfirmDialog
          title="Delete administrator?"
          message={`"${dialog.admin.username}" will no longer be able to sign in. This cannot be undone.`}
          confirmLabel="Delete"
          busy={busy}
          onClose={close}
          onConfirm={() =>
            run(
              () => deleteAdministrator(token, dialog.admin.id),
              `Administrator "${dialog.admin.username}" deleted.`,
              'Could not delete the administrator.',
            )
          }
        />
      )}
      {dialog?.type === 'resetMfa' && (
        <ConfirmDialog
          title="Reset MFA?"
          message={
            dialog.admin.id === user?.id
              ? 'Your authenticator and backup codes stop working. You stay signed in now, and set up MFA again at your next sign-in.'
              : `"${dialog.admin.username}"'s authenticator and backup codes stop working. They set up MFA again at their next sign-in.`
          }
          confirmLabel="Reset MFA"
          busy={busy}
          onClose={close}
          onConfirm={() =>
            run(
              () => resetAdministratorMfa(token, dialog.admin.id),
              `MFA reset for "${dialog.admin.username}".`,
              'Could not reset MFA.',
            )
          }
        />
      )}
    </AdminLayout>
  );
}
