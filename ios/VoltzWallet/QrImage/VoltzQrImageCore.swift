import Foundation
import Vision

// Reads the QR codes in a still image. It relays every code that holds text and decides nothing:
// src/wallet/qrImage.ts holds the rule about an image with more than one.
@objcMembers public final class VoltzQrImageCore: NSObject {

  // Off the main thread, since Vision decodes the whole image inside perform.
  public static func decode(
    _ uri: String,
    resolve: @escaping ([String]) -> Void,
    reject: @escaping (String, String) -> Void
  ) {
    guard let url = URL(string: uri), url.isFileURL else {
      reject("invalidUri", "not a file URL")
      return
    }
    DispatchQueue.global(qos: .userInitiated).async {
      let request = VNDetectBarcodesRequest()
      request.symbologies = [.qr]
      do {
        try VNImageRequestHandler(url: url, options: [:]).perform([request])
      } catch {
        reject("unreadable", error.localizedDescription)
        return
      }
      // A code with binary content has no string value, and nothing here can pay it.
      resolve((request.results ?? []).compactMap { $0.payloadStringValue }.filter { !$0.isEmpty })
    }
  }
}
