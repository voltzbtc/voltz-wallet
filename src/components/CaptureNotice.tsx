import React from 'react'
import type { StyleProp, ViewStyle } from 'react-native'
import { useTranslation } from 'react-i18next'
import type { ScreenCapture } from '../hooks/useScreenCapture'
import { Card } from './Card'
import { Notice } from './Notice'
import { Txt } from './Txt'

// What a phrase screen says about capture: why the words are gone, or that a screenshot of them is
// worth deleting. Draws nothing the rest of the time, so the space around it comes from the caller
// through `style`, and goes with it.
export function CaptureNotice({
  capture,
  style,
}: {
  capture: ScreenCapture
  style?: StyleProp<ViewStyle>
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (capture.phase === 'captured') {
    return (
      <Card style={style}>
        <Txt role="body">{t('backup.wordsHidden')}</Txt>
      </Card>
    )
  }
  if (capture.screenshot) {
    return (
      <Notice style={style}>
        <Txt role="caption">{t('backup.screenshotTaken')}</Txt>
      </Notice>
    )
  }
  return null
}
