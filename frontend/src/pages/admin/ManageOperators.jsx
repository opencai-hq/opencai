import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/AuthContext';
import { listOperators, createOperator, listOrganisations } from '../../lib/adminApi';
import { useToast } from '../../lib/ToastContext';
import { Field, FormDialog } from '../../components/Dialog';
import { MfaBadge } from '../../components/MfaBadge';
import { AdminLayout } from './AdminLayout';

function OrgCheckboxes({ organisations, selected, onChange }) {
  return (
    <div className="flex flex-wrap gap-3">
      {organisations.map((org) => (
        <label
          key={org.id}
          className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-200"
        >
          <input
            type="checkbox"
            checked={selected.includes(org.id)}
            onChange={(e) => {
              onChange(
                e.target.checked ? [...selected, org.id] : selected.filter((id) => id !== org.id),
              );
            }}
          />
          {org.name}
        </label>
      ))}
      {organisations.length === 0 && (
        <p className="text-sm text-gray-400">No Organisations yet -- create one first.</p>
      )}
    </div>
  );
}

export function OrgAccessField({ organisations, selected, onChange }) {
  return (
    <div>
      <p className="text-sm font-medium text-gray-700 dark:text-gray-200">Organisation access</p>
      <div className="mt-1">
        <OrgCheckboxes organisations={organisations} selected={selected} onChange={onChange} />
      </div>
    </div>
  );
}

function AddOperatorDialog({ organisations, busy, onSubmit, onClose }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [organisationIds, setOrganisationIds] = useState([]);
  return (
    <FormDialog
      title="Add operator"
      submitLabel="Add operator"
      submitting={busy}
      onSubmit={() =>
        onSubmit({ username, password, email: email.trim() || undefined, organisationIds })
      }
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
        label="Email (optional, for password reset links)"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <OrgAccessField
        organisations={organisations}
        selected={organisationIds}
        onChange={setOrganisationIds}
      />
    </FormDialog>
  );
}

// Each row opens the operator's own page (OperatorDetail), where every change
// to them is made.
export function ManageOperators() {
  const { token } = useAuth();
  const toast = useToast();
  const [operators, setOperators] = useState(null);
  const [organisations, setOrganisations] = useState([]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  function refresh() {
    listOperators(token)
      .then(setOperators)
      .catch((err) => toast.error(err.message || 'Could not load operators.'));
    listOrganisations(token)
      .then(setOrganisations)
      .catch((err) => toast.error(err.message || 'Could not load organisations.'));
  }

  useEffect(refresh, [token]);

  async function add(body) {
    setBusy(true);
    try {
      await createOperator(token, body);
      toast.success(`Operator "${body.username}" added.`);
      setAdding(false);
      refresh();
    } catch (err) {
      toast.error(err.message || 'Could not add the operator.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminLayout title="Manage Operators">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-50">Manage Operators</h1>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
        >
          + Add operator
        </button>
      </div>

      <div className="mt-6 space-y-3">
        {operators?.map((operator) => (
          <div
            key={operator.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900"
          >
            <div>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {operator.username}
                {!operator.isActive && (
                  <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                    Deactivated
                  </span>
                )}
                <span className="ml-2">
                  <MfaBadge enrolled={operator.mfaEnrolled} />
                </span>
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {operator.email || 'No email'}
                {' · '}
                {operator.organisations.map((o) => o.name).join(', ') ||
                  'No Organisations assigned'}
              </p>
            </div>
            <Link
              to={`/admin/operators/${operator.id}`}
              className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              Edit
            </Link>
          </div>
        ))}
        {operators?.length === 0 && <p className="text-sm text-gray-400">No operators yet.</p>}
      </div>

      {adding && (
        <AddOperatorDialog
          organisations={organisations}
          busy={busy}
          onClose={() => !busy && setAdding(false)}
          onSubmit={add}
        />
      )}
    </AdminLayout>
  );
}
