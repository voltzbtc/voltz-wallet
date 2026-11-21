import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useNavigation, usePreventRemove } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useTranslation } from 'react-i18next'
import type { MnemonicLength } from '../wallet/seed'
import { useSeedPair } from '../hooks/useSeedPair'
import { useFingerprint } from '../hooks/useFingerprint'
import { addAndActivateWallet, addPasskeyWallet, isWalletAlreadyAdded } from '../wallet/wallet'
import { passkeyOffered, passkeyWordsOwed, type PasskeyWallet } from '../wallet/passkey'
import { loadWalletMeta } from '../wallet/walletMeta'
import { formatFingerprint, resolveWalletDisplay } from '../wallet/walletIdentity'
import { BackupScreen } from './BackupScreen'
import { VerifyBackupScreen } from './VerifyBackupScreen'
import { PassphraseScreen } from './PassphraseScreen'
import { DiceScreen } from './DiceScreen'
import { ImportScreen } from './ImportScreen'
import { PasskeyWordsScreen } from './PasskeyWordsScreen'
import { GradientButton } from '../components/GradientButton'
import { PasskeyChoice, PasskeyRestore } from '../components/PasskeyAction'
import { WalletRowsSkeleton } from '../components/WalletRowsSkeleton'
import { ErrorBox } from '../components/ErrorBox'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { rhythm, space } from '../theme'
import { CenterStack, Screen } from '../components/Screen'
import { AdultsOnly } from '../components/AdultsOnly'
import { useMinorSignal } from '../hooks/useMinorSignal'
import { isAgeRefusal } from '../wallet/ageSignal'
import { Txt } from '../components/Txt'
import { Touch } from '../components/Touch'

type Stage =
  | 'choose'
  | 'dice'
  | 'backup'
  | 'verify'
  | 'passphrase'
  | 'import'
  | 'busy'
  | 'failed'
  | 'twin'
  | 'passkeyWords'
  | 'passkeyVerify'
  | 'leaving'

// The stages a store age signal under 18 replaces: the choice and every step that draws new words.
const TOWARD_NEW: ReadonlySet<Stage> = new Set<Stage>(['choose', 'dice', 'backup', 'verify', 'passphrase'])

// Stages absent here let the default back leave the flow entirely.
const PREVIOUS_STAGE: Partial<Record<Stage, Stage>> = {
  dice: 'choose',
  backup: 'choose',
  verify: 'backup',
  passphrase: 'verify',
  import: 'choose',
  passkeyVerify: 'passkeyWords',
}

// The stages with a title of their own, which goes in the header so the two never stack. The check
// asks its question on screen, so its header keeps the short name rather than shrink a long one.
const STAGE_TITLES: Partial<Record<Stage, string>> = {
  dice: 'dice.title',
  backup: 'backup.title',
  verify: 'settings.recoveryPhrase',
  passphrase: 'passphrase.title',
  import: 'import.title',
  passkeyWords: 'backup.title',
  passkeyVerify: 'settings.recoveryPhrase',
}

// Mirrors App.tsx's onboarding but persists as an additional wallet, not the primary one.
export function AddWalletScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const [stage, setStage] = useState<Stage>('choose')
  const minor = useMinorSignal()
  const [mnemonic, setMnemonic] = useState('')
  // A wallet already on this device with the same words and passphrase, named as the list names it
  // with its id, since a name left at the default tells two wallets apart by the id alone, and the
  // stage the add came from, which is where Back returns.
  const [twin, setTwin] = useState<{
    name: string
    fingerprint: string
    back: 'import' | 'passphrase' | 'backup'
  } | null>(null)
  // What the import step held when its add was refused, so stepping back to it keeps the phrase.
  const [importInput, setImportInput] = useState<{ phrase: string; passphrase?: string } | null>(null)
  const [diceSeed, setDiceSeed] = useState<{
    mnemonic: string
    length: MnemonicLength
    rolls: string
  } | null>(null)
  // Held across the stage steps, so stepping back to backup shows the same phrase.
  const seed = useSeedPair()
  // Set while an add runs, so a second tap on the step that started it writes nothing.
  const adding = useRef(false)
  // A passkey sheet open, which holds the screen until it answers.
  const [passkeyBusy, setPasskeyBusy] = useState(false)
  // The passkey wallet whose words are owed before the flow ends. Only its id, as in App.tsx.
  const [owedId, setOwedId] = useState<string | null>(null)
  // Caching the dice fingerprint keeps a length toggle or a step back off a fresh PBKDF2.
  const diceFingerprint = useFingerprint(diceSeed?.mnemonic ?? '')
  const fingerprint = diceSeed ? diceFingerprint : seed.fingerprint

  // Back steps through the internal stages, since popping the screen would drop the generated seed.
  // usePreventRemove is the native-stack-safe API, where beforeRemove + preventDefault desyncs.
  // A dice phrase steps back to its rolls, which DiceScreen reopens with.
  const previous =
    stage === 'twin' ? twin?.back : stage === 'backup' && diceSeed ? 'dice' : PREVIOUS_STAGE[stage]
  const held = previous != null || passkeyBusy || stage === 'passkeyWords'
  usePreventRemove(held, () => {
    if (previous) {
      setStage(previous)
    }
  })

  // The rolls are secret. Once the dice step is open its screen holds the only copy, taken from the
  // one kept for a step back from the phrase, so Clear or leaving for the choice leaves none to
  // bring back.
  useEffect(() => {
    if (stage === 'dice') {
      setDiceSeed(null)
    }
    // A phrase kept for a step back to import is dropped once the flow leaves for the choice.
    if (stage === 'choose') {
      setImportInput(null)
    }
  }, [stage])

  // Waits for the render that lifts the hold on back, which would otherwise stop this very navigation.
  useEffect(() => {
    if (stage === 'leaving' && !held) {
      navigation.navigate('Main')
    }
  }, [stage, held, navigation])

  useLayoutEffect(() => {
    navigation.setOptions({ title: t(STAGE_TITLES[stage] ?? 'addWallet.title') })
  }, [navigation, stage, t])

  function startCreate() {
    setDiceSeed(null)
    seed.setLength(12)
    seed.regenerate()
    setStage('backup')
  }

  function fromDiceRolls(rolled: string, len: MnemonicLength, rolls: string) {
    setDiceSeed({ mnemonic: rolled, length: len, rolls })
    setStage('backup')
  }

  // Rolling dice is the long way chosen on purpose, so a dice phrase keeps its confirmation, on the
  // words frozen here. A drawn phrase is stored from the phrase step.
  function confirmDiceBackup(rolled: string) {
    setMnemonic(rolled)
    setStage('verify')
  }

  // No SDK reconnect here, since Home connects the now-active wallet on focus.
  //
  // A failure offers the way back to the wallet list and no retry. The add writes the passphrase and
  // the seed, then the registry entry, then the active pointer, so a failure late in that order leaves
  // the wallet listed, and the same phrase entered again is refused as already added rather than
  // listed under a second id.
  //
  // The same words and passphrase as a wallet already here are refused before anything is written, so
  // that refusal names the wallet and steps back to where the phrase was entered, with it kept.
  async function finish(phrase: string, passphrase?: string, imported = false) {
    if (adding.current) {
      return
    }
    adding.current = true
    setStage('busy')
    try {
      await addAndActivateWallet(phrase, passphrase, imported ? 'typed' : diceSeed ? 'confirmed' : 'drawn')
    } catch (err) {
      if (isWalletAlreadyAdded(err)) {
        const meta = await loadWalletMeta(err.fingerprint).catch(() => null)
        setTwin({
          name: resolveWalletDisplay(err.fingerprint, meta, t('drawer.walletName')).name,
          fingerprint: formatFingerprint(err.fingerprint),
          back: imported ? 'import' : diceSeed ? 'passphrase' : 'backup',
        })
        if (imported) {
          setImportInput({ phrase, passphrase })
        }
        setStage('twin')
        return
      }
      setMnemonic('')
      // A refusal for age goes back to the choice, which the store's answer has already replaced. It is
      // not logged, since a log of it would say the person's age.
      if (isAgeRefusal(err)) {
        setStage('choose')
        return
      }
      console.warn(`wallet not added: ${(err as Error)?.message ?? String(err)}`)
      setStage('failed')
      return
    } finally {
      adding.current = false
    }
    setMnemonic('')
    navigation.navigate('Main')
  }

  // No passphrase step and no seed pair: a passkey's words carry none and were never drawn here. A
  // sign-in that lands on a wallet already here switches to it (addPasskeyWallet). Nothing connects
  // here, as for any other add, since Home connects on focus.
  //
  // A failure takes the same way out as `finish`, for the same reason: the write runs in steps.
  async function finishPasskey(wallet: PasskeyWallet): Promise<void> {
    setStage('busy')
    try {
      const id = await addPasskeyWallet(wallet)
      if (await passkeyWordsOwed(id)) {
        setOwedId(id)
        setStage('passkeyWords')
        return
      }
      setStage('leaving')
    } catch (err) {
      if (isAgeRefusal(err)) {
        setStage('choose')
        return
      }
      console.warn(`wallet not added: ${(err as Error)?.message ?? String(err)}`)
      setStage('failed')
    }
  }

  if ((stage === 'passkeyWords' || stage === 'passkeyVerify') && owedId) {
    return (
      <PasskeyWordsScreen
        headerTitled
        walletId={owedId}
        verifying={stage === 'passkeyVerify'}
        onVerifying={verifying => setStage(verifying ? 'passkeyVerify' : 'passkeyWords')}
        onDone={() => setStage('leaving')}
      />
    )
  }

  if (stage === 'busy' || stage === 'leaving') {
    return <WalletRowsSkeleton />
  }

  // The steps toward a new wallet give way when the store's age signal says the person is under 18. The
  // import step stays, since the words of a wallet this device held bring it back, and the write refuses
  // any other (wallet.ts). The wallets already on the device are not here, and keep working.
  if (minor && TOWARD_NEW.has(stage)) {
    return (
      <Screen layout="center">
        <AdultsOnly restore={{ label: t('addWallet.import'), onPress: () => setStage('import') }} />
      </Screen>
    )
  }

  if (stage === 'failed') {
    return (
      <Screen layout="center">
        <CenterStack>
          <ErrorBox message={t('addWallet.failed')} />
          <GradientButton label={t('common.back')} onPress={() => navigation.goBack()} />
        </CenterStack>
      </Screen>
    )
  }

  if (stage === 'twin' && twin) {
    return (
      <Screen layout="center">
        <CenterStack>
          <ErrorBox message={t('addWallet.alreadyAdded', { name: twin.name, fingerprint: twin.fingerprint })} />
          <GradientButton label={t('common.back')} onPress={() => setStage(twin.back)} />
        </CenterStack>
      </Screen>
    )
  }

  if (stage === 'dice') {
    // onBack stays unset so the in-screen chevron is not doubled up with the native header.
    return <DiceScreen headerTitled onGenerated={fromDiceRolls} initial={diceSeed ?? undefined} />
  }

  if (stage === 'backup') {
    const dice = diceSeed != null
    return (
      <BackupScreen
        headerTitled
        mnemonic={dice ? diceSeed.mnemonic : seed.mnemonic}
        fingerprint={fingerprint}
        length={dice ? diceSeed.length : seed.length}
        lockLength={dice}
        onLengthChange={seed.setLength}
        onRegenerate={dice ? undefined : seed.regenerate}
        passphrase={!dice}
        onConfirm={passphrase =>
          dice ? confirmDiceBackup(diceSeed.mnemonic) : finish(seed.mnemonic, passphrase)
        }
      />
    )
  }

  if (stage === 'verify') {
    return (
      <VerifyBackupScreen
        headerTitled
        mnemonic={mnemonic}
        onVerified={() => setStage('passphrase')}
        onShowWords={() => setStage('backup')}
      />
    )
  }

  if (stage === 'passphrase') {
    return <PassphraseScreen headerTitled onDone={passphrase => finish(mnemonic, passphrase)} />
  }

  if (stage === 'import') {
    return (
      // No onBack, since the native header already steps import back to choose through
      // usePreventRemove, and a second chevron in the screen would draw two back controls.
      <ImportScreen
        headerTitled
        initial={importInput ?? undefined}
        onImported={(phrase, passphrase) => finish(phrase, passphrase, true)}
        above={passkeyOffered() ? <PasskeyRestore onWallet={finishPasskey} onBusy={setPasskeyBusy} style={styles.passkeyRestore} /> : undefined}
      />
    )
  }

  return (
    // The header already says Add wallet, so the step opens on what the choice is.
    <Screen layout="center">
      <Txt role="body" tone="muted" textBreakStrategy="balanced" lineBreakStrategyIOS="standard" style={styles.subtitle}>
        {t('addWallet.subtitle')}
      </Txt>
      {/* Welcome's choice, in Welcome's order: one full-width call to action and the two other ways
          in as links, so the button keeps one width in every language. */}
      {passkeyOffered() ? (
        <PasskeyChoice
          mode="register"
          label={t('passkey.addNew')}
          wordsButton={t('addWallet.create')}
          wordsLink={t('passkey.useWords')}
          onWords={startCreate}
          onWallet={finishPasskey}
          busy={passkeyBusy}
          onBusy={setPasskeyBusy}
          actionStyle={styles.actions}
          linkStyle={styles.link}
        />
      ) : (
        <View style={styles.actions}>
          <GradientButton label={t('addWallet.create')} onPress={startCreate} />
        </View>
      )}
      <Touch onPress={() => setStage('import')} disabled={passkeyBusy} feedback="link" style={styles.link}>
        <Txt role="bodyStrong" tone="muted">
          {t('addWallet.import')}
        </Txt>
      </Touch>
      <Touch onPress={() => setStage('dice')} disabled={passkeyBusy} feedback="link" style={styles.link}>
        <Txt role="bodyStrong" tone="muted">
          {t('welcome.dice')}
        </Txt>
      </Touch>
    </Screen>
  )
}

const styles = StyleSheet.create({
  subtitle: { textAlign: 'center' },
  // Over the restore step's choice of length, a block's distance.
  passkeyRestore: {
    marginBottom: space.lg,
  },
  // Stretched across the centred layout, which would otherwise size the button to its label.
  actions: {
    alignSelf: 'stretch',
    marginTop: rhythm.groupToAction,
  },
  link: {
    alignSelf: 'center',
    marginTop: space.lg,
  },
})
