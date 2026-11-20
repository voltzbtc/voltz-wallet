// The residue docs/trust-model.md declares, pinned word for word so a later edit that softens or
// drops it fails here.
test('the trust model states what stays with the provider after a removal it cannot undo', () => {
  const fs = jest.requireActual<typeof import('fs')>('fs')
  const path = jest.requireActual<typeof import('path')>('path')
  const text = fs.readFileSync(path.join(__dirname, '..', 'docs', 'trust-model.md'), 'utf8').replace(/\s+/g, ' ')
  expect(text).toContain(
    "For a wallet removed while another one is connected, or after Forgot PIN erases everything, the provider registration cannot be taken down from the device, so the provider may keep posting that wallet's events to the gateway; once the forget has reached it, the gateway answers 410, keeps nothing of them and logs nothing of them.",
  )
})

// What the gateway keeps of a forget, and why the order of a forget and a registration does not matter,
// so a later edit cannot widen the mark or drop the reason quietly.
test('the trust model states what the forget mark holds and that the order no longer matters', () => {
  const fs = jest.requireActual<typeof import('fs')>('fs')
  const path = jest.requireActual<typeof import('path')>('path')
  const text = fs.readFileSync(path.join(__dirname, '..', 'docs', 'trust-model.md'), 'utf8').replace(/\s+/g, ' ')
  expect(text).toContain('so the order in which a forget and a registration reach it does not matter')
  expect(text).toContain('a mark made from the proof alone, with no key, no push token and no platform')
  expect(text).toContain('is answered 410 `forgotten`')
})
