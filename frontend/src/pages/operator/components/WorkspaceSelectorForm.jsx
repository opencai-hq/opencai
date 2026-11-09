import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../lib/AuthContext';
import { listAccessibleOrganisations, listOrganisationWorkspaces } from '../../../lib/operatorApi';
import { accountLabel, cspKind, cspLabel } from '../../../lib/csp';

const selectClass =
  'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 disabled:opacity-50';

export function WorkspaceSelectorForm({ onComplete, kind = 'cloud' }) {
  const { token } = useAuth();
  const [organisations, setOrganisations] = useState([]);
  const [allWorkspaces, setWorkspaces] = useState(null);
  // Switching Cloud / On-Prem starts the choice over.
  useEffect(() => {
    setEnvironment('');
    setCsp('');
    setAccount('');
  }, [kind]);

  const workspaces = useMemo(
    () => (allWorkspaces || []).filter((w) => cspKind(w.csp) === kind),
    [allWorkspaces, kind],
  );
  const [orgId, setOrgId] = useState('');
  const [environment, setEnvironment] = useState('');
  const [csp, setCsp] = useState('');
  const [account, setAccount] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    listAccessibleOrganisations(token)
      .then(setOrganisations)
      .catch((err) => setError(err.message));
  }, [token]);

  useEffect(() => {
    setEnvironment('');
    setCsp('');
    setAccount('');
    if (!orgId) {
      setWorkspaces(null);
      return;
    }
    setWorkspaces(null);
    listOrganisationWorkspaces(token, orgId)
      .then(setWorkspaces)
      .catch((err) => setError(err.message));
  }, [token, orgId]);

  const environmentOptions = useMemo(
    () => [...new Set(workspaces.map((w) => w.environment))],
    [workspaces],
  );
  const cspOptions = useMemo(
    () => [...new Set(workspaces.filter((w) => w.environment === environment).map((w) => w.csp))],
    [workspaces, environment],
  );
  const accountOptions = useMemo(
    () => [
      ...new Set(
        workspaces
          .filter((w) => w.environment === environment && w.csp === csp)
          .map((w) => w.account),
      ),
    ],
    [workspaces, environment, csp],
  );

  useEffect(() => {
    if (!orgId || !environment || !csp || !account) return;
    const workspace = workspaces.find(
      (w) => w.environment === environment && w.csp === csp && w.account === account,
    );
    if (!workspace) return;
    const organisation = organisations.find((o) => o.id === orgId);
    onComplete({ ...workspace, organisation });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, environment, csp, account]);

  return (
    <div className="rounded-2xl border border-teal-200 bg-teal-50/40 p-6 dark:border-teal-900 dark:bg-teal-950/20">
      <h2 className="text-lg font-semibold text-teal-800 dark:text-teal-300">
        Choose your Workspace
      </h2>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {kind === 'onprem'
          ? 'Choose your Business, Environment, Provider, and Site / Cluster to manage on-prem infrastructure.'
          : 'Choose your Business, Environment, Cloud Provider, and Account to manage cloud resources.'}
      </p>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-gray-200">Business</label>
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className={selectClass}>
            <option value="">Select business...</option>
            {organisations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-gray-200">
            Environment
          </label>
          <select
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            disabled={!orgId}
            className={selectClass}
          >
            <option value="">Select environment...</option>
            {environmentOptions.map((env) => (
              <option key={env} value={env}>
                {env}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-gray-200">
            {kind === 'onprem' ? 'Provider' : 'Cloud Provider'}
          </label>
          <select
            value={csp}
            onChange={(e) => setCsp(e.target.value)}
            disabled={!environment}
            className={selectClass}
          >
            <option value="">Select cloud...</option>
            {cspOptions.map((option) => (
              <option key={option} value={option}>
                {cspLabel(option)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-gray-200">
            {kind === 'onprem' ? accountLabel(csp || 'SSH') : 'Account / Subscription'}
          </label>
          <select
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            disabled={!csp}
            className={selectClass}
          >
            <option value="">Select account...</option>
            {accountOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      </div>

      {orgId && allWorkspaces && workspaces.length === 0 && !error && (
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
          {kind === 'onprem'
            ? 'No on-prem Workspaces in this organisation'
            : 'No cloud Workspaces in this organisation'}
        </p>
      )}

      {organisations.length === 0 && !error && (
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
          You don't have access to any Organisations yet -- ask an Administrator to assign one.
        </p>
      )}
    </div>
  );
}
