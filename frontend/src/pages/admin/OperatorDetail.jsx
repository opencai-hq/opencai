import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../lib/AuthContext';
import {
  getOperator,
  updateOperator,
  deactivateOperator,
  deleteOperator,
  resetOperatorMfa,
  resetOperatorPassword,
  listOrganisations,
} from '../../lib/adminApi';
import { useToast } from '../../lib/ToastContext';
import { ConfirmDialog, Field } from '../../components/Dialog';
import { MfaBadge } from '../../components/MfaBadge';
import { TemporaryPasswordDialog } from '../../components/TemporaryPasswordDialog';
import { OrgAccessField } from './ManageOperators';
import { AdminLayout } from './AdminLayout';

const sectionClass =
  'mt-6 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900';
const secondaryButtonClass =
  'rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800';
const dangerButtonClass =
  'rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-60 dark:border-red-800 dark:hover:bg-red-950';

const sameIds = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

function SectionHeading({ title, description }) {
  return (
    <div>
      <h2 className="text-base font-semibold text-gray-900 dark:text-gray-50">{title}</h2>
      {description && (
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</p>
      )}
    </div>
  );
}

/** Email and Organisation access, saved together. */
function DetailsForm({ operator, organisations, onSave }) {
  const [email, setEmail] = useState(operator.email || '');
  const [organisationIds, setOrganisationIds] = useState(() =>
    operator.organisations.map((o) => o.id),
  );
  const [saving, setSaving] = useState(false);

  const savedIds = operator.organisations.map((o) => o.id);
  const emailChanged = email.trim() !== (operator.email || '');
  const orgsChanged = !sameIds(organisationIds, savedIds);

  async function handleSubmit(e) {
    e.preventDefault();
    const body = {};
    if (emailChanged) body.email = email.trim() || null; // empty clears it
    if (orgsChanged) body.organisationIds = organisationIds;
    setSaving(true);
    try {
      await onSave(body);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className={`${sectionClass} space-y-4`}>
      <SectionHeading title="Details" />
      <Field
        label="Email (for password reset links; leave empty to remove)"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <OrgAccessField
        organisations={organisations}
        selected={organisationIds}
        onChange={setOrganisationIds}
      />
      <button
        type="submit"
        disabled={saving || (!emailChanged && !orgsChanged)}
        className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
      >
        {saving ? 'Saving…' : 'Save changes'}
      </button>
    </form>
  );
}

export function OperatorDetail() {
  const { id } = useParams();
  const { token } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [operator, setOperator] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [organisations, setOrganisations] = useState([]);
  // { type: 'resetPassword' | 'resetMfa' | 'deactivate' | 'reactivate' | 'delete' }
  //   | { type: 'tempPassword', temporaryPassword }
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);

  function refresh() {
    getOperator(token, id)
      .then(setOperator)
      .catch((err) => {
        setLoadFailed(true);
        toast.error(err.message || 'Could not load the operator.');
      });
  }

  useEffect(refresh, [token, id]);
  useEffect(() => {
    listOrganisations(token)
      .then(setOrganisations)
      .catch((err) => toast.error(err.message || 'Could not load organisations.'));
  }, [token]);

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

  async function saveDetails(body) {
    try {
      setOperator(await updateOperator(token, id, body));
      toast.success('Changes saved.');
    } catch (err) {
      toast.error(err.message || 'Could not save the changes.');
    }
  }

  async function resetPassword() {
    setBusy(true);
    try {
      const { temporaryPassword } = await resetOperatorPassword(token, id);
      setDialog({ type: 'tempPassword', temporaryPassword });
    } catch (err) {
      toast.error(err.message || 'Could not reset the password.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await deleteOperator(token, id);
      toast.success(`Operator "${operator.username}" deleted.`);
      navigate('/admin/operators', { replace: true });
    } catch (err) {
      toast.error(err.message || 'Could not delete the operator.');
      setBusy(false);
    }
  }

  const close = () => !busy && setDialog(null);
  const backLink = (
    <Link
      to="/admin/operators"
      className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-400"
    >
      ← Back to operators
    </Link>
  );

  if (!operator) {
    return (
      <AdminLayout title="Operator">
        {backLink}
        <p className="mt-4 text-sm text-gray-500">
          {loadFailed ? 'Could not load the operator.' : 'Loading...'}
        </p>
      </AdminLayout>
    );
  }

  const name = operator.username;

  return (
    <AdminLayout title={name}>
      {backLink}

      <div className="mt-4">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-50">
          {name}
          {!operator.isActive && (
            <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 align-middle text-xs font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              Deactivated
            </span>
          )}
          <span className="ml-2 align-middle">
            <MfaBadge enrolled={operator.mfaEnrolled} />
          </span>
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Operator since {new Date(operator.createdAt).toLocaleDateString()}
        </p>
      </div>

      {/* Keyed on the saved values so the form resets to them after each save. */}
      <DetailsForm
        key={`${operator.email}|${operator.organisations.map((o) => o.id).join()}`}
        operator={operator}
        organisations={organisations}
        onSave={saveDetails}
      />

      <section className={sectionClass}>
        <SectionHeading
          title="Sign-in"
          description="Help an operator who is locked out. Both sign them out everywhere."
        />
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => setDialog({ type: 'resetPassword' })}
            className={secondaryButtonClass}
          >
            Reset password
          </button>
          {operator.mfaEnrolled && (
            <button
              type="button"
              onClick={() => setDialog({ type: 'resetMfa' })}
              className={secondaryButtonClass}
            >
              Reset MFA
            </button>
          )}
        </div>
      </section>

      <section className={sectionClass}>
        <SectionHeading
          title="Account"
          description={
            operator.isActive
              ? 'Deactivating stops them signing in and keeps their chat history.'
              : 'This operator is deactivated and cannot sign in.'
          }
        />
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => setDialog({ type: operator.isActive ? 'deactivate' : 'reactivate' })}
            className={secondaryButtonClass}
          >
            {operator.isActive ? 'Deactivate' : 'Reactivate'}
          </button>
          <button
            type="button"
            onClick={() => setDialog({ type: 'delete' })}
            className={dangerButtonClass}
          >
            Delete operator
          </button>
        </div>
      </section>

      {dialog?.type === 'resetPassword' && (
        <ConfirmDialog
          title="Reset password?"
          message={`Reset ${name}'s password? They will be signed out everywhere.`}
          confirmLabel="Reset password"
          busy={busy}
          onClose={close}
          onConfirm={resetPassword}
        />
      )}
      {dialog?.type === 'tempPassword' && (
        <TemporaryPasswordDialog
          username={name}
          temporaryPassword={dialog.temporaryPassword}
          onClose={close}
        />
      )}
      {dialog?.type === 'resetMfa' && (
        <ConfirmDialog
          title="Reset MFA?"
          message={`"${name}"'s authenticator and backup codes stop working. They set up MFA again (scanning a new QR code) at their next sign-in.`}
          confirmLabel="Reset MFA"
          busy={busy}
          onClose={close}
          onConfirm={() =>
            run(
              () => resetOperatorMfa(token, id),
              `MFA reset for "${name}".`,
              'Could not reset MFA.',
            )
          }
        />
      )}
      {dialog?.type === 'deactivate' && (
        <ConfirmDialog
          title="Deactivate operator?"
          message={`"${name}" will no longer be able to sign in. Their chat history is kept, and you can reactivate them later.`}
          confirmLabel="Deactivate"
          busy={busy}
          onClose={close}
          onConfirm={() =>
            run(
              () => deactivateOperator(token, id),
              `Operator "${name}" deactivated.`,
              'Could not deactivate the operator.',
            )
          }
        />
      )}
      {dialog?.type === 'reactivate' && (
        <ConfirmDialog
          title="Reactivate operator?"
          message={`"${name}" will be able to sign in again.`}
          confirmLabel="Reactivate"
          tone="primary"
          busy={busy}
          onClose={close}
          onConfirm={() =>
            run(
              () => updateOperator(token, id, { isActive: true }),
              `Operator "${name}" reactivated.`,
              'Could not reactivate the operator.',
            )
          }
        />
      )}
      {dialog?.type === 'delete' && (
        <ConfirmDialog
          title="Delete operator?"
          message={`This permanently deletes "${name}". Operators with chat history can't be deleted; deactivate them instead.`}
          confirmLabel="Delete"
          busy={busy}
          onClose={close}
          onConfirm={remove}
        />
      )}
    </AdminLayout>
  );
}
