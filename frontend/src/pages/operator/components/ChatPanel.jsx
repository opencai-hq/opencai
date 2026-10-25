import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { LogoTracer } from '../../../components/LogoTracer';

// A Markdown element rendered as `Tag` with fixed classes. react-markdown also
// passes the source `node`, which must not reach the DOM.
function styled(Tag, className, extra = {}) {
  function StyledMarkdownElement({ node: _node, ...props }) {
    return <Tag className={className} {...extra} {...props} />;
  }
  return StyledMarkdownElement;
}

// Tailwind has no prose styles here, so each Markdown element gets its own.
// Raw HTML in model output is not rendered (react-markdown's default).
const MARKDOWN_COMPONENTS = {
  p: styled('p', 'my-2 first:mt-0 last:mb-0'),
  strong: styled('strong', 'font-semibold'),
  a: styled('a', 'text-teal-700 underline dark:text-teal-400', { target: '_blank', rel: 'noreferrer' }),
  ul: styled('ul', 'my-2 list-disc space-y-1 pl-5'),
  ol: styled('ol', 'my-2 list-decimal space-y-1 pl-5'),
  h1: styled('h3', 'mb-2 mt-3 text-base font-semibold first:mt-0'),
  h2: styled('h3', 'mb-2 mt-3 text-base font-semibold first:mt-0'),
  h3: styled('h4', 'mb-1 mt-3 font-semibold first:mt-0'),
  blockquote: styled(
    'blockquote',
    'my-2 border-l-2 border-gray-300 pl-3 text-gray-600 dark:border-gray-600 dark:text-gray-300',
  ),
  pre: styled(
    'pre',
    'my-2 overflow-x-auto rounded-lg bg-gray-900 p-3 font-mono text-xs text-gray-100 dark:bg-black/40 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit',
  ),
  code: styled('code', 'rounded bg-gray-200 px-1 py-0.5 font-mono text-[0.85em] dark:bg-gray-700'),
  table: ({ node: _node, ...props }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse text-xs" {...props} />
    </div>
  ),
  th: styled('th', 'border border-gray-300 px-2 py-1 text-left font-semibold dark:border-gray-600'),
  td: styled('td', 'border border-gray-300 px-2 py-1 dark:border-gray-600'),
  hr: styled('hr', 'my-3 border-gray-200 dark:border-gray-700'),
};

function MarkdownText({ children }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
      {children}
    </Markdown>
  );
}

const STATUS_STYLES = {
  EXECUTED: 'bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300',
  FAILED: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
  REJECTED: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
  CAPPED: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  CANCELLED: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
  DRY_RUN: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  CONFIRMED: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
};

function StatusBadge({ status }) {
  if (!status) return null;
  const style = STATUS_STYLES[status] || 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300';
  return (
    <span className={`ml-2 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${style}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function TextBubble({ message }) {
  const isUser = message.role === 'USER';
  return (
    <div className={isUser ? 'text-right' : 'text-left'}>
      <div
        className={`inline-block max-w-[80%] rounded-2xl px-4 py-2 text-left text-sm ${
          isUser
            ? 'whitespace-pre-wrap bg-teal-600 text-white'
            : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-100'
        }`}
      >
        {isUser ? message.content : <MarkdownText>{message.content}</MarkdownText>}
      </div>
    </div>
  );
}

function CommandRequestCard({ message, onConfirm, onCancel, sending }) {
  // Read-only transcripts (chat history) pass no handlers and get no buttons.
  const isPending = message.status === 'PENDING_CONFIRMATION' && Boolean(onConfirm);
  const [acting, setActing] = useState(false);
  const disabled = sending || acting;

  async function handleConfirm() {
    setActing(true);
    try {
      await onConfirm(message.id);
    } finally {
      setActing(false);
    }
  }

  async function handleCancel() {
    setActing(true);
    try {
      await onCancel(message.id);
    } finally {
      setActing(false);
    }
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-left dark:border-amber-900 dark:bg-amber-950/20">
      <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-gray-800 dark:text-gray-100">
        {message.content}
      </pre>
      {isPending ? (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={disabled}
            className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
          >
            Confirm
          </button>
          <button
            type="button"
            onClick={handleCancel}
            disabled={disabled}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
        </div>
      ) : (
        <StatusBadge status={message.status} />
      )}
    </div>
  );
}

function CommandResultBlock({ message }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 text-left dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-1 flex items-center text-xs font-medium text-gray-500 dark:text-gray-400">
        Output
        <StatusBadge status={message.status} />
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-gray-700 dark:text-gray-200">
        {message.content}
      </pre>
    </div>
  );
}

function MessageItem({ message, onConfirm, onCancel, sending }) {
  if (message.kind === 'LOOKUP_REQUEST' || message.kind === 'COMMAND_REQUEST') {
    return <CommandRequestCard message={message} onConfirm={onConfirm} onCancel={onCancel} sending={sending} />;
  }
  if (message.kind === 'COMMAND_RESULT') {
    return <CommandResultBlock message={message} />;
  }
  return <TextBubble message={message} />;
}

const isRequest = (m) => m.kind === 'LOOKUP_REQUEST' || m.kind === 'COMMAND_REQUEST';

/**
 * Split the flat message list into user messages and assistant turns. Each turn
 * is everything the assistant produced until the next user message, divided
 * into:
 *   - steps:      reasoning, explanations, commands and outputs (collapsed)
 *   - answer:     the closing text reply, if the turn ended with one
 *   - actionable: a command awaiting confirmation (plus its explanation and
 *                 dry-run output), which must stay visible
 *
 * While `live`, the last turn is still being worked on: it is kept (or added,
 * empty) as a live turn, and none of its text is taken as the answer yet.
 */
function groupMessages(messages, live = false) {
  const groups = [];
  let turn = null;

  const newTurn = (prev, fallbackKey) => ({
    type: 'turn',
    // Keyed by the message it answers, so it stays mounted as rows arrive.
    key: prev?.type === 'user' ? `turn-${prev.message.id}` : fallbackKey,
    startedAt: prev?.message?.createdAt,
    rows: [],
  });

  for (const m of messages) {
    if (m.role === 'USER') {
      groups.push({ type: 'user', message: m });
      turn = null;
      continue;
    }
    if (!turn) {
      turn = newTurn(groups[groups.length - 1], m.id);
      groups.push(turn);
    }
    turn.rows.push(m);
  }

  if (live && groups.at(-1)?.type !== 'turn') {
    groups.push(newTurn(groups.at(-1), 'turn-live'));
  }

  for (const g of groups) {
    if (g.type !== 'turn') continue;
    g.live = live && g === groups.at(-1);
    const rows = [...g.rows];
    let actionable = [];
    const pendingIdx = rows.findIndex((m) => m.status === 'PENDING_CONFIRMATION');
    if (pendingIdx !== -1) {
      const start = pendingIdx > 0 && rows[pendingIdx - 1].kind === 'TEXT' ? pendingIdx - 1 : pendingIdx;
      actionable = rows.splice(start);
    }
    const answer = !g.live && actionable.length === 0 && rows.at(-1)?.kind === 'TEXT' ? rows.pop() : null;
    g.steps = rows;
    g.answer = answer;
    g.actionable = actionable;
    g.endedAt = g.rows.at(-1)?.createdAt;
  }
  return groups;
}

function formatDuration(startedAt, endedAt) {
  if (!startedAt || !endedAt) return null;
  const seconds = Math.max(1, Math.round((new Date(endedAt) - new Date(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function ChevronIcon({ open }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      className={`h-4 w-4 transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <path
        fillRule="evenodd"
        d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.17 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function StepItem({ message }) {
  if (message.kind === 'REASONING') {
    return (
      <p className="whitespace-pre-wrap text-xs italic leading-relaxed text-gray-500 dark:text-gray-400">
        {message.content}
      </p>
    );
  }
  if (isRequest(message)) {
    return (
      <div className="flex flex-wrap items-center gap-y-1">
        <code className="break-all font-mono text-xs text-gray-800 dark:text-gray-100">$ {message.content}</code>
        <StatusBadge status={message.status} />
      </div>
    );
  }
  if (message.kind === 'COMMAND_RESULT') {
    return (
      <div>
        {message.status === 'DRY_RUN' && (
          <p className="mb-1 text-xs font-medium text-amber-700 dark:text-amber-300">Dry run</p>
        )}
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-gray-50 p-2 font-mono text-xs text-gray-700 dark:bg-gray-800/60 dark:text-gray-200">
          {message.content || '(no output)'}
        </pre>
      </div>
    );
  }
  return (
    <div className="text-sm text-gray-700 dark:text-gray-200">
      <MarkdownText>{message.content}</MarkdownText>
    </div>
  );
}

// What the live turn is doing right now, pushed over the live connection: the
// command being run, or a step such as "Signing in to AWS". The AI thinking
// needs no line of its own; the dropdown already says "Thinking".
function LiveStep({ status }) {
  if (!status || status.thinking) return null;
  if (status.command) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <code className="break-all font-mono text-xs text-gray-800 dark:text-gray-100">$ {status.command}</code>
        <span className="animate-pulse text-xs text-teal-600 dark:text-teal-400">Running…</span>
      </div>
    );
  }
  return <p className="animate-pulse text-xs text-gray-500 dark:text-gray-400">{status.text}…</p>;
}

// Shown in turn while a reply is being worked on, so a long turn visibly moves.
const THINKING_WORDS = [
  'Thinking',
  'Architecting',
  'Provisioning',
  'Orchestrating',
  'Scaling',
  'Load-balancing',
  'Containerising',
  'Deploying',
  'Autoscaling',
  'Clustering',
  'Replicating',
  'Sharding',
  'Caching',
  'Routing',
  'Peering',
  'Failing over',
  'Spinning up',
  'Terraforming',
];
const THINKING_WORD_MS = 6000;

function useThinkingWord(active) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setIndex((i) => (i + 1) % THINKING_WORDS.length), THINKING_WORD_MS);
    return () => clearInterval(timer);
  }, [active]);
  return THINKING_WORDS[index];
}

function ThinkingDropdown({ steps, startedAt, endedAt, live = false, liveStatus = null }) {
  // null until the Operator clicks it: a live turn starts open so each step
  // shows as it happens, and a finished one starts folded.
  const [toggled, setToggled] = useState(null);
  const thinkingWord = useThinkingWord(live);
  // Nothing to expand until the first step or live command arrives.
  const hasSteps = steps.length > 0 || (live && liveStatus != null && !liveStatus.thinking);
  const open = hasSteps && (toggled ?? live);
  const commandCount = steps.filter(isRequest).length;
  const duration = formatDuration(startedAt, endedAt);
  const commands = commandCount > 0 ? `ran ${commandCount} command${commandCount === 1 ? '' : 's'}` : null;
  const label = live ? (
    <>
      <span key={thinkingWord} className="thinking-word">
        {thinkingWord}…
      </span>
      {commands && ` · ${commands}`}
    </>
  ) : (
    [duration ? `Thought for ${duration}` : 'Thought', commands].filter(Boolean).join(' · ')
  );

  return (
    <div className="text-left" role={live ? 'status' : undefined}>
      <button
        type="button"
        onClick={() => setToggled(!open)}
        disabled={!hasSteps}
        aria-expanded={hasSteps ? open : undefined}
        className="flex items-center gap-2 rounded-md py-1 text-sm text-gray-500 hover:text-gray-800 disabled:cursor-default disabled:hover:text-gray-500 dark:text-gray-400 dark:hover:text-gray-100 dark:disabled:hover:text-gray-400"
      >
        {live && <LogoTracer className="h-5 w-7" />}
        <span className="flex items-center gap-1 [perspective:400px]">
          {label}
          {hasSteps && <ChevronIcon open={open} />}
        </span>
      </button>
      {open && (
        <div className="ml-1.5 mt-1 space-y-3 border-l-2 border-gray-200 pl-4 dark:border-gray-700">
          {steps.map((m) => (
            <StepItem key={m.id} message={m} />
          ))}
          {live && <LiveStep status={liveStatus} />}
        </div>
      )}
    </div>
  );
}

function AssistantTurn({ turn, onConfirm, onCancel, sending, liveStatus }) {
  return (
    <div className="space-y-2">
      {(turn.steps.length > 0 || turn.live) && (
        <ThinkingDropdown
          steps={turn.steps}
          startedAt={turn.startedAt}
          endedAt={turn.endedAt}
          live={turn.live}
          liveStatus={turn.live ? liveStatus : null}
        />
      )}
      {turn.answer && <TextBubble message={turn.answer} />}
      {turn.actionable.map((m) => (
        <MessageItem key={m.id} message={m} onConfirm={onConfirm} onCancel={onCancel} sending={sending} />
      ))}
    </div>
  );
}

// Scrolls the nearest scrolling ancestor (the chat section) fully down. Plain
// scrollIntoView would leave the newest message under the sticky input box.
function scrollAncestorToBottom(el) {
  let node = el?.parentElement;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      node.scrollTop = node.scrollHeight;
      return;
    }
    node = node.parentElement;
  }
}

/**
 * The rendered conversation: user bubbles, Thought dropdowns, answers and
 * command cards. Without onConfirm/onCancel it is read-only (chat history).
 *
 * By default it sits directly on the page, and the page's own scroll area keeps
 * the newest message in view. `boxed` renders it as a bordered card with its
 * own scrollbar, for previews such as the Chat History list.
 */
export function ChatTranscript({ messages, onConfirm, onCancel, sending = false, liveStatus = null, boxed = false }) {
  const groups = groupMessages(messages, sending);
  const boxRef = useRef(null);
  const endRef = useRef(null);

  // Keep the newest message (or the thinking indicator) in view.
  useEffect(() => {
    if (boxed) {
      const el = boxRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    } else {
      scrollAncestorToBottom(endRef.current);
    }
  }, [messages, sending, liveStatus, boxed]);

  return (
    <div
      ref={boxRef}
      className={
        boxed
          ? 'max-h-[32rem] space-y-3 overflow-y-auto rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900'
          : 'space-y-4'
      }
    >
      {groups.map((g) =>
        g.type === 'user' ? (
          <TextBubble key={g.message.id} message={g.message} />
        ) : (
          <AssistantTurn
            key={g.key}
            turn={g}
            onConfirm={onConfirm}
            onCancel={onCancel}
            sending={sending}
            liveStatus={liveStatus}
          />
        ),
      )}
      <div ref={endRef} />
    </div>
  );
}

export function ChatPanel({ messages, onSend, suggestedPrompts, onConfirm, onCancel, sending, liveStatus }) {
  const [draft, setDraft] = useState('');
  const started = messages.length > 0;

  function handleSend(text) {
    const value = (text ?? draft).trim();
    if (!value || sending) return;
    onSend(value);
    setDraft('');
  }

  return (
    // Fills the chat section so the input box sits at the bottom even when
    // the conversation is short (and sticks there once it scrolls).
    <div className="flex flex-1 flex-col">
      {started && (
        <ChatTranscript messages={messages} onConfirm={onConfirm} onCancel={onCancel} sending={sending} liveStatus={liveStatus} />
      )}

      {/* Pinned to the bottom of the scrolling chat section. */}
      <div className="sticky bottom-0 mt-auto bg-gray-50 pb-6 pt-4 dark:bg-gray-950">
        <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white p-2 shadow-sm dark:border-gray-700 dark:bg-gray-900">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            disabled={sending}
            placeholder={
              started ? 'Reply…' : 'Describe what you want to do or select a quick action below'
            }
            className="flex-1 border-none bg-transparent px-2 py-2 text-sm focus:outline-none disabled:opacity-60 dark:text-gray-100"
          />
          <button
            type="button"
            onClick={() => handleSend()}
            disabled={sending}
            className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
          >
            Send
          </button>
        </div>

        {!started && suggestedPrompts && suggestedPrompts.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {suggestedPrompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => handleSend(prompt)}
                disabled={sending}
                className="rounded-full border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-60 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
              >
                {prompt}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
