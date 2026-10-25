import { useState } from 'react';
import {
  CopyIcon,
  RefreshIcon,
  SparkleIcon,
  TableIcon,
  TerminalIcon,
  TrashIcon,
} from '../../../../components/icons';
import { PERIOD_LABELS, timeAgo } from '../../../../lib/chartData';
import { CommandSteps, stepsText } from './CommandSteps';
import { WidgetChart } from './WidgetChart';

const selectClass =
  'rounded-md border border-gray-200 bg-white px-1.5 py-1 text-xs text-gray-600 focus:border-teal-500 focus:outline-none disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300';

function iconButtonClass(active) {
  return `rounded-md p-1.5 transition disabled:opacity-50 ${
    active
      ? 'bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300'
      : 'text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200'
  }`;
}

function Skeleton() {
  return (
    <div
      className="animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800"
      style={{ height: 260 }}
      aria-label="Loading graph"
    />
  );
}

/**
 * One graph on the dashboard: its chart, when it was last updated, and the
 * controls to change its period, refresh it, have the AI draw it again, see
 * its data or its command, or remove it. A graph whose last refresh failed keeps showing its previous
 * result, with the failure underneath.
 */
export function WidgetCard({ widget, busy, onRefresh, onRedraw, onUpdate, onDelete }) {
  const [showTable, setShowTable] = useState(false);
  const [showCommand, setShowCommand] = useState(false);
  const [copied, setCopied] = useState(false);

  const { chartSpec: spec, lastResult: result, lastError: error } = widget;
  const hasPeriod = widget.period !== 'NONE';
  const chained = (widget.steps?.length ?? 0) > 1;
  // Without a page the rows are already shown as a table.
  const canShowTable = Boolean(result) && Boolean(widget.chartHtml);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(
        chained ? stepsText(widget.steps) : widget.commandTemplate,
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access denied: the command is on screen to select by hand.
    }
  }

  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3
            className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100"
            title={widget.title}
          >
            {widget.title}
          </h3>
          <p
            className="mt-0.5 truncate text-xs text-gray-400 dark:text-gray-500"
            title={widget.query}
          >
            {widget.query}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {hasPeriod && (
            <select
              aria-label="Period"
              value={widget.period}
              disabled={busy}
              onChange={(e) => onUpdate(widget.id, { period: e.target.value })}
              className={selectClass}
            >
              {Object.entries(PERIOD_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          )}
          {canShowTable && (
            <button
              type="button"
              onClick={() => setShowTable((v) => !v)}
              aria-pressed={showTable}
              aria-label="View as table"
              title="View as table"
              className={iconButtonClass(showTable)}
            >
              <TableIcon className="size-4" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowCommand((v) => !v)}
            aria-pressed={showCommand}
            aria-label="Show command"
            title="Show command"
            className={iconButtonClass(showCommand)}
          >
            <TerminalIcon className="size-4" />
          </button>
          {result && (
            <button
              type="button"
              onClick={() => onRedraw(widget.id)}
              disabled={busy}
              aria-label="Redraw with AI"
              title="Redraw with AI: a new drawing of the same data"
              className={iconButtonClass(false)}
            >
              <SparkleIcon className="size-4" />
            </button>
          )}
          <button
            type="button"
            onClick={() => onRefresh(widget.id)}
            disabled={busy}
            aria-label="Refresh"
            title="Refresh"
            className={iconButtonClass(false)}
          >
            <RefreshIcon className={`size-4 ${busy ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={() => onDelete(widget)}
            disabled={busy}
            aria-label="Remove graph"
            title="Remove graph"
            className={iconButtonClass(false)}
          >
            <TrashIcon className="size-4" />
          </button>
        </div>
      </header>

      <div className="mt-3 min-w-0">
        {result ? (
          <WidgetChart
            title={widget.title}
            spec={spec}
            html={widget.chartHtml}
            result={result}
            asTable={showTable}
          />
        ) : busy ? (
          <Skeleton />
        ) : (
          <div
            className="flex flex-col items-center justify-center gap-2 text-center text-sm text-gray-500 dark:text-gray-400"
            style={{ height: 260 }}
          >
            <p>{error ? 'This graph could not be loaded.' : 'This graph has not run yet.'}</p>
            <button
              type="button"
              onClick={() => onRefresh(widget.id)}
              className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-400"
            >
              {error ? 'Try again' : 'Run it now'}
            </button>
          </div>
        )}
      </div>

      {showCommand && (
        <div className="mt-3 rounded-lg bg-gray-50 p-3 dark:bg-gray-950">
          <div className="flex items-start gap-2">
            {chained ? (
              <div className="min-w-0 flex-1">
                <CommandSteps steps={widget.steps} />
              </div>
            ) : (
              <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-xs text-gray-700 dark:text-gray-300">
                {widget.commandTemplate}
              </pre>
            )}
            <button
              type="button"
              onClick={copyCommand}
              aria-label={chained ? 'Copy commands' : 'Copy command'}
              title={copied ? 'Copied' : chained ? 'Copy commands' : 'Copy command'}
              className={iconButtonClass(copied)}
            >
              <CopyIcon className="size-3.5" />
            </button>
          </div>
          {chained ? (
            <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
              Values in double braces are filled in each time the graph runs: {'{{item.…}}'} from
              each row of the step before
              {hasPeriod && ', and dates from the period'}.
            </p>
          ) : (
            hasPeriod && (
              <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                The dates in double braces are filled in from the period each time the graph runs.
              </p>
            )
          )}
        </div>
      )}

      <footer className="mt-3 space-y-1 text-xs">
        <p className="text-gray-400 dark:text-gray-500">
          {busy
            ? 'Updating…'
            : widget.lastRunAt
              ? `Updated ${timeAgo(widget.lastRunAt)}`
              : 'Not updated yet'}
          {result?.truncated &&
            !busy &&
            ' · Showing the largest values; the rest are grouped or left out.'}
          {result?.skippedItems > 0 &&
            !busy &&
            ` · ${result.skippedItems} ${result.skippedItems === 1 ? 'row was' : 'rows were'} skipped because their command failed.`}
        </p>
        {result && !widget.chartHtml && !busy && (
          <p className="text-gray-500 dark:text-gray-400">
            This graph has no drawing yet.{' '}
            <button
              type="button"
              onClick={() => onRedraw(widget.id)}
              className="font-medium text-teal-700 hover:underline dark:text-teal-400"
            >
              Draw it with AI
            </button>
          </p>
        )}
        {error && !busy && (
          <p className="break-words text-red-600 dark:text-red-400" role="status">
            {result ? 'Last refresh failed: ' : ''}
            {error}
          </p>
        )}
      </footer>
    </section>
  );
}
