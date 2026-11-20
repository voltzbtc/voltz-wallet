import React from 'react'
import { Linking, type StyleProp, type ViewStyle } from 'react-native'
import { useTranslation } from 'react-i18next'
import { storeUrl, type UpdateNotice } from '../wallet/updateNotice'
import { Card } from './Card'
import { Notice } from './Notice'
import { Row } from './Row'
import { Touch } from './Touch'
import { Txt } from './Txt'
import { space } from '../theme'

type Props = {
  notice: UpdateNotice
  onDismiss: () => void
  style?: StyleProp<ViewStyle>
}

// A card in Home's flow, never a modal, so at either level the rest of the screen stays in reach. Its
// words are fixed strings, since "this update is required" is how a scam reads.
export function UpdateBanner({ notice, onDismiss, style }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const critical = notice.level === 'critical'
  const body = (
    <>
      <Txt role="bodyBold" tone={critical ? 'danger' : 'default'}>
        {t(critical ? 'updateNotice.criticalTitle' : 'updateNotice.title')}
      </Txt>
      <Txt role="caption" tone="muted">
        {t(critical ? 'updateNotice.criticalBody' : 'updateNotice.body')}
      </Txt>
      <Row gap="lg">
        <Touch
          onPress={() => {
            Linking.openURL(storeUrl()).catch(() => undefined)
          }}
          feedback="link"
          hitSlop={space.sm}>
          <Txt role="bodyBold" tone="accent">
            {t('updateNotice.open')}
          </Txt>
        </Touch>
        {!critical && (
          <Touch onPress={onDismiss} feedback="link" hitSlop={space.sm}>
            <Txt role="bodyStrong" tone="muted">
              {t('updateNotice.later')}
            </Txt>
          </Touch>
        )}
      </Row>
    </>
  )
  // The critical level has a sign of its own beyond its words: the alarm fill and its icon.
  return critical ? (
    <Notice tone="danger" style={style}>
      {body}
    </Notice>
  ) : (
    <Card gap="sm" style={style}>
      {body}
    </Card>
  )
}
