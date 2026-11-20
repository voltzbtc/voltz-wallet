import React, { useCallback, useRef, useState } from 'react'
import { StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { ErrorBox } from '../components/ErrorBox'
import { GradientButton } from '../components/GradientButton'
import { Screen } from '../components/Screen'
import { Skeleton } from '../components/Skeleton'
import { exitHoldOnSend, type SendHold } from '../wallet/exitHold'
import { sparkConnectedWalletId } from '../wallet/spark'
import { font, space } from '../theme'
import { ReceiveSpark } from './ReceiveSpark'

// Spark is the only engine, so this forwards to ReceiveSpark once the wallet is free to receive.
//
// spark.ts refuses every receive of a wallet whose emergency exit is alive or unread, and this screen
// says so before a code is asked for: read on each focus, since the exit's screen opens over this one,
// and again at the press of Copy or Share. No code is drawn while a read is in flight, a refocus
// included, so one minted before the exit started never shows beside it. The connected wallet and the
// active one are both asked, as for Send.
export function ReceiveScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList, 'Receive'>>()
  const [hold, setHold] = useState<SendHold | null>(null)
  const newest = useRef<Promise<SendHold> | null>(null)

  const readHold = useCallback((): Promise<SendHold> => {
    const read = exitHoldOnSend(sparkConnectedWalletId())
    newest.current = read
    read.then(next => {
      if (newest.current === read) {
        setHold(next)
      }
    })
    return read
  }, [])

  useFocusEffect(
    useCallback(() => {
      setHold(null)
      readHold()
    }, [readHold]),
  )

  const held = useCallback((next: 'exit' | 'unread') => {
    newest.current = null
    setHold(next)
  }, [])

  const heldAtPress = useCallback(async (): Promise<boolean> => (await readHold()) !== 'none', [readHold])

  if (hold === null) {
    return (
      <Screen layout="padded" contentStyle={styles.body}>
        <Skeleton width="100%" height={font.leading.sm} />
      </Screen>
    )
  }
  if (hold !== 'none') {
    return (
      <Screen
        layout="padded"
        contentStyle={styles.body}
        footer={
          <GradientButton
            label={t('emergencyExit.sendHeldOpen')}
            onPress={() => navigation.navigate('EmergencyExit', { selection: 'all' })}
          />
        }>
        <ErrorBox
          message={t(hold === 'exit' ? 'emergencyExit.receiveHeld' : 'emergencyExit.receiveHeldUnread')}
        />
      </Screen>
    )
  }
  return <ReceiveSpark heldAtPress={heldAtPress} onHeld={held} />
}

const styles = StyleSheet.create({
  body: { gap: space.md },
})
