// What the model is told about the page that draws a graph, and one complete
// page to set the standard. Shared by the two places a page is written: when a
// graph is authored, and when an existing graph is redrawn.

// A full, working page: a smooth line over dates with a tooltip. It is shown to
// the model as the level of finish to match, not as a template for every graph.
const EXAMPLE_PAGE = String.raw`<div id="tip"></div>
<svg id="c" width="100%" height="100%"></svg>
<style>
  #c { display: block; cursor: crosshair; }
  #tip { position: absolute; display: none; pointer-events: none; padding: 6px 10px; border-radius: 8px; font-size: 12px; line-height: 1.35; white-space: nowrap; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22); }
  #tip b { display: block; font-size: 13px; }
</style>
<script>
  var NS = 'http://www.w3.org/2000/svg';
  var svg = document.getElementById('c'), tip = document.getElementById('tip');
  var rows = DATA.rows.filter(function (r) { return typeof r.amount === 'number'; });
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var color = THEME.palette[0], pinned = null, geo = null;
  tip.style.background = THEME.text;
  tip.style.color = THEME.surface;

  function day(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
    return m ? Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] : String(value);
  }
  function amount(v, short) {
    var a = Math.abs(v);
    var text = short && a >= 1000 ? (v / 1000).toFixed(1) + 'K' : v.toFixed(a < 100 && !short ? 2 : 0);
    return UNIT ? text + ' ' + UNIT : text;
  }
  function el(name, attrs, text) {
    var node = document.createElementNS(NS, name);
    for (var key in attrs) node.setAttribute(key, attrs[key]);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function draw() {
    var W = innerWidth, H = innerHeight, L = 58, R = 18, T = 16, B = H - 30;
    var max = Math.max.apply(null, rows.map(function (r) { return r.amount; }).concat([0])) || 1;
    var x = function (i) { return rows.length < 2 ? (L + W - R) / 2 : L + ((W - R - L) * i) / (rows.length - 1); };
    var y = function (v) { return B - ((B - T) * v) / max; };
    geo = { W: W, x: x, y: y, T: T, B: B };
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.textContent = '';

    var defs = el('defs', {}), fade = el('linearGradient', { id: 'fade', x1: 0, y1: 0, x2: 0, y2: 1 });
    fade.appendChild(el('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.28 }));
    fade.appendChild(el('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }));
    defs.appendChild(fade);
    svg.appendChild(defs);

    for (var k = 0; k <= 4; k++) {
      var gy = y((max * k) / 4);
      svg.appendChild(el('line', { x1: L, x2: W - R, y1: gy, y2: gy, stroke: THEME.grid }));
      svg.appendChild(el('text', { x: L - 8, y: gy + 4, 'text-anchor': 'end', 'font-size': 11, fill: THEME.muted }, amount((max * k) / 4, true)));
    }
    var step = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor((W - L - R) / 70))));
    rows.forEach(function (r, i) {
      if (i % step === 0) svg.appendChild(el('text', { x: x(i), y: H - 9, 'text-anchor': 'middle', 'font-size': 11, fill: THEME.muted }, day(r.date)));
    });
    if (rows.length === 0) return;

    // A smooth curve through every point: each bend follows the slope between its neighbours.
    var pts = rows.map(function (r, i) { return [x(i), y(r.amount)]; });
    var at = function (i) { return pts[Math.max(0, Math.min(pts.length - 1, i))]; };
    var d = 'M' + pts[0][0] + ' ' + pts[0][1];
    for (var i = 1; i < pts.length; i++) {
      var c1x = at(i - 1)[0] + (at(i)[0] - at(i - 2)[0]) / 6, c1y = at(i - 1)[1] + (at(i)[1] - at(i - 2)[1]) / 6;
      var c2x = at(i)[0] - (at(i + 1)[0] - at(i - 1)[0]) / 6, c2y = at(i)[1] - (at(i + 1)[1] - at(i - 1)[1]) / 6;
      d += ' C' + c1x + ' ' + c1y + ' ' + c2x + ' ' + c2y + ' ' + at(i)[0] + ' ' + at(i)[1];
    }
    svg.appendChild(el('path', { d: d + ' L' + x(rows.length - 1) + ' ' + B + ' L' + x(0) + ' ' + B + ' Z', fill: 'url(#fade)' }));
    svg.appendChild(el('path', { d: d, fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    svg.appendChild(el('line', { id: 'guide', y1: T, y2: B, stroke: THEME.muted, 'stroke-dasharray': '3 3', visibility: 'hidden' }));
    svg.appendChild(el('circle', { id: 'dot', r: 5, fill: color, stroke: THEME.surface, 'stroke-width': 2.5, visibility: 'hidden' }));
    if (pinned !== null) show(Math.min(pinned, rows.length - 1));
  }

  function nearest(clientX) {
    var best = 0;
    rows.forEach(function (r, i) { if (Math.abs(geo.x(i) - clientX) < Math.abs(geo.x(best) - clientX)) best = i; });
    return best;
  }
  function show(i) {
    var px = geo.x(i), py = geo.y(rows[i].amount);
    var guide = document.getElementById('guide'), dot = document.getElementById('dot');
    guide.setAttribute('x1', px); guide.setAttribute('x2', px); guide.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('visibility', 'visible');
    tip.textContent = '';
    var value = document.createElement('b');
    value.textContent = amount(rows[i].amount);
    tip.appendChild(value);
    tip.appendChild(document.createTextNode(String(rows[i].date)));
    tip.style.display = 'block';
    var left = px + 12;
    if (left + tip.offsetWidth > geo.W - 4) left = px - 12 - tip.offsetWidth;
    tip.style.left = left + 'px';
    tip.style.top = Math.max(4, py - tip.offsetHeight - 10) + 'px';
  }
  function hide() {
    tip.style.display = 'none';
    document.getElementById('guide').setAttribute('visibility', 'hidden');
    document.getElementById('dot').setAttribute('visibility', 'hidden');
  }

  svg.addEventListener('mousemove', function (e) { if (rows.length && pinned === null) show(nearest(e.clientX)); });
  svg.addEventListener('mouseleave', function () { if (rows.length && pinned === null) hide(); });
  // A click keeps the tooltip on that point; a second click on it lets go.
  svg.addEventListener('click', function (e) {
    if (!rows.length) return;
    var i = nearest(e.clientX);
    pinned = pinned === i ? null : i;
    show(i);
  });
  addEventListener('resize', draw);
  draw();
</script>`;

const PAGE_RULES = `The page (the html block): a small piece of HTML that draws the graph. It is put in the body of an empty page inside a frame 260 pixels tall and as wide as the graph's card (about 300 to 700 pixels). There are no ready-made charts: what you write is the whole graph, so make it one the Operator is glad to look at.

What the page is given, as globals that exist before your code runs:
  DATA = { rows: [...], columns: [...] } -- the rows chartSpec produced, with exactly the field names you chose. y values are numbers or null; everything else is text, a number, true/false or null.
  THEME = { dark, text, muted, grid, surface, palette, other } -- colours for the Operator's light or dark mode. palette is 8 colours for categories, in order; other is the colour for "Other". The page background is already THEME.surface.
  UNIT = the chartSpec unit, or "".

How to write it:
- Plain HTML, CSS and JavaScript: markup, then <style>, then one <script>. The frame has no network: no libraries, no fonts, images or links, no requests of any kind.
- Draw with inline SVG. Put the drawing in a draw() function that sizes the viewBox from innerWidth and innerHeight, and call it once and again on window resize, so the graph fills the frame at any width and pointer positions match what is drawn.
- Take every colour from THEME, so the graph works in light and dark mode: THEME.text for values, THEME.muted for labels, THEME.grid for grid lines, THEME.palette for the data. Text is 11 to 12 pixels.
- Never copy values from output you looked at. Read everything from DATA on every run: there may be more or fewer rows, one row, no rows, or null values, and the page must still draw.
- Build text with textContent, never innerHTML: the rows are data, not markup.

What a finished graph has:
- Values over time are a smooth curve, not straight segments: a 2.5 pixel line with rounded joins, and a soft fade of the same colour beneath it. Several categories over time are several such curves, or stacked bars when the total matters.
- A few light horizontal grid lines with short value labels (1.2K, not 1200), date labels shortened to "9 Oct" and thinned so they never overlap, no box around the plot.
- Bars have rounded tops and a small gap between them. Shares of a total are a ring (a donut) with the total in the middle. One number is a large figure with a short caption.
- A legend when there is more than one category: a coloured dot and the name, in THEME.muted text.
- It responds to the pointer. Moving over the graph marks the nearest point (or bar, or slice) and shows a tooltip with its full date or name and its exact value with the unit. Clicking keeps the tooltip on that point until it is clicked again. The tooltip stays inside the frame.
- Keep it under 7000 characters.

A complete page of this standard, for rows of {date, amount}. It is one line over dates; draw the graph that was asked for, with the same care:
\`\`\`html
${EXAMPLE_PAGE}
\`\`\``;

module.exports = { PAGE_RULES, EXAMPLE_PAGE };
