import { ChartIcon, RobotIcon } from '../../../components/icons';

const VIEWS = [
  { key: 'chat', label: 'Chat', Icon: RobotIcon },
  { key: 'dashboard', label: 'Dashboard', Icon: ChartIcon },
];

/** Switches the main area between the mode's chat and its dashboard of graphs. */
export function ViewToggle({ view, onChange }) {
  return (
    <div
      role="group"
      aria-label="View"
      className="flex gap-0.5 rounded-lg border border-gray-200 bg-white p-0.5 shadow-sm dark:border-gray-700 dark:bg-gray-900"
    >
      {VIEWS.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          aria-pressed={view === key}
          aria-label={label}
          title={label}
          className={`rounded-md p-1.5 transition ${
            view === key
              ? 'bg-teal-600 text-white'
              : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
          }`}
        >
          <Icon className="size-5" />
        </button>
      ))}
    </div>
  );
}
