/**
 * The commands behind a chained graph, in order: step 1 runs once, and every
 * later step runs once for each row of the step before it.
 */
export function CommandSteps({ steps }) {
  return (
    <ol className="space-y-2">
      {steps.map((step, i) => (
        <li key={i}>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {i === 0 ? 'Step 1 · runs once' : `Step ${i + 1} · runs for each row of step ${i}`}
          </p>
          <pre className="mt-0.5 whitespace-pre-wrap break-all font-mono text-xs text-gray-700 dark:text-gray-300">
            {step.command}
          </pre>
        </li>
      ))}
    </ol>
  );
}

/** A chain as plain text, one command per line, for the clipboard. */
export const stepsText = (steps) => steps.map((step) => step.command).join('\n');
