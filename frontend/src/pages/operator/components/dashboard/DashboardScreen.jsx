import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '../../../../components/Dialog';
import { PlusIcon, RefreshIcon } from '../../../../components/icons';
import { useAuth } from '../../../../lib/AuthContext';
import { cspLabel } from '../../../../lib/csp';
import {
  deleteWidget,
  listWidgets,
  redrawWidget,
  refreshWidget,
  updateWidget,
} from '../../../../lib/dashboardApi';
import { useToast } from '../../../../lib/ToastContext';
import { AddWidgetDialog } from './AddWidgetDialog';
import { WidgetCard } from './WidgetCard';

const MODE_LABELS = { CLOUDOPS: 'CloudOps', FINOPS: 'FinOps' };
// How many graphs re-run at once. Each run is a real call to the cloud account.
const REFRESH_CONCURRENCY = 2;

/**
 * The Operator's own graphs for one Workspace and mode. Each graph shows its
 * last stored result at once; the ones that have gone stale are re-run in the
 * background, a couple at a time.
 *
 * Keyed by Workspace and mode in OperatorPage, so switching either starts a
 * fresh instance.
 */
export function DashboardScreen({ workspace, mode }) {
  const { token } = useAuth();
  const toast = useToast();
  const [widgets, setWidgets] = useState(null);
  const [maxWidgets, setMaxWidgets] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [busyIds, setBusyIds] = useState(() => new Set());
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const aliveRef = useRef(true);

  function replaceWidget(next) {
    setWidgets((prev) => prev?.map((w) => (w.id === next.id ? next : w)) ?? prev);
  }

  function setBusy(id, busy) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // Runs one change to a graph, showing it as busy meanwhile. A failure is
  // shown on the graph itself, which keeps its previous result.
  async function runOnWidget(id, action) {
    setBusy(id, true);
    try {
      const updated = await action();
      if (aliveRef.current) replaceWidget(updated);
    } catch (err) {
      if (!aliveRef.current) return;
      setWidgets(
        (prev) =>
          prev?.map((w) =>
            w.id === id ? { ...w, lastError: err.message || 'Could not update.' } : w,
          ) ?? prev,
      );
    } finally {
      if (aliveRef.current) setBusy(id, false);
    }
  }

  const refreshOne = (id) => runOnWidget(id, () => refreshWidget(token, id));

  async function refreshMany(ids) {
    const queue = [...ids];
    const worker = async () => {
      while (queue.length > 0 && aliveRef.current) await refreshOne(queue.shift());
    };
    await Promise.all(Array.from({ length: REFRESH_CONCURRENCY }, worker));
  }

  useEffect(() => {
    aliveRef.current = true;
    listWidgets(token, { workspaceId: workspace.id, mode })
      .then((res) => {
        if (!aliveRef.current) return;
        setWidgets(res.widgets);
        setMaxWidgets(res.maxWidgets);
        refreshMany(res.widgets.filter((w) => w.stale).map((w) => w.id));
      })
      .catch((err) => {
        if (aliveRef.current) setLoadError(err.message || 'Could not load the dashboard.');
      });
    return () => {
      aliveRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, workspace.id, mode]);

  async function confirmDelete() {
    setDeleteBusy(true);
    try {
      await deleteWidget(token, deleting.id);
      setWidgets((prev) => prev.filter((w) => w.id !== deleting.id));
      setDeleting(null);
    } catch (err) {
      toast.error(err.message || 'Could not remove the graph.');
    } finally {
      setDeleteBusy(false);
    }
  }

  const anyBusy = busyIds.size > 0;
  const full = widgets !== null && maxWidgets !== null && widgets.length >= maxWidgets;
  const fullMessage = `A dashboard holds up to ${maxWidgets} graphs. Remove one to add another.`;
  const addButton = (
    <button
      type="button"
      onClick={() => setAdding(true)}
      className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-60"
    >
      <PlusIcon className="size-4" />
      Add graph
    </button>
  );

  return (
    <div className="mx-auto w-full max-w-7xl pb-10">
      <div className="mb-6 flex flex-wrap items-start gap-3 pr-[86px]">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {MODE_LABELS[mode]} dashboard
          </h1>
          <p className="mt-1 truncate text-sm text-gray-500 dark:text-gray-400">
            {[
              workspace.organisation?.name,
              workspace.environment,
              cspLabel(workspace.csp),
              workspace.account,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        {widgets?.length > 0 && (
          <button
            type="button"
            onClick={() => refreshMany(widgets.map((w) => w.id))}
            disabled={anyBusy}
            className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            <RefreshIcon className={`size-4 ${anyBusy ? 'animate-spin' : ''}`} />
            Refresh all
          </button>
        )}
      </div>

      {loadError ? (
        <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
      ) : widgets === null ? (
        <p className="text-sm text-gray-400">Loading dashboard…</p>
      ) : widgets.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 px-6 py-16 text-center dark:border-gray-700">
          <p className="text-base font-medium text-gray-900 dark:text-gray-100">No graphs yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-gray-500 dark:text-gray-400">
            Describe a graph in plain language. You&apos;ll see a preview and the command behind it
            before it&apos;s added here.
          </p>
          <div className="mt-5 flex justify-center">{addButton}</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
          {widgets.map((widget) => (
            <WidgetCard
              key={widget.id}
              widget={widget}
              busy={busyIds.has(widget.id)}
              onRefresh={refreshOne}
              onRedraw={(id) => runOnWidget(id, () => redrawWidget(token, id))}
              onUpdate={(id, changes) => runOnWidget(id, () => updateWidget(token, id, changes))}
              onDelete={setDeleting}
            />
          ))}
          <button
            type="button"
            onClick={() => setAdding(true)}
            disabled={full}
            title={full ? fullMessage : undefined}
            className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-gray-300 text-sm font-medium text-gray-500 transition hover:border-teal-500 hover:text-teal-700 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-gray-300 disabled:hover:text-gray-500 dark:border-gray-700 dark:text-gray-400 dark:hover:border-teal-500 dark:hover:text-teal-300"
          >
            <PlusIcon className="size-5" />
            {full ? fullMessage : 'Add graph'}
          </button>
        </div>
      )}

      {adding && (
        <AddWidgetDialog
          workspace={workspace}
          mode={mode}
          onClose={() => setAdding(false)}
          onCreated={(widget) => {
            setWidgets((prev) => [...(prev ?? []), widget]);
            setAdding(false);
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="Remove this graph?"
          message={`"${deleting.title}" will be removed from your dashboard.`}
          confirmLabel="Remove"
          busy={deleteBusy}
          onConfirm={confirmDelete}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
