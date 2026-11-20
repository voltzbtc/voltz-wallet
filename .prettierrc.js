module.exports = {
  arrowParens: 'avoid',
  // The house style omits semicolons, and Prettier defaults `semi` to true, so leaving it unset
  // would rewrite the house style as wrong. CI does not run Prettier (its checks are typecheck,
  // eslint and jest), so nothing fails when this file and the code disagree.
  semi: false,
  // The house closes a JSX tag on the same line as its last prop, where Prettier defaults to a line
  // of its own.
  bracketSameLine: true,
  // The codebase wraps at 100 columns rather than Prettier's default of 80.
  printWidth: 100,
  singleQuote: true,
  trailingComma: 'all',
};
