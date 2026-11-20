import React, { useEffect, useRef, useState } from 'react'
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { useTranslation } from 'react-i18next'
import { usePasskeyOffer } from '../hooks/usePasskeyOffer'
import {
  markPasskeyUnavailable,
  passkeyAttempt,
  passkeyFailureKind,
  type PasskeyFailureKind,
  type PasskeyMode,
  type PasskeyWallet,
} from '../wallet/passkey'
import { font, radius, space, touch } from '../theme'
import { ErrorBox } from './ErrorBox'
import { GradientButton } from './GradientButton'
import { Skeleton } from './Skeleton'
import { Touch } from './Touch'
import { Txt } from './Txt'

const FAILURE_KEYS: Record<PasskeyFailureKind, string> = {
  refused: 'passkey.refused',
  noCredential: 'passkey.noCredential',
  unavailable: 'passkey.unavailable',
  failed: 'passkey.failed',
}

type ActionProps = {
  mode: PasskeyMode
  label: string
  variant?: 'primary' | 'secondary'
  // Stores the wallet. The words stop here, in this argument, so no state of a screen holds them. A
  // rejection is the write failing, and the next tap derives them again.
  onWallet: (wallet: PasskeyWallet) => Promise<void>
  // While a ceremony runs, so the screen can hold its other ways out.
  onBusy?: (busy: boolean) => void
  // The device turned out not to be able to do this.
  onGone: () => void
}

// One tap, one ceremony. A sheet the person closed is an answer, so nothing repeats until the next tap,
// and an answer that lands after the screen left is dropped, which is safe because the same tap
// derives the same words.
function PasskeyAction({ mode, label, variant, onWallet, onBusy, onGone }: ActionProps): React.JSX.Element {
  const { t } = useTranslation()
  const turn = useRef(0)
  const running = useRef(false)
  const reportBusy = useRef(onBusy)
  reportBusy.current = onBusy
  const [phase, setPhase] = useState<'idle' | 'ceremony' | 'opening'>('idle')
  const [failure, setFailure] = useState<PasskeyFailureKind | null>(null)
  // iOS answers a closed sheet and a sign-in that found no passkey with one code, which the package
  // splits by a 300 ms clock a cold first tap can pass with no sheet shown. So a refused connect on iOS
  // claims nothing about the person and offers both ways on, held through the ceremony either starts so
  // neither button moves. Android names a missing credential, so a refusal there is the person's.
  const [asking, setAsking] = useState(false)
  const asks = mode === 'connect' && Platform.OS === 'ios'

  // A write that lands moves the screen on with the ceremony still marked as running, and the app stays
  // mounted, so the hold on the other ways out has to end with this button.
  useEffect(
    () => () => {
      turn.current += 1
      if (running.current) {
        reportBusy.current?.(false)
      }
    },
    [],
  )

  // Both buttons share the one guard, so neither starts a ceremony while the other's runs.
  async function run(ceremony: PasskeyMode) {
    if (running.current) {
      return
    }
    running.current = true
    turn.current += 1
    const mine = turn.current
    setFailure(null)
    setPhase('ceremony')
    onBusy?.(true)
    try {
      const wallet = await passkeyAttempt(ceremony)()
      if (mine !== turn.current) {
        return
      }
      setPhase('opening')
      await onWallet(wallet)
    } catch (err) {
      if (mine !== turn.current) {
        return
      }
      const kind = passkeyFailureKind(err)
      if (kind === 'unavailable') {
        markPasskeyUnavailable()
        onGone()
      }
      setAsking(asks && kind === 'refused')
      setFailure(kind)
    } finally {
      running.current = false
      if (mine === turn.current) {
        setPhase('idle')
        onBusy?.(false)
      }
    }
  }

  const busy = phase !== 'idle'
  const message = failure ? t(asking ? 'passkey.didNotOpen' : FAILURE_KEYS[failure]) : null

  return (
    <View style={styles.action}>
      <ErrorBox message={message} />
      <GradientButton
        label={asking || (failure && failure !== 'noCredential') ? t('common.retry') : label}
        onPress={() => run(mode)}
        variant={variant}
        loading={busy}
      />
      {/* An explicit register, the one way besides the SDK's own fall-through that Welcome makes a
          passkey on iOS. passkeyAttempt still pins it to a credential no wallet has claimed. */}
      {asking && (
        <GradientButton
          label={t('passkey.createNew')}
          onPress={() => run('register')}
          variant="secondary"
          disabled={busy}
        />
      )}
      {/* The line's place is kept, so naming a step of the ceremony moves nothing under the finger. */}
      <View style={styles.phase}>
        {busy && (
          <Txt role="caption" tone="muted" style={styles.line}>
            {t(phase === 'ceremony' ? 'passkey.phaseChecking' : 'passkey.phaseOpening')}
          </Txt>
        )}
      </View>
    </View>
  )
}

type ChoiceProps = {
  mode: 'connect' | 'register'
  label: string
  // The button the screen has without a passkey, and the link to the same thing beside one.
  wordsButton: string
  wordsLink: string
  onWords: () => void
  onWallet: (wallet: PasskeyWallet) => Promise<void>
  busy: boolean
  onBusy: (busy: boolean) => void
  actionStyle: StyleProp<ViewStyle>
  linkStyle: StyleProp<ViewStyle>
}

// Where a screen offers to make a wallet. The words never wait on the availability check: only the
// button's place shows a skeleton, and without a passkey the screen draws the button it always had.
export function PasskeyChoice({
  mode,
  label,
  wordsButton,
  wordsLink,
  onWords,
  onWallet,
  busy,
  onBusy,
  actionStyle,
  linkStyle,
}: ChoiceProps): React.JSX.Element {
  const { t } = useTranslation()
  const offer = usePasskeyOffer()
  const [gone, setGone] = useState(false)

  if (offer === 'absent' || gone) {
    return (
      <View style={[actionStyle, styles.action]}>
        {gone && (
          <Txt role="caption" tone="muted" style={styles.line}>
            {t('passkey.unavailable')}
          </Txt>
        )}
        <GradientButton label={wordsButton} onPress={onWords} disabled={busy} />
      </View>
    )
  }

  return (
    <>
      <View style={[actionStyle, styles.action]}>
        {offer === 'checking' ? (
          <Skeleton height={touch.action} borderRadius={radius.md} />
        ) : (
          <>
            <PasskeyAction
              mode={mode}
              label={label}
              onWallet={onWallet}
              onBusy={onBusy}
              onGone={() => setGone(true)}
            />
            <Txt role="caption" tone="muted" style={styles.line}>
              {t('passkey.explain')}
            </Txt>
          </>
        )}
      </View>
      <Touch onPress={onWords} disabled={busy} feedback="link" style={linkStyle}>
        <Txt role="bodyStrong" tone="muted">
          {wordsLink}
        </Txt>
      </Touch>
    </>
  )
}

type RestoreProps = {
  onWallet: (wallet: PasskeyWallet) => Promise<void>
  onBusy?: (busy: boolean) => void
  // The space around it, which is the caller's, since it draws nothing once the offer is gone.
  style?: StyleProp<ViewStyle>
}

// The restore step's way in without typing. It signs in and never registers, so a person with no
// passkey reads that and goes on to the words below.
export function PasskeyRestore({ onWallet, onBusy, style }: RestoreProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const offer = usePasskeyOffer()
  const [gone, setGone] = useState(false)

  if (offer === 'absent' || gone) {
    return null
  }
  return (
    <View style={style}>
      {offer === 'checking' ? (
        <Skeleton height={touch.action} borderRadius={radius.md} />
      ) : (
        <PasskeyAction
          mode="restore"
          label={t('passkey.restore')}
          variant="secondary"
          onWallet={onWallet}
          onBusy={onBusy}
          onGone={() => setGone(true)}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  action: {
    gap: space.sm,
  },
  line: {
    textAlign: 'center',
  },
  phase: {
    minHeight: font.leading.sm,
  },
})
