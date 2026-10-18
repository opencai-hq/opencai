// Builds the page shown inside a dashboard graph's frame.
//
// The drawing code is written by the AI, so it is treated as untrusted: the
// frame it runs in is sandboxed (it cannot reach this app, its storage or the
// sign-in token), and the policy below gives it no network. It gets the
// graph's rows and the colours to use, and nothing else.

// What the AI's code is told to draw with. Light and dark are separate
// choices, not one inverted.
const THEMES = {
  light: {
    dark: false,
    text: '#111827',
    muted: '#6b7280',
    grid: '#e5e7eb',
    surface: '#ffffff',
    other: '#9ca3af',
    palette: [
      '#2a78d6',
      '#eb6834',
      '#1baf7a',
      '#eda100',
      '#e87ba4',
      '#008300',
      '#4a3aa7',
      '#e34948',
    ],
  },
  dark: {
    dark: true,
    text: '#f3f4f6',
    muted: '#9ca3af',
    grid: '#1f2937',
    surface: '#111827',
    other: '#6b7280',
    palette: [
      '#3987e5',
      '#d95926',
      '#199e70',
      '#c98500',
      '#d55181',
      '#008300',
      '#9085e9',
      '#e66767',
    ],
  },
};

export const chartTheme = (dark) => (dark ? THEMES.dark : THEMES.light);

// No network of any kind: only the page's own inline code and styles.
const POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";

export const CHART_MESSAGE_SOURCE = 'opencai-chart';

/** JSON that is safe to place inside a <script> element. */
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * The whole document for one graph's frame: the globals the drawing code reads
 * (DATA, THEME, UNIT), a reporter that tells this app when the code fails, and
 * then the AI-written page itself.
 */
export function buildChartDocument({ html, result, unit, theme }) {
  const payload = scriptJson({
    data: { rows: result.rows, columns: result.columns },
    unit: unit ?? '',
    theme,
    source: CHART_MESSAGE_SOURCE,
  });
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${POLICY}">
<style>
html, body { margin: 0; height: 100%; overflow: hidden; }
body { background: ${theme.surface}; color: ${theme.text}; font: 12px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; }
</style>
<script>
(function () {
  var p = ${payload};
  window.DATA = p.data;
  window.UNIT = p.unit;
  window.THEME = p.theme;
  function report(reason) {
    var text = reason && reason.message ? reason.message : String(reason);
    parent.postMessage({ source: p.source, error: text.slice(0, 300) }, '*');
  }
  window.addEventListener('error', function (event) { report(event.message || 'error'); });
  window.addEventListener('unhandledrejection', function (event) { report(event.reason); });
})();
</script>
</head>
<body>
${html}
</body>
</html>`;
}
