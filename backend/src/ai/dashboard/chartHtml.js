// The page that draws a graph. The model writes it once, when the graph is
// authored; the browser shows it in an isolated frame and hands it the rows.
//
// Nothing here makes the page safe to run: that is the frame's job (no access
// to the app, no network). This only catches pages that could never work.

const { z } = require('zod');
const { MAX_CHART_HTML_CHARS } = require('../../constants/dashboard');

// XML namespaces are written as URLs but are never fetched.
const NAMESPACE = /https?:\/\/www\.w3\.org\/[\w/.-]*/gi;
// A scheme, or a scheme-less "//host.tld" (but not a "//comment").
const EXTERNAL = /(?:https?|wss?):\/\/|\/\/[a-z0-9-]+\.[a-z]/i;

/** Why this page cannot be used, or null when it can. */
function chartHtmlProblem(html) {
  if (!/<script[\s>]/i.test(html)) {
    return 'chartHtml has no <script>: it must read DATA and draw the graph';
  }
  if (!/\bDATA\b/.test(html)) {
    return 'chartHtml never reads DATA, so it cannot show the rows';
  }
  if (EXTERNAL.test(html.replace(NAMESPACE, ''))) {
    return 'chartHtml refers to an external address. The frame has no network: no libraries, fonts, images or links, only plain HTML, CSS and JavaScript';
  }
  return null;
}

const chartHtmlSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_CHART_HTML_CHARS)
  .superRefine((html, ctx) => {
    const problem = chartHtmlProblem(html);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

module.exports = { chartHtmlSchema, chartHtmlProblem };
