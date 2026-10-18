import { useRef, useState } from 'react';
import { Dialog, Field } from '../../../../components/Dialog';
import { useAuth } from '../../../../lib/AuthContext';
import { PERIOD_LABELS } from '../../../../lib/chartData';
import { createWidget, previewWidget } from '../../../../lib/dashboardApi';
import { WidgetChart } from './WidgetChart';

const EXAMPLES = {
  CLOUDOPS: [
    'Virtual machines by state',
    'Storage volumes and their sizes',
    'How many storage buckets there are',
  ],
  FINOPS: [
    'Daily cost by service for the last 30 days',
    'Monthly cost for the last 6 months',
    'Total cost this month',
  ],
};

const secondaryClass =
  'rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700';
const primaryClass =
  'rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-60';

/**
 * Add a graph: the Operator describes it, the AI works out the command and
 * writes the page that draws it, and the Operator sees both before anything is
 * saved.
 */
export function AddWidgetDialog({ workspace, mode, onCreated, onClose }) {
  const { token } = useAuth();
  const [query, setQuery] = useState('');
  // 'input' -> 'generating' -> 'preview' -> 'saving'
  const [phase, setPhase] = useState('input');
  const [preview, setPreview] = useState(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  // Ignores a preview that comes back after the Operator has moved on.
  const requestRef = useRef(0);

  async function generate() {
    const text = query.trim();
    if (!text) return;
    const requestId = ++requestRef.current;
    setError('');
    setPhase('generating');
    try {
      const result = await previewWidget(token, { workspaceId: workspace.id, mode, query: text });
      if (requestId !== requestRef.current) return;
      setPreview(result);
      setTitle(result.draft.title);
      setPhase('preview');
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setError(err.message || 'The graph could not be built.');
      setPhase('input');
    }
  }

  async function save() {
    const { draft } = preview;
    setError('');
    setPhase('saving');
    try {
      const widget = await createWidget(token, {
        workspaceId: workspace.id,
        mode,
        query: draft.query,
        title: title.trim() || draft.title,
        commandTemplate: draft.commandTemplate,
        period: draft.period,
        chartSpec: draft.chartSpec,
        chartHtml: draft.chartHtml,
      });
      onCreated(widget);
    } catch (err) {
      setError(err.message || 'The graph could not be saved.');
      setPhase('preview');
    }
  }

  function startOver() {
    requestRef.current += 1;
    setPreview(null);
    setError('');
    setPhase('input');
  }

  const showingPreview = phase === 'preview' || phase === 'saving';

  return (
    <Dialog title="Add graph" size="xl" onClose={onClose}>
      {!showingPreview ? (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            generate();
          }}
        >
          <label className="block">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
              What should this graph show?
            </span>
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  generate();
                }
              }}
              rows={3}
              maxLength={500}
              disabled={phase === 'generating'}
              placeholder="Describe it in plain language"
              className="mt-1 w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>

          <div className="flex flex-wrap gap-2">
            {(EXAMPLES[mode] ?? []).map((example) => (
              <button
                key={example}
                type="button"
                disabled={phase === 'generating'}
                onClick={() => setQuery(example)}
                className="rounded-full border border-gray-200 px-3 py-1 text-xs text-gray-600 hover:border-teal-500 hover:text-teal-700 disabled:opacity-60 dark:border-gray-600 dark:text-gray-300 dark:hover:text-teal-300"
              >
                {example}
              </button>
            ))}
          </div>

          <p className="text-xs text-gray-400 dark:text-gray-500">
            Graphs only read from your cloud account. A request that would change anything is
            refused.
          </p>

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          {phase === 'generating' && (
            <p className="text-sm text-gray-500 dark:text-gray-400" role="status">
              Working out the command, running it and drawing the graph. This can take a minute or
              two…
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className={secondaryClass}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={phase === 'generating' || !query.trim()}
              className={primaryClass}
            >
              {phase === 'generating' ? 'Generating…' : 'Generate'}
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field
              label="Title"
              value={title}
              maxLength={80}
              disabled={phase === 'saving'}
              onChange={(e) => setTitle(e.target.value)}
            />
            {preview.draft.period !== 'NONE' && (
              <p className="pb-2 text-sm text-gray-500 dark:text-gray-400">
                Period: {PERIOD_LABELS[preview.draft.period]}
              </p>
            )}
          </div>

          <div className="rounded-xl border border-gray-200 p-3 dark:border-gray-700 dark:bg-gray-900">
            <WidgetChart
              title={title || preview.draft.title}
              spec={preview.draft.chartSpec}
              html={preview.draft.chartHtml}
              result={preview.result}
            />
          </div>

          <div>
            <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
              Command behind this graph
            </p>
            <pre className="mt-1 whitespace-pre-wrap break-all rounded-lg bg-gray-50 p-3 font-mono text-xs text-gray-700 dark:bg-gray-950 dark:text-gray-300">
              {preview.command}
            </pre>
            {preview.draft.period !== 'NONE' && (
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                Shown with today&apos;s dates. They move with the period each time the graph
                refreshes, and you can change the period on the graph after saving.
              </p>
            )}
          </div>

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={phase === 'saving'}
              className={secondaryClass}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={startOver}
              disabled={phase === 'saving'}
              className={secondaryClass}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={save}
              disabled={phase === 'saving'}
              className={primaryClass}
            >
              {phase === 'saving' ? 'Saving…' : 'Save to dashboard'}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
