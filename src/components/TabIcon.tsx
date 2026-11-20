import React from 'react'
import { I18nManager } from 'react-native'
import Svg, { Circle, Path } from 'react-native-svg'

export type TabIconName =
  | 'home'
  | 'history'
  | 'pix'
  | 'menu'
  | 'bell'
  | 'send'
  | 'receive'
  | 'convert'
  | 'scan'
  | 'eye'
  | 'eye-off'
  | 'minus'
  | 'plus'
  | 'paste'
  | 'image'
  | 'close'
  | 'faceid'
  | 'fingerprint'
  | 'globe'
  | 'lock'
  | 'chevron'
  | 'chevron-left'
  | 'arrow-left'
  | 'check'
  | 'key'
  | 'currency'
  | 'banknote'
  | 'dollar'
  | 'help'
  | 'document'
  | 'copy'
  | 'share'
  | 'backspace'
  | 'edit'
  | 'camera'
  | 'nfc'
  | 'keyboard'
  | 'server'
  | 'bolt'
  | 'contacts'
  | 'shield'
  | 'cart'
  | 'mail'
  | 'refresh'
  | 'move'
  | 'alert'
  | 'search'

type Props = {
  name: TabIconName
  color: string
  size?: number
  strokeWidth?: number
}

export function TabIcon({ name, color, size = 24, strokeWidth = 2 }: Props): React.JSX.Element {
  if (name === 'pix') {
    return (
      <Svg width={size} height={size} viewBox="0 0 16 16">
        <Path
          fill={color}
          d="M11.917 11.71a2.046 2.046 0 0 1-1.454-.602l-2.1-2.1a.4.4 0 0 0-.551 0l-2.108 2.108a2.044 2.044 0 0 1-1.454.602h-.414l2.66 2.66c.83.83 2.177.83 3.007 0l2.667-2.668h-.253zM4.25 4.282c.55 0 1.066.214 1.454.602l2.108 2.108a.39.39 0 0 0 .552 0l2.1-2.1a2.044 2.044 0 0 1 1.453-.602h.253L9.503 1.623a2.127 2.127 0 0 0-3.007 0l-2.66 2.66h.414z"
        />
        <Path
          fill={color}
          d="m14.377 6.496-1.612-1.612a.307.307 0 0 1-.114.023h-.733c-.379 0-.75.154-1.017.422l-2.1 2.1a1.005 1.005 0 0 1-1.425 0L5.268 5.32a1.448 1.448 0 0 0-1.018-.422h-.9a.306.306 0 0 1-.109-.021L1.623 6.496c-.83.83-.83 2.177 0 3.008l1.618 1.618a.305.305 0 0 1 .108-.022h.901c.38 0 .75-.153 1.018-.421L7.375 8.57a1.034 1.034 0 0 1 1.426 0l2.1 2.1c.267.268.638.421 1.017.421h.733c.04 0 .079.01.114.024l1.612-1.612c.83-.83.83-2.178 0-3.008z"
        />
      </Svg>
    )
  }

  const stroke = {
    stroke: color,
    strokeWidth,
    fill: 'none',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }

  // Back and forward marks point along the reading direction, so they mirror under RTL. Nothing else does.
  const rtlFlip =
    I18nManager.isRTL && (name === 'chevron' || name === 'chevron-left' || name === 'arrow-left')

  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={rtlFlip ? { transform: [{ scaleX: -1 }] } : undefined}>
      {name === 'home' && (
        <Path {...stroke} d="M3 11l9-8 9 8M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10" />
      )}
      {name === 'history' && (
        <>
          <Circle cx={12} cy={12} r={9} {...stroke} />
          <Path {...stroke} d="M12 7v5l3 2" />
        </>
      )}
      {name === 'menu' && <Path {...stroke} d="M3 6h18M3 12h18M3 18h18" />}
      {name === 'server' && (
        <>
          <Path {...stroke} d="M5 4h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
          <Path {...stroke} d="M5 13h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z" />
          <Path {...stroke} d="M6.5 7.5h2M6.5 16.5h2" />
        </>
      )}
      {name === 'bell' && (
        <Path {...stroke} d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
      )}
      {name === 'receive' && <Path {...stroke} d="M17 7L7 17M17 17H7V7" />}
      {name === 'send' && <Path {...stroke} d="M7 17L17 7M7 7h10v10" />}
      {name === 'convert' && (
        <Path
          {...stroke}
          d="M17 2l4 4-4 4M3 11V10a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3"
        />
      )}
      {name === 'refresh' && (
        <Path
          {...stroke}
          d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"
        />
      )}
      {/* Moving an address to another wallet is not an exchange. The circular arrows of `refresh`
          are the universal glyph for swap and sync, which is what made this row read as a trade;
          this is an arrow leaving for a container on the right, which is what actually happens. */}
      {name === 'move' && (
        <Path {...stroke} d="M3 12h11M10 8l4 4-4 4M17 5h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-3" />
      )}
      {name === 'scan' && (
        <Path
          {...stroke}
          d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M4 12h16"
        />
      )}
      {name === 'eye' && (
        <>
          <Path {...stroke} d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
          <Circle cx={12} cy={12} r={3} {...stroke} />
        </>
      )}
      {name === 'eye-off' && (
        <>
          <Path {...stroke} d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
          <Path {...stroke} d="M4 4l16 16" />
        </>
      )}
      {name === 'minus' && <Path {...stroke} d="M6 12h12" />}
      {name === 'plus' && <Path {...stroke} d="M12 6v12M6 12h12" />}
      {name === 'close' && <Path {...stroke} d="M6 6l12 12M18 6L6 18" />}
      {name === 'paste' && (
        <>
          <Path
            {...stroke}
            d="M9 5H7a1 1 0 00-1 1v13a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1h-2"
          />
          <Path {...stroke} d="M9 4h6v3H9z" />
        </>
      )}
      {name === 'image' && (
        <>
          <Path {...stroke} d="M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z" />
          <Path {...stroke} d="M4 16l5-5 4 4 2-2 5 5" />
          <Path {...stroke} d="M15.5 8.5h.01" />
        </>
      )}
      {name === 'faceid' && (
        <>
          <Path
            {...stroke}
            d="M3 8V6a3 3 0 0 1 3-3h2M16 3h2a3 3 0 0 1 3 3v2M21 16v2a3 3 0 0 1-3 3h-2M8 21H6a3 3 0 0 1-3-3v-2"
          />
          <Path {...stroke} d="M9 9v1.5M15 9v1.5M12 9v3.5h-1M9 15.5c1 1 5 1 6 0" />
        </>
      )}
      {name === 'fingerprint' && (
        <Path
          {...stroke}
          d="M4.3 10.6a8.4 8.4 0 0 1 15.4-3.4M5 17A11.2 11.2 0 0 1 4.3 12M7.8 19.3a9.8 9.8 0 0 1-1-7.3 5.2 5.2 0 0 1 10.4 0c0 2.4-.3 4.6-1 6.7M12 12v5c0 1 .1 2.1.4 3.1"
        />
      )}
      {name === 'globe' && (
        <>
          <Circle cx={12} cy={12} r={9} {...stroke} />
          <Path {...stroke} d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
        </>
      )}
      {name === 'lock' && (
        <Path
          {...stroke}
          d="M8 11V7a4 4 0 0 1 8 0v4M6 11h12v8a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z"
        />
      )}
      {name === 'chevron' && <Path {...stroke} d="M9 6l6 6-6 6" />}
      {name === 'chevron-left' && <Path {...stroke} d="M15 6l-6 6 6 6" />}
      {name === 'arrow-left' && <Path {...stroke} d="M20 12H4M10 6l-6 6 6 6" />}
      {name === 'check' && <Path {...stroke} d="M5 13l4 4L19 7" />}
      {name === 'key' && (
        <>
          <Circle cx={7.5} cy={12} r={4} {...stroke} />
          <Path {...stroke} d="M11.5 12H21M18 12v3.5M21 12v2.5" />
        </>
      )}
      {name === 'currency' && (
        <>
          <Circle cx={12} cy={12} r={9} {...stroke} />
          <Path
            {...stroke}
            d="M12 7v10M14.5 9.5C14 8.6 13 8 12 8c-1.4 0-2.5.9-2.5 2s1.1 2 2.5 2 2.5.9 2.5 2-1.1 2-2.5 2c-1 0-2-.6-2.5-1.5"
          />
        </>
      )}
      {/* Feather Icons dollar-sign, MIT. */}
      {name === 'dollar' && (
        <>
          <Path {...stroke} d="M12 1v22" />
          <Path {...stroke} d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
        </>
      )}
      {name === 'banknote' && (
        <>
          <Path {...stroke} d="M2 8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" />
          <Circle cx={12} cy={12} r={2.5} {...stroke} />
          <Path {...stroke} d="M5.5 12h.01M18.5 12h.01" />
        </>
      )}
      {/* A shield, because the stable balance is protection from volatility, not a yield product. */}
      {name === 'shield' && (
        <>
          <Path {...stroke} d="M12 3l7 3v6c0 4-3 7.2-7 9-4-1.8-7-5-7-9V6z" />
          <Path {...stroke} d="M12 8v7M13.6 9.8c-.4-.5-1-.8-1.6-.8-.9 0-1.6.6-1.6 1.3s.7 1.3 1.6 1.3 1.6.6 1.6 1.3-.7 1.3-1.6 1.3c-.6 0-1.2-.3-1.6-.8" />
        </>
      )}
      {name === 'help' && (
        <>
          <Circle cx={12} cy={12} r={9} {...stroke} />
          <Path {...stroke} d="M9.5 9.2a2.6 2.6 0 0 1 5 .8c0 1.7-2.5 1.9-2.5 3.5M12 17h.01" />
        </>
      )}
      {name === 'document' && (
        <Path
          {...stroke}
          d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v4h4M9 13h6M9 17h6"
        />
      )}
      {name === 'copy' && (
        <>
          <Path {...stroke} d="M9 9h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" />
          <Path {...stroke} d="M5 15a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1" />
        </>
      )}
      {name === 'share' && (
        <>
          <Path {...stroke} d="M12 3v12M8 7l4-4 4 4" />
          <Path {...stroke} d="M6 12v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7" />
        </>
      )}
      {name === 'backspace' && (
        <Path
          {...stroke}
          d="M20 6H9.4a1 1 0 0 0-.75.34L4 12l4.65 5.66a1 1 0 0 0 .75.34H20a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1zM13 10l4 4M17 10l-4 4"
        />
      )}
      {name === 'edit' && (
        <>
          <Path {...stroke} d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
          <Path {...stroke} d="M15 5l4 4" />
        </>
      )}
      {name === 'camera' && (
        <>
          <Path
            {...stroke}
            d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"
          />
          <Circle cx={12} cy={13} r={4} {...stroke} />
        </>
      )}
      {name === 'nfc' && (
        <>
          <Path {...stroke} d="M5 9a10 10 0 0 1 0 6" />
          <Path {...stroke} d="M9 6a15 15 0 0 1 0 12" />
          <Path {...stroke} d="M13 4a20 20 0 0 1 0 16" />
          <Path {...stroke} d="M17 7a10 10 0 0 1 0 10" />
        </>
      )}
      {name === 'keyboard' && (
        <>
          <Path {...stroke} d="M3 6h18v12H3z" />
          <Path {...stroke} d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" />
        </>
      )}
      {name === 'bolt' && <Path {...stroke} d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />}
      {name === 'contacts' && (
        <Path {...stroke} d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z" />
      )}
      {/* Feather Icons shopping-cart, MIT. Keeps Buy distinct from the drawer's banknote. */}
      {name === 'alert' && (
        <>
          <Path {...stroke} d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          <Path {...stroke} d="M12 9v4M12 17h.01" />
        </>
      )}
      {name === 'search' && (
        <>
          <Circle cx={11} cy={11} r={7} {...stroke} />
          <Path {...stroke} d="M21 21l-4.3-4.3" />
        </>
      )}
      {name === 'mail' && (
        <>
          <Path {...stroke} d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
          <Path {...stroke} d="M22 7l-10 7L2 7" />
        </>
      )}
      {name === 'cart' && (
        <>
          <Circle cx={9} cy={21} r={1.4} {...stroke} />
          <Circle cx={20} cy={21} r={1.4} {...stroke} />
          <Path {...stroke} d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
        </>
      )}
    </Svg>
  )
}
