package app.usevoltz.biometric

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import app.usevoltz.store.NativeVoltzBiometricSpec
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil
import java.security.KeyStore
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// Biometric unlock for src/wallet/biometrics.ts. The secret (the app PIN's copy) is sealed with an AES
// key that the Keystore lets work for one operation at a time, and only after a strong biometric on
// the prompt that carries that operation. No time window follows an unlock, so the lock screen's own
// unlock, or the device credential typed anywhere, opens nothing here; and enrolling a new biometric
// invalidates the key. See specs/NativeVoltzBiometric.ts for why react-native-keychain cannot do it.
class NativeVoltzBiometricModule(reactContext: ReactApplicationContext) : NativeVoltzBiometricSpec(reactContext) {

  override fun enroll(secret: String, title: String, cancel: String, promise: Promise) {
    val cipher =
      try {
        Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, newKey()) }
      } catch (error: Exception) {
        // A device with no secure lock or no strong biometric enrolled refuses such a key.
        clear()
        promise.reject(UNAVAILABLE, error.message, error)
        return
      }
    authenticate(cipher, title, cancel, promise) { authed ->
      val sealed = authed.doFinal(secret.toByteArray(Charsets.UTF_8))
      prefs().edit()
        .putString(IV, Base64.encodeToString(authed.iv, Base64.NO_WRAP))
        .putString(SEALED, Base64.encodeToString(sealed, Base64.NO_WRAP))
        .commit()
      promise.resolve(null)
    }
  }

  override fun reveal(title: String, cancel: String, promise: Promise) {
    val iv = prefs().getString(IV, null)
    val sealed = prefs().getString(SEALED, null)
    if (iv == null || sealed == null) {
      clear()
      promise.resolve(null)
      return
    }
    val cipher =
      try {
        // null when no key is kept under the alias, which leaves no entry.
        val key = keyStore().getKey(ALIAS, null) as? SecretKey
        if (key == null) {
          clear()
          promise.resolve(null)
          return
        }
        Cipher.getInstance(TRANSFORMATION).apply {
          init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, Base64.decode(iv, Base64.NO_WRAP)))
        }
      } catch (error: Exception) {
        // Only a key the platform invalidated (a biometric enrolled or removed since the entry was
        // written) ends the entry. Any other Keystore failure can pass, so the entry stays for the
        // next unlock.
        if (invalidated(error)) {
          clear()
          promise.reject(INVALIDATED, error.message, error)
        } else {
          promise.reject(FAILED, error.message, error)
        }
        return
      }
    authenticate(cipher, title, cancel, promise) { authed ->
      try {
        promise.resolve(String(authed.doFinal(Base64.decode(sealed, Base64.NO_WRAP)), Charsets.UTF_8))
      } catch (error: AEADBadTagException) {
        // An enroll whose prompt was cancelled made a new key over the old entry, whose sealed bytes
        // no key opens again, so the entry ends as an invalidated one does.
        clear()
        promise.reject(INVALIDATED, error.message, error)
      }
    }
  }

  override fun isEnrolled(promise: Promise) {
    val stored = prefs().contains(SEALED)
    val keyed = runCatching { keyStore().containsAlias(ALIAS) }.getOrDefault(false)
    promise.resolve(stored && keyed)
  }

  override fun remove(promise: Promise) {
    clear()
    promise.resolve(null)
  }

  private fun authenticate(
    cipher: Cipher,
    title: String,
    cancel: String,
    promise: Promise,
    use: (Cipher) -> Unit,
  ) {
    val activity = reactApplicationContext.currentActivity as? FragmentActivity
    if (activity == null) {
      promise.reject(UNAVAILABLE, "no activity to show the prompt over")
      return
    }
    UiThreadUtil.runOnUiThread {
      // BiometricPrompt drops a prompt asked for after the activity saved its state, with no callback,
      // so the promise and the own-activity bracket around it would wait for good.
      if (activity.supportFragmentManager.isStateSaved) {
        promise.reject(UNAVAILABLE, "the app is not in front to show the prompt")
        return@runOnUiThread
      }
      val callback =
        object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            val authed = result.cryptoObject?.cipher
            if (authed == null) {
              promise.reject(FAILED, "the prompt returned no cipher")
              return
            }
            try {
              use(authed)
            } catch (error: Exception) {
              promise.reject(FAILED, error.message, error)
            }
          }

          override fun onAuthenticationError(code: Int, message: CharSequence) {
            promise.reject(if (code in CANCELS) CANCELLED else FAILED, message.toString())
          }
          // onAuthenticationFailed is a biometric not recognised; the prompt stays up for another try.
        }
      // Strong biometrics only, so the prompt offers no device credential and its negative button is
      // the app's cancel.
      val info =
        BiometricPrompt.PromptInfo.Builder()
          .setTitle(title)
          .setNegativeButtonText(cancel)
          .setAllowedAuthenticators(BIOMETRIC_STRONG)
          .setConfirmationRequired(false)
          .build()
      try {
        BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback)
          .authenticate(info, BiometricPrompt.CryptoObject(cipher))
      } catch (error: Exception) {
        promise.reject(UNAVAILABLE, error.message, error)
      }
    }
  }

  // A fresh key each enrollment, so no entry written before outlives it.
  private fun newKey(): SecretKey {
    keyStore().run { if (containsAlias(ALIAS)) deleteEntry(ALIAS) }
    val spec =
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(KEY_BITS)
        .setUserAuthenticationRequired(true)
        .setInvalidatedByBiometricEnrollment(true)
        .apply {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // A timeout of 0 is an authentication for every use, and only a strong biometric gives it.
            setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
          } else {
            // Below Android 11, -1 is the same: every use, and only a biometric can authorize one.
            @Suppress("DEPRECATION")
            setUserAuthenticationValidityDurationSeconds(-1)
          }
        }
        .build()
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
      init(spec)
      generateKey()
    }
  }

  // Whether a failure says the key is gone for good, as the exception itself or as its cause.
  private fun invalidated(error: Throwable): Boolean =
    generateSequence(error) { it.cause }.take(MAX_CAUSES).any { it is KeyPermanentlyInvalidatedException }

  private fun clear() {
    prefs().edit().clear().commit()
    runCatching { keyStore().run { if (containsAlias(ALIAS)) deleteEntry(ALIAS) } }
  }

  // Only the sealed bytes and their IV live here, which the key alone opens.
  private fun prefs() = reactApplicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun keyStore() = KeyStore.getInstance(KEYSTORE).apply { load(null) }

  companion object {
    const val NAME = NativeVoltzBiometricSpec.NAME
    private const val KEYSTORE = "AndroidKeyStore"
    private const val ALIAS = "app.usevoltz.biometric.unlock"
    private const val PREFS = "app.usevoltz.biometric"
    private const val IV = "iv"
    private const val SEALED = "sealed"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val KEY_BITS = 256
    private const val TAG_BITS = 128
    private const val MAX_CAUSES = 8
    private const val CANCELLED = "E_CANCELLED"
    private const val INVALIDATED = "E_INVALIDATED"
    private const val UNAVAILABLE = "E_UNAVAILABLE"
    private const val FAILED = "E_FAILED"
    private val CANCELS =
      setOf(
        BiometricPrompt.ERROR_NEGATIVE_BUTTON,
        BiometricPrompt.ERROR_USER_CANCELED,
        BiometricPrompt.ERROR_CANCELED,
      )
  }
}
