import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../lib/AuthContext';
import {
  getOrganisation,
  updateWorkspace,
  deleteWorkspace,
  setWorkspaceCredential,
} from '../../lib/adminApi';
import { useToast } from '../../lib/ToastContext';
import { ConfirmDialog, Field } from '../../components/Dialog';
import { AdminLayout } from './AdminLayout';
import { CredentialForm } from './CredentialForm';
import { accountLabel, cspKind, cspLabel } from '../../lib/csp';

const sectionClass =
  'mt-6 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900';
const secondaryButtonClass =
  'rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800';
const dangerButtonClass =
  'rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-60 dark:border-red-800 dark:hover:bg-red-950';
const badgeClass =
  'ml-2 rounded-full bg-gray-100 px-2 py-0.5 align-middle text-xs font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400';

export const workspaceLabel = (ws) => `${cspLabel(ws.csp)} · ${ws.account} · ${ws.environment}`;

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

/** Account and environment, saved together. The provider never changes. */
function DetailsForm({ workspace, onSave }) {
  const [account, setAccount] = useState(workspace.account);
  const [environment, setEnvironment] = useState(workspace.environment);
  const [saving, setSaving] = useState(false);
  const changed =
    account.trim() !== workspace.account || environment.trim() !== workspace.environment;

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave({ account: account.trim(), environment: environment.trim() });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className={`${sectionClass} space-y-4`}>
      <SectionHeading title="Details" />
      <div>
        <p className="text-sm font-medium text-gray-700 dark:text-gray-200">Provider</p>
        <p className="mt-1 text-sm text-gray-900 dark:text-gray-100">{cspLabel(workspace.csp)}</p>
      </div>
      <Field
        label={accountLabel(workspace.csp)}
        required
        value={account}
        onChange={(e) => setAccount(e.target.value)}
      />
      <Field
        label="Environment"
        required
        value={environment}
        onChange={(e) => setEnvironment(e.target.value)}
      />
      <button
        type="submit"
        disabled={saving || !changed}
        className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
      >
        {saving ? 'Saving…' : 'Save changes'}
      </button>
    </form>
  );
}

function CredentialsSection({ workspace, onSave }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const attached = Boolean(workspace.credential);

  async function save(body) {
    setBusy(true);
    setError('');
    try {
      await onSave(body);
      return true;
    } catch (err) {
      setError(err.message || 'Could not save the credentials.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={sectionClass}>
      <SectionHeading
        title="Credentials"
        description="Saved credentials are encrypted and never shown again. To change them, enter a full new set."
      />
      <p className="mt-3 text-sm">
        {attached ? (
          <span className="text-teal-700 dark:text-teal-400">
            Attached · last updated {new Date(workspace.credential.updatedAt).toLocaleString()}
          </span>
        ) : (
          <span className="text-amber-600">Not attached. Operators can't use this workspace yet.</span>
        )}
      </p>
      {attached && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Saving below replaces the current credentials.
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </p>
      )}
      <div className="mt-4">
        <CredentialForm
          csp={workspace.csp}
          busy={busy}
          submitLabel={attached ? 'Replace credentials' : 'Attach credentials'}
          onSubmit={save}
        />
      </div>
    </section>
  );
}

export function WorkspaceDetail() {
  const { id, workspaceId } = useParams();
  const { token } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [org, setOrg] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // { type: 'deactivate' | 'reactivate' | 'delete' }
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);

  function refresh() {
    getOrganisation(token, id)
      .then(setOrg)
      .catch((err) => {
        setLoadFailed(true);
        toast.error(err.message || 'Could not load the workspace.');
      });
  }

  useEffect(refresh, [token, id]);

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
      await updateWorkspace(token, id, workspaceId, body);
      toast.success('Workspace saved.');
      refresh();
    } catch (err) {
      toast.error(err.message || 'Could not save the workspace.');
    }
  }

  async function saveCredential(body) {
    await setWorkspaceCredential(token, id, workspaceId, body);
    toast.success('Credentials saved.');
    refresh();
  }

  async function remove() {
    setBusy(true);
    try {
      await deleteWorkspace(token, id, workspaceId);
      toast.success('Workspace deleted.');
      navigate(`/admin/organisations/${id}`, { replace: true });
    } catch (err) {
      toast.error(err.message || 'Could not delete the workspace.');
      setBusy(false);
    }
  }

  const close = () => !busy && setDialog(null);
  const backLink = (
    <Link
      to={`/admin/organisations/${id}`}
      className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-400"
    >
      ← {org ? org.name : 'Back to organisation'}
    </Link>
  );

  const workspace = org?.workspaces.find((w) => w.id === workspaceId);

  if (!workspace) {
    return (
      <AdminLayout title="Workspace">
        {backLink}
        <p className="mt-4 text-sm text-gray-500">
          {loadFailed
            ? 'Could not load the workspace.'
            : org
              ? 'This workspace no longer exists.'
              : 'Loading...'}
        </p>
      </AdminLayout>
    );
  }

  const label = workspaceLabel(workspace);

  return (
    <AdminLayout title={label}>
      {backLink}

      <div className="mt-4">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-50">
          {label}
          <span className={badgeClass}>
            {cspKind(workspace.csp) === 'onprem' ? 'On-Prem' : 'Cloud'}
          </span>
          {!workspace.isActive && <span className={badgeClass}>Deactivated</span>}
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Added {new Date(workspace.createdAt).toLocaleDateString()}
        </p>
      </div>

      {/* Keyed on the saved values so the form resets to them after each save. */}
      <DetailsForm
        key={`${workspace.account}|${workspace.environment}`}
        workspace={workspace}
        onSave={saveDetails}
      />

      <CredentialsSection workspace={workspace} onSave={saveCredential} />

      <section className={sectionClass}>
        <SectionHeading
          title="Status"
          description={
            workspace.isActive
              ? 'Deactivating hides it from operators and keeps its chat history and credentials.'
              : 'This workspace is deactivated and hidden from operators.'
          }
        />
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => setDialog({ type: workspace.isActive ? 'deactivate' : 'reactivate' })}
            className={secondaryButtonClass}
          >
            {workspace.isActive ? 'Deactivate' : 'Reactivate'}
          </button>
          <button
            type="button"
            onClick={() => setDialog({ type: 'delete' })}
            className={dangerButtonClass}
          >
            Delete workspace
          </button>
        </div>
      </section>

      {dialog?.type === 'deactivate' && (
        <ConfirmDialog
          title="Deactivate workspace?"
          message={`${label} will be hidden from operators, and its chats can no longer run. Its chat history and credentials are kept, and you can reactivate it later.`}
          confirmLabel="Deactivate"
          busy={busy}
          onClose={close}
          onConfirm={() =>
            run(
              () => updateWorkspace(token, id, workspaceId, { isActive: false }),
              'Workspace deactivated.',
              'Could not deactivate the workspace.',
            )
          }
        />
      )}
      {dialog?.type === 'reactivate' && (
        <ConfirmDialog
          title="Reactivate workspace?"
          message={`${label} will be available to operators again.`}
          confirmLabel="Reactivate"
          tone="primary"
          busy={busy}
          onClose={close}
          onConfirm={() =>
            run(
              () => updateWorkspace(token, id, workspaceId, { isActive: true }),
              'Workspace reactivated.',
              'Could not reactivate the workspace.',
            )
          }
        />
      )}
      {dialog?.type === 'delete' && (
        <ConfirmDialog
          title="Delete workspace?"
          message={`This permanently deletes ${label}, including its saved credentials. Workspaces with chat history can't be deleted; deactivate them instead.`}
          confirmLabel="Delete"
          busy={busy}
          onClose={close}
          onConfirm={remove}
        />
      )}
    </AdminLayout>
  );
}
