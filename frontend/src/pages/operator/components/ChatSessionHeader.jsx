import { useState } from 'react';
import { CopyIcon, PlusIcon } from '../../../components/icons';
import { ContextRing } from './ContextRing';

/** Sits beside the Chat/Dashboard switch, styled like the dashboard's Refresh all. */
export function NewSessionButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
    >
      <PlusIcon className="size-4" />
      New Session
    </button>
  );
}

export function ChatSessionHeader({ session }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(session.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied by the browser; not worth surfacing an error for.
    }
  }

  return (
    <div className="flex min-h-[38px] items-center gap-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleCopy}
          title="Copy session ID"
          className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1 font-mono text-xs text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          {session.id}
          <CopyIcon className="size-3.5" />
          {copied && <span className="text-teal-700 dark:text-teal-400">Copied</span>}
        </button>
        <ContextRing tokens={session.contextTokens} contextWindow={session.contextWindow} />
      </div>
    </div>
  );
}
