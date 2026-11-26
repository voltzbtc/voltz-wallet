## Translation review

<!-- Thank you for reviewing. Name the language and the file, and say what you changed and why when
it is not obvious from the diff. -->

Language:

File: `src/i18n/locales/<code>.json`

## What I checked

- [ ] The meaning matches the English source (`en-US.json`), with nothing added or left out
- [ ] The tone is direct and professional, and addresses the reader the way apps in this language do (docs/i18n.md has the notes for some languages, such as du in German)
- [ ] None of the words this language uses for banking, deposits, withdrawals, trading, exchanges or brokers appear, since the app holds no funds; `__tests__/locales.test.ts` lists them per language, and a word it misses is worth naming here
- [ ] Every plural form the language uses is present and reads right with its number (docs/i18n.md lists the forms per language, from `_zero` to `_other`)
- [ ] Placeholders such as `{{amount}}` and `{domain}` are kept exactly as they are, and brand and network names (Bitcoin, Lightning, Spark, USDB, DePix, Flashnet) are not translated
- [ ] No em dash, in any string
- [ ] Arabic, Hebrew and Urdu: the text reads right to left, and figures, addresses and Latin words inside a sentence sit where they should; other languages: does not apply
- [ ] `npx jest __tests__/locales.test.ts` passes

## Credit

<!-- A reviewer who agrees is named on the app's language screen, beside the language, and on the
site, under the name or handle given below. Nobody is named without consent in writing, and ticking
the box is that consent. Leave it unticked to stay unnamed. Credit comes out whenever you ask. -->

- [ ] I agree to be credited for this review, in the app and on the site
- Name or handle to show:
- Public profile to link, optional (a GitHub, X, Telegram or njump.me address):

## Contributor terms

- [ ] I agree to the contributor terms in CONTRIBUTING.md
