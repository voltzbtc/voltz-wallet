import React from 'react'
import { useTranslation } from 'react-i18next'
import { Screen } from '../components/Screen'
import { EmptyState } from '../components/EmptyState'

// Placeholder for the header bell. The device keeps no notification list, so this always shows the
// empty state.
export function NotificationsScreen(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Screen layout="center">
      <EmptyState icon="bell" message={t('notifications.empty')} />
    </Screen>
  )
}
