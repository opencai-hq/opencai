import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/AuthContext';
import { listAgentPersonas, updateAgentPersona } from '../../lib/adminApi';
import { useToast } from '../../lib/ToastContext';

// Mirrors the backend's limit on a persona's systemPrompt.
const MAX_PROMPT_CHARS = 10000;

const LABELS = {
  CLOUDOPS: 'CloudOps',
  FINOPS_TAG_COMPLIANCE: 'FinOps · Tag Compliance',
  FINOPS_COST_ANALYTICS: 'FinOps · Cost Analytics',
  FINOPS_WASTE_MANAGEMENT: 'FinOps · Waste Management',
  FINOPS_COST_OPTIMISATION: 'FinOps · Cost Optimisation',
};

const inputClass =
  'block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100';

function PromptEditor({ persona, onSaved }) {
  const { token } = useAuth();
  const toast = useToast();
  const [text, setText] = useState(persona.systemPrompt);
  const [saving, setSaving] = useState(false);

  const label = LABELS[persona.modeKey] ?? persona.modeKey;
  const changed = text !== persona.systemPrompt;
  const tooLong = text.length > MAX_PROMPT_CHARS;
  const customised = persona.systemPrompt !== persona.defaultSystemPrompt;

  async function handleSave() {
    setSaving(true);
    try {
      // The backend replaces the whole persona and resets whatever is left
      // out, so its other settings are sent back unchanged.
      const saved = await updateAgentPersona(token, {
        mode: persona.mode,
        subMode: persona.subMode ?? undefined,
        systemPrompt: text,
        allowedBinaries: persona.allowedBinaries,
        mutatingCommandCap: persona.mutatingCommandCap ?? undefined,
        docLookupAllowed: persona.docLookupAllowed,
      });
      onSaved({ ...persona, ...saved });
      toast.success(`${label} prompt saved.`);
    } catch (err) {
      toast.error(err.message || 'Could not save the prompt.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <label
          htmlFor={`prompt-${persona.modeKey}`}
          className="text-sm font-medium text-gray-700 dark:text-gray-200"
        >
          {label}
        </label>
        {customised && (
          <span className="rounded-full bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-700 dark:bg-teal-900/40 dark:text-teal-300">
            Customised
          </span>
        )}
      </div>
      <textarea
        id={`prompt-${persona.modeKey}`}
        rows={8}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className={`mt-1 ${inputClass}`}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !changed || !text.trim() || tooLong}
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => setText(persona.defaultSystemPrompt)}
          disabled={saving || text === persona.defaultSystemPrompt}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          Reset to default
        </button>
        <span
          className={`ml-auto text-xs ${
            tooLong ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'
          }`}
        >
          {text.length.toLocaleString()} / {MAX_PROMPT_CHARS.toLocaleString()}
        </span>
      </div>
    </div>
  );
}

export function AgentPrompts() {
  const { token } = useAuth();
  const toast = useToast();
  const [personas, setPersonas] = useState(null);

  useEffect(() => {
    listAgentPersonas(token)
      .then(setPersonas)
      .catch((err) => toast.error(err.message || 'Could not load agent prompts.'));
  }, [token]);

  const replace = (saved) =>
    setPersonas((list) => list.map((p) => (p.modeKey === saved.modeKey ? saved : p)));

  return (
    <section className="mt-6 max-w-2xl rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-50">Agent prompts</h2>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        What each agent is told about its job. It is added to fixed safety and tool rules that
        cannot be changed here. A saved prompt applies from the next message.
      </p>
      {personas === null ? (
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">Loading…</p>
      ) : (
        <div className="mt-4 space-y-6">
          {personas.map((persona) => (
            <PromptEditor key={persona.modeKey} persona={persona} onSaved={replace} />
          ))}
        </div>
      )}
    </section>
  );
}
