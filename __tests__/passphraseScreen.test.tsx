import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text, TextInput } from 'react-native'
import i18n from '../src/i18n'
import { PassphraseScreen } from '../src/screens/PassphraseScreen'

function render(
  onDone: (passphrase: string) => void = () => undefined,
): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<PassphraseScreen onDone={onDone} />)
  })
  return tree
}

function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): void {
  const target = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(
      n =>
        n.props.accessibilityLabel === label ||
        n.findAllByType(Text).some(x => x.props.children === label),
    )
  if (!target) {
    throw new Error(`not found: ${label}`)
  }
  ReactTestRenderer.act(() => {
    target.props.onPress()
  })
}

const field = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findAllByType(TextInput)[0]

it('offers no field until a passphrase is asked for', () => {
  // The default path is no passphrase at all, and the screen should not look like one is required.
  expect(field(render())).toBeUndefined()
})

describe('once a passphrase is being entered', () => {
  const opened = (): ReactTestRenderer.ReactTestRenderer => {
    const tree = render()
    press(tree, i18n.t('passphrase.add'))
    return tree
  }

  it('masks what is typed', () => {
    // A passphrase is a secret typed in the open, and it stays masked until asked for. Unmasked,
    // the phrase sits on screen for anyone beside you.
    expect(field(opened())!.props.secureTextEntry).toBe(true)
  })

  it('reveals it when the eye is pressed, and masks it again', () => {
    // Revealing matters more here than anywhere else: a passphrase cannot be validated later, and a
    // typo silently opens a different, empty wallet, so a person has to be able to read it back.
    const tree = opened()
    press(tree, i18n.t('passphrase.reveal'))
    expect(field(tree)!.props.secureTextEntry).toBe(false)
    press(tree, i18n.t('passphrase.hide'))
    expect(field(tree)!.props.secureTextEntry).toBe(true)
  })

  it('never offers to autofill or remember it', () => {
    const input = field(opened())!.props
    expect(input.autoComplete).toBe('off')
    expect(input.autoCorrect).toBe(false)
    expect(input.spellCheck).toBe(false)
    expect(input.importantForAutofill).toBe('no')
    // iOS offers to save a secure field it takes for a password once the field leaves the screen;
    // typed as a one-time code it is not offered to Passwords on iOS 26.5, so there it stays out of
    // iCloud Keychain.
    expect(input.textContentType).toBe('oneTimeCode')
  })

  it('will not continue on an empty one, since that is the other path', () => {
    const done: string[] = []
    const tree = render(p => done.push(p))
    press(tree, i18n.t('passphrase.add'))
    press(tree, i18n.t('passphrase.continue'))
    expect(done).toEqual([])
  })

  it('forgets the phrase and the reveal when the choice is taken back', () => {
    const tree = opened()
    ReactTestRenderer.act(() => field(tree)!.props.onChangeText('hunter2'))
    press(tree, i18n.t('passphrase.reveal'))
    press(tree, i18n.t('passphrase.remove'))
    press(tree, i18n.t('passphrase.add'))
    expect(field(tree)!.props.value).toBe('')
    expect(field(tree)!.props.secureTextEntry).toBe(true)
  })
})

it('continues with an empty passphrase when none was asked for', () => {
  const done: string[] = []
  const tree = render(p => done.push(p))
  press(tree, i18n.t('passphrase.continue'))
  expect(done).toEqual([''])
})
