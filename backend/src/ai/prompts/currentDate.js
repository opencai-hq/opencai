// Models only know the date their training ended, so without this they guess a
// year and ask cloud APIs about the wrong days. Appended to the live system
// prompt on every request, never stored, so a long chat never carries a stale
// date. UTC, matching the dates dashboard periods resolve to.

/** Today's date for the model, as a prompt rule. */
function currentDateRule(now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  return [
    `Today's date is ${today} (UTC).`,
    'Work out relative periods such as "last 3 days" or "this month" from it, and never assume a different year.',
  ].join('\n');
}

module.exports = { currentDateRule };
