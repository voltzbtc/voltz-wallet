import React from 'react'

// Native camera TurboModules, absent in Jest.
export function Camera(props: Record<string, unknown>): React.JSX.Element {
  return React.createElement('Camera', props)
}
// The static permission API, granted as the hook below is.
Camera.getCameraPermissionStatus = (): string => 'granted'
Camera.requestCameraPermission = async (): Promise<string> => 'granted'

export function useCameraDevice(): { id: string } {
  return { id: 'mock-back-camera' }
}

export function useCameraPermission(): {
  hasPermission: boolean
  requestPermission: () => Promise<boolean>
} {
  return { hasPermission: true, requestPermission: async () => true }
}

export function useCodeScanner<T>(codeScanner: T): T {
  return codeScanner
}
