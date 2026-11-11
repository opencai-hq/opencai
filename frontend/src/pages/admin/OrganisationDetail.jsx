import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../lib/AuthContext';
import { getOrganisation, updateOrganisation, createWorkspace } from '../../lib/adminApi';
import { useToast } from '../../lib/ToastContext';
import { Field, FormDialog } from '../../components/Dialog';
import { OrganisationDialog } from './ManageOrganisations';
import { AdminLayout } from './AdminLayout';
import { CSP_OPTIONS, CSP_OPTIONS_BY_KIND, accountLabel, cspLabel } from '../../lib/csp';
import { workspaceLabel } from './WorkspaceDetail';

/** Adding a Workspace: its provider, account and environment. */
function WorkspaceDialog({ busy, onSubmit, onClose }) {
  const [csp, setCsp] = useState(CSP_OPTIONS[0]);
  const [account, setAccount] = useState('');
  const [environment, setEnvironment] = useState('');
  return (
    <FormDialog
      title="Add workspace"
      submitLabel="Add workspace"
      submitting={busy}
      onSubmit={() => onSubmit({ csp, account, environment })}
      onClose={onClose}
    >
      <label className="block">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Provider</span>
        <select
          value={csp}
          onChange={(e) => setCsp(e.target.value)}
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        >
          <optgroup label="Cloud">
            {CSP_OPTIONS_BY_KIND.cloud.map((option) => (
              <option key={option} value={option}>
                {cspLabel(option)}
              </option>
            ))}
          </optgroup>
          <optgroup label="On-Prem">
            {CSP_OPTIONS_BY_KIND.onprem.map((option) => (
              <option key={option} value={option}>
                {cspLabel(option)}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      <Field
        label={accountLabel(csp)}
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
      <p className="text-xs text-gray-500 dark:text-gray-400">
        You'll add its credentials on the next page.
      </p>
    </FormDialog>
  );
}

/** One workspace; it opens the workspace's own page, where every change is made. */
function WorkspaceRow({ orgId, workspace }) {
  return (
    <Link
      to={`/admin/organisations/${orgId}/workspaces/${workspace.id}`}
      className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-4 hover:border-teal-400 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-teal-600 ${
        workspace.isActive ? '' : 'opacity-70'
      }`}
    >
      <div>
        <p className="font-medium text-gray-900 dark:text-gray-100">
          {workspaceLabel(workspace)}
          {!workspace.isActive && (
            <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              Deactivated
            </span>
          )}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Credentials:{' '}
          {workspace.credential ? (
            <span className="text-teal-700 dark:text-teal-400">set</span>
          ) : (
            <span className="text-amber-600">not set</span>
          )}
        </p>
      </div>
      <span className="text-sm font-medium text-teal-700 dark:text-teal-400">Manage →</span>
    </Link>
  );
}

export function OrganisationDetail() {
  const { id } = useParams();
  const { token } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [org, setOrg] = useState(null);
  // { type: 'details' | 'addWorkspace' }
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);

  function refresh() {
    getOrganisation(token, id)
      .then(setOrg)
      .catch((err) => toast.error(err.message || 'Could not load the organisation.'));
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

  /** Adds the workspace, then opens its page so its credentials can be attached. */
  async function addWorkspace(body) {
    setBusy(true);
    try {
      const workspace = await createWorkspace(token, id, body);
      toast.success('Workspace added. Attach its credentials below.');
      navigate(`/admin/organisations/${id}/workspaces/${workspace.id}`);
    } catch (err) {
      toast.error(err.message || 'Could not add the workspace.');
      setBusy(false);
    }
  }

  const close = () => !busy && setDialog(null);

  if (!org) {
    return (
      <AdminLayout title="Organisation">
        <p className="text-sm text-gray-500">Loading...</p>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title={org.name}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-50">{org.name}</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {[org.address, org.phone].filter(Boolean).join(' · ') || 'No contact details'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDialog({ type: 'details' })}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          Edit details
        </button>
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-50">Workspaces</h2>
        <button
          type="button"
          onClick={() => setDialog({ type: 'addWorkspace' })}
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
        >
          + Add workspace
        </button>
      </div>
      <div className="mt-3 space-y-3">
        {org.workspaces.map((workspace) => (
          <WorkspaceRow key={workspace.id} orgId={id} workspace={workspace} />
        ))}
        {org.workspaces.length === 0 && <p className="text-sm text-gray-400">No Workspaces yet.</p>}
      </div>

      {dialog?.type === 'details' && (
        <OrganisationDialog
          title="Edit organisation details"
          initial={org}
          busy={busy}
          onClose={close}
          onSubmit={(body) =>
            run(
              () => updateOrganisation(token, id, body),
              'Organisation details saved.',
              'Could not save the organisation details.',
            )
          }
        />
      )}
      {dialog?.type === 'addWorkspace' && (
        <WorkspaceDialog busy={busy} onClose={close} onSubmit={addWorkspace} />
      )}
    </AdminLayout>
  );
}
