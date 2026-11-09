import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../lib/AuthContext';
import {
  getOrganisation,
  updateOrganisation,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  setWorkspaceCredential,
} from '../../lib/adminApi';
import { useToast } from '../../lib/ToastContext';
import { ConfirmDialog, Field, FormDialog } from '../../components/Dialog';
import { OrganisationDialog } from './ManageOrganisations';
import { AdminLayout } from './AdminLayout';
import { CSPS, CSP_OPTIONS, CSP_OPTIONS_BY_KIND, accountLabel, cspLabel } from '../../lib/csp';

const workspaceLabel = (ws) => `${cspLabel(ws.csp)} · ${ws.account} · ${ws.environment}`;

/** Adding a Workspace (with its cloud provider) or editing its account/environment. */
function WorkspaceDialog({ workspace, busy, onSubmit, onClose }) {
  const [csp, setCsp] = useState(workspace?.csp ?? CSP_OPTIONS[0]);
  const [account, setAccount] = useState(workspace?.account ?? '');
  const [environment, setEnvironment] = useState(workspace?.environment ?? '');
  return (
    <FormDialog
      title={workspace ? 'Edit workspace' : 'Add workspace'}
      submitLabel={workspace ? 'Save' : 'Add workspace'}
      submitting={busy}
      onSubmit={() =>
        onSubmit(workspace ? { account, environment } : { csp, account, environment })
      }
      onClose={onClose}
    >
      {!workspace && (
        <label className="block">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
            Provider
          </span>
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
      )}
      <Field
        label={accountLabel(workspace?.csp ?? csp)}
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
    </FormDialog>
  );
}

const emptyHost = () => ({ name: '', address: '', port: '' });
const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100';

const Help = ({ children }) =>
  children ? <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{children}</p> : null;

/** Repeatable name / address / port rows, with at least one row kept. */
function HostList({ label, hosts, onChange }) {
  const update = (index, key) => (e) =>
    onChange(hosts.map((host, i) => (i === index ? { ...host, [key]: e.target.value } : host)));
  return (
    <fieldset>
      <legend className="text-sm font-medium text-gray-700 dark:text-gray-200">{label}</legend>
      <div className="mt-1 space-y-2">
        {hosts.map((host, index) => (
          <div key={index} className="flex items-center gap-2">
            <input
              aria-label={`Server ${index + 1} name`}
              placeholder="Name"
              value={host.name}
              onChange={update(index, 'name')}
              autoComplete="off"
              className={INPUT_CLASS}
            />
            <input
              aria-label={`Server ${index + 1} address`}
              placeholder="Address"
              value={host.address}
              onChange={update(index, 'address')}
              autoComplete="off"
              className={INPUT_CLASS}
            />
            <input
              aria-label={`Server ${index + 1} port`}
              placeholder="22"
              inputMode="numeric"
              value={host.port}
              onChange={update(index, 'port')}
              autoComplete="off"
              className={`${INPUT_CLASS} w-20 shrink-0`}
            />
            <button
              type="button"
              disabled={hosts.length <= 1}
              onClick={() => onChange(hosts.filter((_, i) => i !== index))}
              className="shrink-0 text-sm font-medium text-red-600 hover:underline disabled:no-underline disabled:opacity-40"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...hosts, emptyHost()])}
        className="mt-2 text-sm font-medium text-teal-700 hover:underline dark:text-teal-400"
      >
        + Add server
      </button>
    </fieldset>
  );
}

/** The credential fields are the Workspace's provider's own (see lib/csp.js). */
function CredentialDialog({ workspace, busy, onSubmit, onClose }) {
  const fields = CSPS[workspace.csp]?.credentialFields ?? [];
  const [values, setValues] = useState({});
  const setValue = (name, value) => setValues((current) => ({ ...current, [name]: value }));
  const set = (name) => (e) => setValue(name, e.target.value);
  const hostsOf = (name) => values[name] ?? [emptyHost()];
  // Optional fields left blank are omitted, so the backend applies its default.
  const body = () => {
    const out = {};
    for (const field of fields) {
      const value = values[field.name];
      if (field.type === 'checkbox') {
        out[field.name] = value === true;
      } else if (field.type === 'hostList') {
        out[field.name] = hostsOf(field.name)
          .map((h) => ({ name: h.name.trim(), address: h.address.trim(), port: h.port.trim() }))
          .filter((h) => h.name || h.address || h.port)
          .map((h) => ({ ...h, port: h.port === '' ? 22 : Number(h.port) }));
      } else {
        const text = typeof value === 'string' ? value.trim() : '';
        if (text !== '') out[field.name] = text;
      }
    }
    return out;
  };
  return (
    <FormDialog
      title={workspace.credential ? 'Replace credentials' : 'Attach credentials'}
      submitLabel="Save credentials"
      submitting={busy}
      onSubmit={() => onSubmit(body())}
      onClose={onClose}
    >
      <p className="text-sm text-gray-600 dark:text-gray-300">
        {workspaceLabel(workspace)}
        {workspace.credential && ' — the saved credentials will be overwritten.'}
      </p>
      {fields.map((field) => {
        if (field.type === 'checkbox') {
          return (
            <label key={field.name} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={values[field.name] === true}
                onChange={(e) => setValue(field.name, e.target.checked)}
              />
              <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
                {field.label}
              </span>
            </label>
          );
        }
        if (field.type === 'hostList') {
          return (
            <HostList
              key={field.name}
              label={field.label}
              hosts={hostsOf(field.name)}
              onChange={(hosts) => setValue(field.name, hosts)}
            />
          );
        }
        if (field.multiline) {
          return (
            <label key={field.name} className="block">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
                {field.label}
              </span>
              <textarea
                required={!field.optional}
                rows={6}
                spellCheck={false}
                autoComplete="off"
                value={values[field.name] ?? ''}
                onChange={set(field.name)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs focus:border-teal-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              />
              <Help>{field.help}</Help>
            </label>
          );
        }
        return (
          <div key={field.name}>
            <Field
              label={field.label}
              type={field.secret ? 'password' : 'text'}
              required={!field.optional}
              autoComplete={field.secret ? 'new-password' : 'off'}
              value={values[field.name] ?? ''}
              onChange={set(field.name)}
            />
            <Help>{field.help}</Help>
          </div>
        );
      })}
    </FormDialog>
  );
}

function WorkspaceRow({ workspace, onAction }) {
  const action = (type, label, className) => (
    <button
      type="button"
      onClick={() => onAction(type, workspace)}
      className={`text-sm font-medium hover:underline ${className}`}
    >
      {label}
    </button>
  );
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900 ${
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
      <div className="flex flex-wrap gap-3">
        {action('edit', 'Edit', 'text-teal-700 dark:text-teal-400')}
        {action(
          'credential',
          workspace.credential ? 'Replace credentials' : 'Attach credentials',
          'text-gray-600 dark:text-gray-300',
        )}
        {workspace.isActive
          ? action('deactivate', 'Deactivate', 'text-gray-600 dark:text-gray-300')
          : action('reactivate', 'Reactivate', 'text-gray-600 dark:text-gray-300')}
        {action('delete', 'Delete', 'text-red-600')}
      </div>
    </div>
  );
}

export function OrganisationDetail() {
  const { id } = useParams();
  const { token } = useAuth();
  const toast = useToast();
  const [org, setOrg] = useState(null);
  // { type: 'details' | 'addWorkspace' | 'edit' | 'credential' | 'deactivate'
  //   | 'reactivate' | 'delete', workspace? }
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

  const close = () => !busy && setDialog(null);
  const ws = dialog?.workspace;

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
          <WorkspaceRow
            key={workspace.id}
            workspace={workspace}
            onAction={(type, target) => setDialog({ type, workspace: target })}
          />
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
        <WorkspaceDialog
          busy={busy}
          onClose={close}
          onSubmit={(body) =>
            run(
              () => createWorkspace(token, id, body),
              'Workspace added.',
              'Could not add the workspace.',
            )
          }
        />
      )}
      {dialog?.type === 'edit' && (
        <WorkspaceDialog
          workspace={ws}
          busy={busy}
          onClose={close}
          onSubmit={(body) =>
            run(
              () => updateWorkspace(token, id, ws.id, body),
              'Workspace saved.',
              'Could not save the workspace.',
            )
          }
        />
      )}
      {dialog?.type === 'credential' && (
        <CredentialDialog
          workspace={ws}
          busy={busy}
          onClose={close}
          onSubmit={(body) =>
            run(
              () => setWorkspaceCredential(token, id, ws.id, body),
              'Credentials saved.',
              'Could not save the credentials.',
            )
          }
        />
      )}
      {dialog?.type === 'deactivate' && (
        <ConfirmDialog
          title="Deactivate workspace?"
          message={`${workspaceLabel(ws)} will be hidden from operators, and its chats can no longer run. Its chat history and credentials are kept, and you can reactivate it later.`}
          confirmLabel="Deactivate"
          busy={busy}
          onClose={close}
          onConfirm={() =>
            run(
              () => updateWorkspace(token, id, ws.id, { isActive: false }),
              'Workspace deactivated.',
              'Could not deactivate the workspace.',
            )
          }
        />
      )}
      {dialog?.type === 'reactivate' && (
        <ConfirmDialog
          title="Reactivate workspace?"
          message={`${workspaceLabel(ws)} will be available to operators again.`}
          confirmLabel="Reactivate"
          tone="primary"
          busy={busy}
          onClose={close}
          onConfirm={() =>
            run(
              () => updateWorkspace(token, id, ws.id, { isActive: true }),
              'Workspace reactivated.',
              'Could not reactivate the workspace.',
            )
          }
        />
      )}
      {dialog?.type === 'delete' && (
        <ConfirmDialog
          title="Delete workspace?"
          message={`This permanently deletes ${workspaceLabel(ws)}, including its saved credentials. Workspaces with chat history can't be deleted; deactivate them instead.`}
          confirmLabel="Delete"
          busy={busy}
          onClose={close}
          onConfirm={() =>
            run(
              () => deleteWorkspace(token, id, ws.id),
              'Workspace deleted.',
              'Could not delete the workspace.',
            )
          }
        />
      )}
    </AdminLayout>
  );
}
