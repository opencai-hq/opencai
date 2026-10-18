// Labels and text formatting for dashboard graphs.

export const PERIOD_LABELS = {
  LAST_7_DAYS: 'Last 7 days',
  LAST_30_DAYS: 'Last 30 days',
  LAST_90_DAYS: 'Last 90 days',
  MONTH_TO_DATE: 'Month to date',
  LAST_6_MONTHS: 'Last 6 months',
  LAST_12_MONTHS: 'Last 12 months',
};

/**
 * A number as text with its unit. `compact` shortens 12,400 to 12.4K.
 */
export function formatValue(value, unit, { compact = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '–';

  const options = compact
    ? { notation: 'compact', maximumFractionDigits: 1 }
    : { maximumFractionDigits: Math.abs(value) < 100 ? 2 : 0 };

  if (unit && /^[A-Z]{3}$/.test(unit)) {
    try {
      return new Intl.NumberFormat(undefined, {
        ...options,
        style: 'currency',
        currency: unit,
      }).format(value);
    } catch {
      // Three capitals that are not a currency code: fall through to a suffix.
    }
  }
  const text = new Intl.NumberFormat(undefined, options).format(value);
  if (!unit) return text;
  return unit === '%' ? `${text}%` : `${text} ${unit}`;
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
export function timeAgo(date, now = Date.now()) {
  const minutes = Math.floor((now - new Date(date).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
