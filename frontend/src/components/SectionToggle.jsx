/** A row of buttons that switches between a page's sections; one is always selected. */
export function SectionToggle({ sections, value, onChange, label }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="mt-6 inline-flex gap-1 rounded-lg border border-gray-200 bg-white p-1 shadow-sm dark:border-gray-700 dark:bg-gray-900"
    >
      {sections.map(({ key, label: sectionLabel }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          aria-pressed={value === key}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
            value === key
              ? 'bg-teal-600 text-white'
              : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
          }`}
        >
          {sectionLabel}
        </button>
      ))}
    </div>
  );
}
