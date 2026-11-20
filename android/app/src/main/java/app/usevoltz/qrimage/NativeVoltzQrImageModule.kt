package app.usevoltz.qrimage

import android.net.Uri
import app.usevoltz.store.NativeVoltzQrImageSpec
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage

// Reads the QR codes in a still image through ML Kit, the same artifact VisionCamera scans the camera
// with. It relays every code that holds text and decides nothing: src/wallet/qrImage.ts holds the rule
// about an image with more than one, and reads the platform's message, since a reader still
// downloading fails here as it does on the camera.
class NativeVoltzQrImageModule(reactContext: ReactApplicationContext) : NativeVoltzQrImageSpec(reactContext) {

  override fun decode(uri: String, promise: Promise) {
    val image =
      try {
        InputImage.fromFilePath(reactApplicationContext, Uri.parse(uri))
      } catch (error: Exception) {
        promise.reject("unreadable", error.message, error)
        return
      }
    val options = BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
    val scanner = BarcodeScanning.getClient(options)
    scanner
      .process(image)
      .addOnSuccessListener { barcodes ->
        val codes = Arguments.createArray()
        // A code with binary content has no raw value, and nothing here can pay it.
        barcodes.mapNotNull { it.rawValue }.filter { it.isNotEmpty() }.forEach { codes.pushString(it) }
        promise.resolve(codes)
      }
      .addOnFailureListener { error -> promise.reject("decodeFailed", error.message, error) }
      .addOnCompleteListener { scanner.close() }
  }

  companion object {
    const val NAME = NativeVoltzQrImageSpec.NAME
  }
}
