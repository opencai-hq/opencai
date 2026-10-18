// The only file that knows which JMESPath implementation is in use.
const { search: jmespathSearch } = require('@jmespath-community/jmespath');

/** Evaluate a JMESPath expression against parsed command output. */
function search(json, expression) {
  return jmespathSearch(json, expression);
}

module.exports = { search };
