import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { View, type StyleProp, type ViewStyle } from 'react-native'
import {
  checkPasskey,
  passkeyEntryFor,
  type PasskeyCheck,
  type PasskeyEntry,
} from '../wallet/passkey'
import { Card } from './Card'
import { GradientButton } from './GradientButton'
import { Txt } from './Txt'

const CHECK_KEYS: Record<PasskeyCheck, string> = {
  same: 'passkey.testSame',
  other: 'passkey.testOther',
  unknown: 'passkey.testUnknown',
}

// A wallet's passkey in its settings. Only what was measured is said: that it syncs comes from the
// authenticator at registration and is given as what the device says, and that it opens this wallet
// comes only from a test on this screen, kept no longer than the screen, since the passkey can be
// deleted from the person's account the moment after.
// The style is the card's place on its screen, drawn only with the card, so a wallet without a passkey
// leaves no gap where one would go.
export function PasskeyCard({
  walletId,
  style,
}: {
  walletId: string
  style?: StyleProp<ViewStyle>
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [entry, setEntry] = useState<PasskeyEntry | null>(null)
  const [check, setCheck] = useState<PasskeyCheck | 'running' | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    passkeyEntryFor(walletId)
      .catch(() => null)
      .then(found => {
        if (alive.current) {
          setEntry(found)
        }
      })
    return () => {
      alive.current = false
    }
  }, [walletId])

  if (!entry) {
    return null
  }

  async function test(known: PasskeyEntry) {
    setCheck('running')
    const result = await checkPasskey(known)
    if (alive.current) {
      setCheck(result)
    }
  }

  return (
    <View style={style}>
      <Card gap="sm">
        <Txt role="bodyBold">{t('passkey.cardTitle')}</Txt>
        {entry.backupEligible === true && <Txt tone="muted">{t('passkey.synced')}</Txt>}
        {check !== null && check !== 'running' && (
          <Txt tone={check === 'other' ? 'danger' : 'muted'} testID="passkey-check">
            {t(CHECK_KEYS[check])}
          </Txt>
        )}
        <GradientButton
          label={t('passkey.test')}
          variant="secondary"
          loading={check === 'running'}
          onPress={() => test(entry)}
        />
      </Card>
    </View>
  )
}
