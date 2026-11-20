import React, { useState } from 'react'
import { Linking, StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { sparkBuyBitcoinUrl } from '../wallet/spark'
import { ReceiveHeldByExit } from '../wallet/errors'
import { GradientButton } from '../components/GradientButton'
import BitcoinLogo from '../assets/asset-icons/bitcoin.svg'
import { space } from '../theme'
import { ErrorBox } from '../components/ErrorBox'
import { CenterStack, Screen } from '../components/Screen'
import { ScreenTitle } from '../components/ScreenTitle'

// Moonpay hosts the purchase and the BTC lands at the wallet's own address, so neither fiat nor
// BTC passes through Voltz and there is no spread.
export function BuyScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  // The line under the button: the purchase failed, or it waits out the wallet's emergency exit.
  const [failure, setFailure] = useState<string | null>(null)

  async function buy() {
    if (busy) {
      return
    }
    setBusy(true)
    setFailure(null)
    try {
      await Linking.openURL(await sparkBuyBitcoinUrl())
    } catch (cause) {
      setFailure(
        cause instanceof ReceiveHeldByExit
          ? t(cause.hold === 'exit' ? 'emergencyExit.receiveHeld' : 'emergencyExit.receiveHeldUnread')
          : t('buy.failed'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen layout="center">
      <View style={styles.logo}>
        <BitcoinLogo width={72} height={72} />
      </View>
      <ScreenTitle centered title={t('buy.title')} subtitle={t('buy.subtitle')} />
      <CenterStack>
        {failure !== null && <ErrorBox message={failure} />}
        <GradientButton label={t('buy.cta')} onPress={buy} loading={busy} />
      </CenterStack>
    </Screen>
  )
}

const styles = StyleSheet.create({
  logo: { marginBottom: space.lg },
})
