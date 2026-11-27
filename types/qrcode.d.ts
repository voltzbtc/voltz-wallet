// The part of qrcode (1.5) that src/wallet/addressCard.ts reads: the module matrix of a symbol.
declare module 'qrcode' {
  export type QRCodeErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H'

  export interface BitMatrix {
    size: number
    get(row: number, col: number): number | boolean
  }

  export interface QRCodeSymbol {
    modules: BitMatrix
    version: number
  }

  export function create(
    text: string,
    options?: { errorCorrectionLevel?: QRCodeErrorCorrectionLevel },
  ): QRCodeSymbol
}
