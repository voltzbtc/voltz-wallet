import React from 'react'
import { readFileSync } from 'fs'
import { join } from 'path'
import ReactTestRenderer from 'react-test-renderer'
import { StyleSheet, View } from 'react-native'
import { CaptureNotice } from '../src/components/CaptureNotice'
import { PendingDepositRows } from '../src/components/PendingDepositRows'
import { PasskeyRestore } from '../src/components/PasskeyAction'
import type { SparkDeposit } from '../src/wallet/spark'
import type { ScreenCapture } from '../src/hooks/useScreenCapture'
import { space } from '../src/theme'

jest.mock('../src/hooks/usePasskeyOffer', () => ({ usePasskeyOffer: () => 'checking' }))

// A component that draws nothing in some states cannot own the space around it: a margin inside it
// vanishes with it in one state and stays in another, and a caller with a gap stacks the two. The
// caller places it, through `style`, and the component's own outermost box carries no margin.
const MARGIN = /^margin/

function outerMargins(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  const outer = tree.root.findAll(node => typeof node.type === 'string')[0]
  return Object.keys(StyleSheet.flatten(outer.props.style) ?? {}).filter(key => MARGIN.test(key))
}

function render(element: React.JSX.Element): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(element)
  })
  return tree
}

const deposit: SparkDeposit = { txid: 'tx', vout: 0, amountSat: 42_000, claimable: false, stage: 'arriving', refundable: false }

describe('a component that can draw nothing leaves its outer margin to the caller', () => {
  test.each<[string, ScreenCapture]>([
    ['the hidden words card', { phase: 'captured', screenshot: false }],
    ['the screenshot notice', { phase: 'shown', screenshot: true }],
  ])('CaptureNotice, %s', (_, capture) => {
    const tree = render(<CaptureNotice capture={capture} />)
    expect(outerMargins(tree)).toEqual([])

    const placed = render(<CaptureNotice capture={capture} style={{ marginBottom: space.lg }} />)
    expect(outerMargins(placed)).toEqual(['marginBottom'])
  })

  test('PendingDepositRows', () => {
    const tree = render(
      <PendingDepositRows
        deposits={[deposit]}
        onRefund={() => undefined}
        onOpen={() => undefined}
      />,
    )
    expect(outerMargins(tree)).toEqual([])

    const placed = render(
      <PendingDepositRows
        deposits={[deposit]}
        onRefund={() => undefined}
        onOpen={() => undefined}
        style={{ marginBottom: space.lg }}
      />,
    )
    expect(outerMargins(placed)).toEqual(['marginBottom'])
  })

  test('PasskeyRestore', () => {
    const tree = render(<PasskeyRestore onWallet={async () => undefined} />)
    expect(tree.root.findAllByType(View).length).toBeGreaterThan(0)
    expect(outerMargins(tree)).toEqual([])
  })
})

// Each phrase screen keeps the notice's distance to what follows it, now that it is theirs.
test('every phrase screen places the capture notice', () => {
  const callers = ['ImportScreen', 'BackupScreen', 'RecoveryPhraseScreen', 'VerifyBackupScreen']
  for (const screen of callers) {
    const source = readFileSync(join(__dirname, `../src/screens/${screen}.tsx`), 'utf8')
    expect(source).toMatch(/<CaptureNotice capture=\{capture\} style=\{styles\.\w+\} \/>/)
  }
})

// PasskeyRestore leaves its margin to the caller, and both restore steps draw it right above the
// words' length control, so each places it or the button sits flush on that control.
test('every restore step places the passkey button', () => {
  for (const caller of ['App.tsx', 'src/screens/AddWalletScreen.tsx']) {
    const source = readFileSync(join(__dirname, '..', caller), 'utf8')
    expect(source).toMatch(/<PasskeyRestore [^>]*style=\{styles\.\w+\}[^>]*\/>/)
  }
})
