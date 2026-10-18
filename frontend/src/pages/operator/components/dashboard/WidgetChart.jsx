import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { buildChartDocument, CHART_MESSAGE_SOURCE, chartTheme } from '../../../../lib/chartFrame';
import { formatValue } from '../../../../lib/chartData';

const CHART_HEIGHT = 260;
const TABLE_ROW_LIMIT = 100;

// Whether the app is showing its dark theme right now, whichever of "dark" or
// "follow my device" put it there.
function subscribeToTheme(onChange) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
const isDarkNow = () => document.documentElement.classList.contains('dark');

/**
 * The AI-written page for one graph, in a frame of its own. The page is
 * untrusted code: the frame may run scripts and nothing else, so it cannot
 * reach this app, and its document allows no network (see lib/chartFrame.js).
 */
function ChartFrame({ html, result, unit, title, onError }) {
  const frameRef = useRef(null);
  const dark = useSyncExternalStore(subscribeToTheme, isDarkNow);
  const srcDoc = useMemo(
    () => buildChartDocument({ html, result, unit, theme: chartTheme(dark) }),
    [html, result, unit, dark],
  );

  useEffect(() => {
    function onMessage(event) {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (event.data?.source !== CHART_MESSAGE_SOURCE) return;
      onError(String(event.data.error ?? 'error'));
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onError]);

  return (
    <iframe
      ref={frameRef}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      className="block w-full border-0"
      style={{ height: CHART_HEIGHT }}
    />
  );
}

/** The rows as a table: every graph's data view, and the fallback drawing. */
export function WidgetTable({ result, unit }) {
  const { columns, rows } = result;
  const shown = rows.slice(0, TABLE_ROW_LIMIT);
  return (
    <div className="overflow-auto" style={{ height: CHART_HEIGHT }}>
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 bg-white dark:bg-gray-900">
          <tr>
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                className="border-b border-gray-200 px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i} className="border-b border-gray-100 last:border-0 dark:border-gray-800">
              {columns.map((column) => {
                const value = row[column];
                const numeric = typeof value === 'number';
                return (
                  <td
                    key={column}
                    className={`px-2 py-1.5 text-gray-700 dark:text-gray-200 ${
                      numeric ? 'text-right tabular-nums' : ''
                    }`}
                  >
                    {numeric ? formatValue(value, unit) : value === null ? '–' : String(value)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && (
        <p className="px-2 py-2 text-xs text-gray-400">
          Showing {shown.length} of {rows.length} rows.
        </p>
      )}
    </div>
  );
}

function EmptyChart() {
  return (
    <div
      className="flex items-center justify-center text-sm text-gray-400"
      style={{ height: CHART_HEIGHT }}
    >
      No data for this period.
    </div>
  );
}

/**
 * One graph's stored result, drawn by the page the AI wrote for it. The rows
 * are shown as a table instead when asked, when the graph has no page, or when
 * its page fails.
 */
export function WidgetChart({ title, spec, html, result, asTable = false }) {
  // The drawing that failed, so a new page or new rows get a fresh try.
  const [failure, setFailure] = useState(null);
  const failed = failure !== null && failure.html === html && failure.result === result;
  const onError = useMemo(() => (message) => setFailure({ html, result, message }), [html, result]);

  if (!result) return <EmptyChart />;
  // A count of nothing is a real answer: zero.
  const countsRows = spec.type === 'stat' && spec.agg === 'count';
  if (result.rows.length === 0 && !(countsRows && html && !asTable)) return <EmptyChart />;

  const tableUnit = spec.type === 'table' ? undefined : spec.unit;
  if (asTable || !html) return <WidgetTable result={result} unit={tableUnit} />;
  if (failed) {
    return (
      <div>
        <WidgetTable result={result} unit={tableUnit} />
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400" role="status">
          This graph&apos;s drawing failed ({failure.message}), so its data is shown as a table.
        </p>
      </div>
    );
  }
  return (
    <ChartFrame html={html} result={result} unit={spec.unit} title={title} onError={onError} />
  );
}
