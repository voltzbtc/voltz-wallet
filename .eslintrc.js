// Files another change still has to free of outlines. Each is listed once and leaves when it is fixed,
// so the list only shrinks and ends empty; __tests__/designGates.test.ts fails on a file that stays
// after it is clean, and `pendingOutlineFiles` in the design ratchet holds the count.
const { outlineFiles } = require('./scripts/design-pending.json')

// Corner radius must come from a radius.* token (theme.ts), never a raw number, so the Apple HIG
// hierarchy holds. Computed radii (size / 2) stay allowed. See docs/design-system.md.
const RAW_RADIUS = {
  // Every corner property, not just the shorthand, so `borderTopLeftRadius: 8` and its three siblings
  // are held to the same rule. `shadowRadius` is deliberately outside the pattern: it is a blur
  // distance, not a corner, and has no radius.* token to point at.
  selector: 'Property[key.name=/^border([A-Za-z]+)?Radius$/][value.type="Literal"]',
  message:
    'Use a radius.* token from theme.ts instead of a hardcoded corner radius (see docs/design-system.md).',
}

// No component has an outline in any state. A surface separates by its fill and the space around it,
// and the divider between two rows comes from dividerBottom or dividerTop in theme.ts, the one file
// this rule leaves out. A key written any other way draws the same line, so a quoted key and a computed
// one are read too, and a template with a name inside it by its two ends. `boxShadow` is here because
// its spread draws a ring around a surface, which is an outline under another name.
const OUTLINE_SIDE = 'Top|Bottom|Left|Right|Start|End|Horizontal|Vertical|Block|BlockStart|BlockEnd|Inline|InlineStart|InlineEnd'
const OUTLINE_PROPERTY = `/^(border(${OUTLINE_SIDE})?(Width|Color|Style)|outline(Width|Color|Style)|boxShadow)$/`
const OUTLINE_MESSAGE =
  'No outlines: a surface separates by fill and space, and a row divider is dividerBottom or dividerTop from theme.ts (see docs/design-system.md).'
const COMPUTED_KEY = 'Property[computed=true] > TemplateLiteral.key'
const OUTLINE = [
  { selector: `Property[key.name=${OUTLINE_PROPERTY}]`, message: OUTLINE_MESSAGE },
  { selector: `Property[key.value=${OUTLINE_PROPERTY}]`, message: OUTLINE_MESSAGE },
  { selector: `${COMPUTED_KEY} > TemplateElement[value.raw=${OUTLINE_PROPERTY}]`, message: OUTLINE_MESSAGE },
  {
    selector: `${COMPUTED_KEY}:has(> TemplateElement[value.raw=/^(border|outline)/]) > TemplateElement[value.raw=/^(Width|Color|Style)$/]`,
    message: OUTLINE_MESSAGE,
  },
]

// A colour is a token in theme.ts, whichever way it was about to be written. The first selector is
// any string that is a colour, in any position, and the rest are a colour's name where a colour goes.
const COLOUR_MESSAGE = 'Use a colour from theme.ts, never a raw one (see docs/design-system.md).'
const COLOUR_PROP = '/^(color|fill|stroke|stopColor|tintColor|thumbColor|placeholderTextColor|selectionColor|cursorColor)$/'
const NOT_A_COLOUR = ':not([value="none"]):not([value="transparent"]):not([value=/^url\\(/])'
// A colour a few steps down from where it goes is as raw: inside a JSX expression, a branch of a
// ternary, either side of `&&`, `||` or `??`, or an element of an array (a gradient's stops), and those
// nested in one another up to three deep, written as a string or as a template with nothing in it.
// The path has to run through those alone, so a string handed
// to a function on the way (`tone(warn ? 'warning' : 'muted')`) and the text a condition compares
// (`mode === 'dark'`) are not taken for a colour, and the string has to have something in it, so an
// empty one meaning no colour passes. A colour kept in a variable first still passes, since telling it
// from any other string needs the places the variable is used. Each step is a `>`: a space would ask
// for a node inside the string, which a string never has, and the rule would never fire.
// Any string in such a place is refused, a token's name included, so a prop that takes a colour
// token by name (`color={on ? 'accent' : 'muted'}`) is named for what it is, like `tone`, or takes
// the token's value.
const COLOUR_KEY_NESTED = '/[cC]olors?$/'
const COLOUR_ATTR_NESTED =
  '/^(colors|color|fill|stroke|stopColor|tintColor|thumbColor|placeholderTextColor|selectionColor|cursorColor)$/'
const COLOUR_PLACE = `:matches(Property[key.name=${COLOUR_KEY_NESTED}], JSXAttribute[name.name=${COLOUR_ATTR_NESTED}] > JSXExpressionContainer)`
const COLOUR_STEP = ':matches(ConditionalExpression, LogicalExpression, ArrayExpression)'
const COLOUR_POSITION = ':matches(.expression, .consequent, .alternate, .left, .right, .elements)'
const NOT_A_COLOUR_TEMPLATE = ':not([value.raw="none"]):not([value.raw="transparent"]):not([value.raw=/^url\\(/])'
const COLOUR_SLOTS = [
  `Literal${COLOUR_POSITION}[value=/./]${NOT_A_COLOUR}`,
  `TemplateLiteral${COLOUR_POSITION}[expressions.length=0] > TemplateElement[value.raw=/./]${NOT_A_COLOUR_TEMPLATE}`,
]
const NESTED_COLOUR = [0, 1, 2, 3]
  .flatMap(steps => COLOUR_SLOTS.map(slot => [COLOUR_PLACE, ...Array(steps).fill(COLOUR_STEP), slot].join(' > ')))
  .join(', ')
const RAW_COLOUR = [
  { selector: 'Literal[value=/^(#[0-9a-fA-F]{3,8}|(rgb|hsl)a?\\(.*)$/]', message: COLOUR_MESSAGE },
  { selector: 'TemplateElement[value.raw=/^(#[0-9a-fA-F]{3}|(rgb|hsl)a?\\()/]', message: COLOUR_MESSAGE },
  {
    selector: `Property[key.name=/[cC]olor$/] > Literal.value${NOT_A_COLOUR}`,
    message: COLOUR_MESSAGE,
  },
  { selector: `JSXAttribute[name.name=${COLOUR_PROP}] > Literal${NOT_A_COLOUR}`, message: COLOUR_MESSAGE },
  { selector: NESTED_COLOUR, message: COLOUR_MESSAGE },
]

module.exports = {
  root: true,
  extends: '@react-native',
  // Build output is generated and untracked. A Gradle dependency verification report ships its own
  // scripts under android/build/reports, which would otherwise fail the lint of the whole tree.
  ignorePatterns: ['build/'],
  overrides: [
    {
      // The React Native preset configures a parser for the app code, which is TypeScript and JSX.
      // The Node scripts beside it are plain modules and need their own, or every file using modern
      // syntax reports a parsing error that reads as a problem in the file.
      files: ['scripts/*.mjs'],
      parser: 'espree',
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    {
      // The suite finds what a screen drew by React Native's own Text, which the app's Text renders.
      files: ['__tests__/**', '__mocks__/**', 'jest.*.js'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: 'react-native',
                importNames: ['ActivityIndicator'],
                message:
                  'Use a skeleton (src/components/Skeleton.tsx) for loading state, not ActivityIndicator (see docs/design-system.md).',
              },
            ],
          },
        ],
      },
    },
    {
      // The app's code, and not its tests, which plant these values on purpose. theme.ts is where the
      // colours and the row divider are defined.
      files: ['src/**/*.ts', 'src/**/*.tsx', 'App.tsx'],
      excludedFiles: ['src/theme.ts'],
      rules: { 'no-restricted-syntax': ['error', RAW_RADIUS, ...OUTLINE, ...RAW_COLOUR] },
    },
    // ESLint refuses an override with no files, which is where this list ends.
    ...(outlineFiles.length > 0
      ? [{ files: outlineFiles, rules: { 'no-restricted-syntax': ['error', RAW_RADIUS, ...RAW_COLOUR] } }]
      : []),
  ],
  rules: {
    'no-restricted-syntax': ['error', RAW_RADIUS],
    // Pieces of React Native the app replaces with its own. One entry for the package, since ESLint
    // keeps only the last of several entries naming the same one.
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: 'react-native',
            importNames: ['ActivityIndicator', 'Alert', 'Text', 'TextInput', 'Switch'],
            message:
              "Use the app's own: Skeleton for a loading state, Text and TextInput from src/components/Text, Toggle for a switch, ConfirmSheet or ConfirmBody for a question, ErrorBox for a failure (see docs/design-system.md).",
          },
        ],
      },
    ],
  },
};
