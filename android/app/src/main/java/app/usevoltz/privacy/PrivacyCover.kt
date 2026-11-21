package app.usevoltz.privacy

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.content.res.Resources
import android.graphics.Color
import android.graphics.Outline
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import android.view.animation.AnimationUtils
import android.view.inspector.WindowInspector
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import app.usevoltz.R
import com.facebook.react.bridge.Promise

// The cover over the app while it is away, and the stamp of the leave on the clock that times the
// trip. MainActivity calls onPause before super.onPause, so the stamp and the cover come before React
// Native hears of the pause, and onPostResume once the return is complete; NativeVoltzPrivacyModule is
// the JS side's way in. The pattern is MetaMask mobile's PrivacyCover (PR 37256): a decor-view child
// sits under React Native Modals, which are Dialog windows of their own, so the cover is also a
// full-screen Dialog shown after them, which makes it the top window of the app.
internal object PrivacyCover {
  private const val TAG = "VoltzPrivacy"

  // A cover that comes and goes within a few frames reads as a flicker, so it stays up at least this
  // long; one already up longer comes down at once.
  private const val MIN_SHOWN_MS = 250L

  // The window manager starts a removed window's exit on its next frame and composes the last frame of
  // it one frame after the end, so the cover outlasts an exit by about three frames at 60 Hz.
  private const val EXIT_MARGIN_MS = 50L

  // How long a lift after the lock waits for a Modal window under the cover to close. The lock closes
  // them in the commit that lays the PIN out, so one still open past this is one the lock does not
  // close (an Alert), and waiting longer would only keep the PIN hidden.
  private const val CLOSE_WAIT_MS = 500L

  // The mark is drawn at the size and corner radius the app draws its logo with (App.tsx, radius.xl).
  private const val MARK_DP = 88f
  private const val MARK_RADIUS_DP = 20f

  // The codes takeAway answers with, as specs/NativeVoltzPrivacy.ts documents them.
  private const val NO_LEAVE = -1.0
  private const val CLOCK_FAILED = -2.0

  // RELOCK_AFTER_OWN_MS in src/wallet/relock.ts, which __tests__/ownActivity.test.ts holds equal. A return
  // from a trip that began inside the app's own activity and lasted this long is locked, so it comes
  // back covered although its leave raised nothing.
  private const val OWN_LOCK_AFTER_MS = 600_000L

  // Written on the main thread and read from the JS thread, so behind this lock. Each is the first leave
  // of its kind since the last take.
  private val stamp = Any()
  private var leftAt: Long? = null
  private var ownLeftAt: Long? = null
  private var ownDepth = 0

  // Main thread only.
  private var overlay: View? = null
  private var dialog: Dialog? = null
  private var dialogActivity: Activity? = null
  private var backCallback: OnBackPressedCallback? = null
  private var backActivity: Activity? = null
  private val hiddenFromReaders = mutableListOf<Pair<View, Int>>()
  private var shownAt = 0L
  private var leaves = 0
  private var resumed = false
  private val waiters = mutableListOf<Promise>()
  private val main = Handler(Looper.getMainLooper())
  // The app's Dialog windows, React Native Modals among them, that were up under the cover, until it
  // comes down.
  private val under = mutableListOf<Under>()
  // The latest hide asked for, until the cover comes down or a leave drops it.
  private var lift: Lift? = null
  private val liftCheck = Runnable { tryLift() }

  // A window under the cover, and once it is removed, when, and how long the exit the window manager
  // then plays runs.
  private class Under(val root: View) {
    var goneAt: Long? = null
    var exitMs = 0L
    var listener: View.OnAttachStateChangeListener? = null
  }

  // `closing` is a hide after the lock, which has closed every Modal under the cover.
  private class Lift(val leave: Int, val closing: Boolean, val askedAt: Long)

  // Before super.onPause. A pause while the app's own activity runs (a picker, a permission dialog, a
  // biometric or passkey prompt, the store's sheet), or the pause of a recreation for a configuration
  // change, raises nothing and is stamped apart, since nothing more is heard when Home is pressed inside
  // that activity: the JS side gives such a trip a longer limit, and an activity whose bracket never
  // closes still leaves every trip timed, until its release closes the bracket.
  fun onPause(activity: Activity) {
    resumed = false
    leaves += 1
    settleWaiters(false)
    val own =
      synchronized(stamp) {
        val own = ownDepth > 0 || activity.isChangingConfigurations
        // elapsedRealtime counts deep sleep and cannot be set, unlike uptimeMillis and
        // currentTimeMillis (android.os.SystemClock). The first leave of each kind since the last take
        // keeps its stamp, so the clock never restarts while away.
        if (own) {
          if (ownLeftAt == null) {
            ownLeftAt = SystemClock.elapsedRealtime()
          }
        } else if (leftAt == null) {
          leftAt = SystemClock.elapsedRealtime()
        }
        own
      }
    // An activity on its way out is not drawn again; onResume covers the one that replaces it.
    if (!own && !activity.isFinishing) {
      show(activity)
    }
  }

  // A trip that ended the activity (Back on the root screen) comes back in a new one, which has no
  // cover yet while the stamp still waits for the JS side to decide. A trip from inside the app's own
  // activity raised no cover, so one long enough to lock is covered here.
  fun onResume(activity: Activity) {
    val (pending, ownLocks) =
      synchronized(stamp) {
        val own = ownLeftAt
        val now = SystemClock.elapsedRealtime()
        (leftAt != null) to (own != null && (own <= 0 || now < own || now - own >= OWN_LOCK_AFTER_MS))
      }
    if ((pending && overlay?.context !== activity) || ownLocks) {
      show(activity)
    }
  }

  // React Native reports 'active' from onResume, before onPostResume, when Android does not yet show a
  // biometric prompt. The JS side waits for this before it decides, and a hide before it is dropped.
  fun onPostResume() {
    resumed = true
    settleWaiters(true)
  }

  // The trip from the app's own screens, then the one from inside its own activities.
  fun takeAway(): Pair<Double, Double> =
    synchronized(stamp) {
      val now = SystemClock.elapsedRealtime()
      val trips = since(leftAt, now) to since(ownLeftAt, now)
      leftAt = null
      ownLeftAt = null
      trips
    }

  // A clock that reads zero or runs backwards cannot time the trip, so the trip counts as long enough to
  // lock.
  private fun since(stamp: Long?, now: Long): Double =
    when {
      stamp == null -> NO_LEAVE
      stamp <= 0 || now <= 0 || now < stamp -> CLOCK_FAILED
      else -> (now - stamp).toDouble()
    }

  fun beginOwnActivity() {
    synchronized(stamp) { ownDepth += 1 }
  }

  fun endOwnActivity() {
    synchronized(stamp) { if (ownDepth > 0) ownDepth -= 1 }
  }

  fun whenInFront(promise: Promise) {
    if (resumed) promise.resolve(true) else waiters.add(promise)
  }

  // A hide that finds the app paused belongs to a return that is over, and one held for the floor or
  // for a window's exit is dropped if a leave came meanwhile, so neither uncovers the next trip. The
  // cover never comes down over a window still leaving the screen: Android plays a removed Dialog's exit
  // animation after the app has let go of it, so a sheet the lock closed in the commit that drew the
  // PIN would otherwise slide out over the PIN. With `closing`, the lock has closed every Modal under
  // the cover, so the hide also waits for those still up to go.
  fun hide(closing: Boolean) {
    if (!resumed) {
      return
    }
    lift = Lift(leaves, closing, SystemClock.elapsedRealtime())
    tryLift()
  }

  private fun tryLift() {
    main.removeCallbacks(liftCheck)
    val request = lift ?: return
    if (!resumed || leaves != request.leave) {
      lift = null
      return
    }
    val wait = liftAt(request) - SystemClock.elapsedRealtime()
    if (wait > 0) {
      main.postDelayed(liftCheck, wait)
      return
    }
    lift = null
    dismiss()
  }

  // The earliest the cover may come down: its floor, the end of every exit under way, and after the
  // lock, a short wait for a window under the cover that has not closed yet; its removal asks again.
  private fun liftAt(request: Lift): Long {
    var at = shownAt + MIN_SHOWN_MS
    for (window in under) {
      val goneAt = window.goneAt
      if (goneAt != null) {
        at = maxOf(at, goneAt + window.exitMs + EXIT_MARGIN_MS)
      } else if (request.closing) {
        at = maxOf(at, request.askedAt + CLOSE_WAIT_MS)
      }
    }
    // Below Android 10 the windows cannot be listed, so a hide after the lock waits out, from the ask,
    // the exit React Native gives every Modal (config_shortAnimTime in catalyst_slide_down and
    // catalyst_fade_out).
    val context = overlay?.context
    if (request.closing && Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && context != null) {
      at = maxOf(at, request.askedAt + shortExitMs(context) + EXIT_MARGIN_MS)
    }
    return at
  }

  // Every Dialog window of the app's under the cover, listed through WindowInspector, the public list of
  // the process's windows (Android 10). Its removal is the start of its exit, which the window manager
  // runs for the length the window's own animation style gives.
  private fun trackWindows() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      return
    }
    val cover = dialog?.window?.decorView
    val roots =
      try {
        WindowInspector.getGlobalWindowViews()
      } catch (error: RuntimeException) {
        Log.w(TAG, "app windows unreadable", error)
        return
      }
    for (root in roots) {
      val params = root.layoutParams as? WindowManager.LayoutParams ?: continue
      // A Dialog's window; the activity's own, a popup's and a panel's have types of their own.
      if (
        root === cover ||
        params.type != WindowManager.LayoutParams.TYPE_APPLICATION ||
        !root.isAttachedToWindow ||
        under.any { it.root === root }
      ) {
        continue
      }
      val window = Under(root)
      val listener =
        object : View.OnAttachStateChangeListener {
          override fun onViewAttachedToWindow(view: View) = Unit

          // Posted, since this runs inside the window manager's removal of the Dialog.
          override fun onViewDetachedFromWindow(view: View) {
            view.removeOnAttachStateChangeListener(this)
            window.listener = null
            window.goneAt = SystemClock.elapsedRealtime()
            window.exitMs = exitMs(view.context, params)
            main.post(liftCheck)
          }
        }
      root.addOnAttachStateChangeListener(listener)
      window.listener = listener
      under.add(window)
    }
  }

  private fun forgetWindows() {
    under.forEach { window -> window.listener?.let { window.root.removeOnAttachStateChangeListener(it) } }
    under.clear()
  }

  // The windowExitAnimation of the style the window's params name, which for a React Native Modal is
  // the one its animationType chose when the Dialog was made, at the window animation scale of the
  // developer options, where 0 turns animations off.
  private fun exitMs(context: Context, params: WindowManager.LayoutParams): Long {
    if (params.windowAnimations == 0) {
      return 0
    }
    val scale = animationScale(context)
    return try {
      val attrs = context.obtainStyledAttributes(params.windowAnimations, intArrayOf(android.R.attr.windowExitAnimation))
      val anim =
        try {
          attrs.getResourceId(0, 0)
        } finally {
          attrs.recycle()
        }
      if (anim == 0) 0 else (AnimationUtils.loadAnimation(context, anim).computeDurationHint() * scale).toLong()
    } catch (error: RuntimeException) {
      Log.w(TAG, "exit animation unreadable", error)
      shortExitMs(context)
    }
  }

  private fun shortExitMs(context: Context): Long =
    (Resources.getSystem().getInteger(android.R.integer.config_shortAnimTime) * animationScale(context)).toLong()

  private fun animationScale(context: Context): Float =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.WINDOW_ANIMATION_SCALE, 1f).coerceAtLeast(0f)

  // An activity destroyed while paused gets no return to lower its cover. Nor does it get the result or
  // the answer an open bracket waits for, so every bracket still open closes here; one that stayed open
  // would time every later trip against the longer limit and raise no cover on the way out. A bracket
  // that does end later finds the depth at zero, which endOwnActivity leaves as it is.
  fun release(activity: Activity) {
    synchronized(stamp) { ownDepth = 0 }
    if (dialogActivity === activity) {
      dismissDialog()
    }
    val sink = overlay
    if (sink != null && sink.context === activity) {
      (sink.parent as? ViewGroup)?.removeView(sink)
      overlay = null
    }
    if (backActivity === activity) {
      backCallback?.remove()
      backCallback = null
      backActivity = null
    }
    restoreReaders()
  }

  private fun settleWaiters(inFront: Boolean) {
    val pending = waiters.toList()
    waiters.clear()
    pending.forEach { it.resolve(inFront) }
  }

  private fun show(activity: Activity) {
    val decor = activity.window?.decorView as? ViewGroup ?: return
    // Taken before the cover's Dialog takes focus, which would leave the keyboard with no token to
    // close it by.
    val keyboard = activity.currentFocus?.windowToken ?: decor.windowToken
    shownAt = SystemClock.elapsedRealtime()
    val sink =
      overlay?.takeIf { it.context === activity }
        ?: coverView(activity).also { fresh ->
          overlay?.let { (it.parent as? ViewGroup)?.removeView(it) }
          overlay = fresh
        }
    if (sink.parent !== decor) {
      (sink.parent as? ViewGroup)?.removeView(sink)
      decor.addView(sink, FrameLayout.LayoutParams(MATCH, MATCH))
    }
    sink.bringToFront()
    sink.visibility = View.VISIBLE
    showDialog(activity)
    trackWindows()
    if (dialog?.isShowing != true) {
      sink.requestFocus()
    }
    // The keyboard is a window above the cover and would come back on the return over it.
    hideKeyboard(activity, keyboard)
    hideFromReaders(decor, sink)
    blockBack(activity)
  }

  private fun dismiss() {
    dismissDialog()
    forgetWindows()
    overlay?.visibility = View.GONE
    restoreReaders()
    backCallback?.isEnabled = false
  }

  // The app's background with the Voltz mark in its middle, as on iOS. It takes every touch and is the
  // one thing a screen reader finds.
  private fun coverView(activity: Activity): View {
    val density = activity.resources.displayMetrics
    val side = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, MARK_DP, density).toInt()
    val corner = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, MARK_RADIUS_DP, density)
    val mark =
      ImageView(activity).apply {
        setImageResource(R.drawable.voltz_cover_mark)
        scaleType = ImageView.ScaleType.CENTER_CROP
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        outlineProvider =
          object : ViewOutlineProvider() {
            override fun getOutline(view: View, outline: Outline) {
              outline.setRoundRect(0, 0, view.width, view.height, corner)
            }
          }
        clipToOutline = true
      }
    return FrameLayout(activity).apply {
      // colors.background in src/theme.ts.
      setBackgroundColor(Color.BLACK)
      isClickable = true
      isFocusable = true
      isFocusableInTouchMode = true
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
      contentDescription = activity.getString(R.string.app_name)
      addView(mark, FrameLayout.LayoutParams(side, side, Gravity.CENTER))
    }
  }

  private fun showDialog(activity: Activity) {
    if (dialog != null && dialogActivity !== activity) {
      dismissDialog()
    }
    val cover =
      dialog
        ?: Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen).apply {
          // Not cancelable, so Back while it is up does nothing.
          setCancelable(false)
          setCanceledOnTouchOutside(false)
          setContentView(coverView(activity), ViewGroup.LayoutParams(MATCH, MATCH))
          window?.apply {
            setWindowAnimations(0)
            setLayout(MATCH, MATCH)
            // The activity's FLAG_SECURE does not reach a window of its own.
            addFlags(
              WindowManager.LayoutParams.FLAG_SECURE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS,
            )
            @Suppress("DEPRECATION")
            statusBarColor = Color.BLACK
            @Suppress("DEPRECATION")
            navigationBarColor = Color.BLACK
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
              attributes =
                attributes.apply {
                  layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                }
            }
          }
        }.also {
          dialog = it
          dialogActivity = activity
        }
    if (cover.isShowing) {
      return
    }
    try {
      cover.show()
    } catch (error: RuntimeException) {
      // The decor child still covers the app's own view.
      Log.w(TAG, "cover window refused", error)
    }
  }

  private fun dismissDialog() {
    val cover = dialog ?: return
    dialog = null
    dialogActivity = null
    try {
      if (cover.isShowing) {
        cover.dismiss()
      }
    } catch (error: RuntimeException) {
      Log.w(TAG, "cover window would not close", error)
    }
  }

  private fun hideKeyboard(activity: Activity, token: IBinder?) {
    if (token == null) {
      return
    }
    activity.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(token, 0)
  }

  // TalkBack has no modal flag for a view, so every other child of the decor is hidden from it and the
  // cover takes its focus.
  private fun hideFromReaders(decor: ViewGroup, cover: View) {
    restoreReaders()
    for (index in 0 until decor.childCount) {
      val child = decor.getChildAt(index)
      if (child === cover) {
        continue
      }
      hiddenFromReaders.add(child to child.importantForAccessibility)
      child.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    }
    cover.performAccessibilityAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS, null)
  }

  private fun restoreReaders() {
    hiddenFromReaders.forEach { (view, importance) -> view.importantForAccessibility = importance }
    hiddenFromReaders.clear()
  }

  // For the case the Dialog could not show: registered after React Native's own callback, so Back
  // reaches this one first and the screen under the cover stays where it is.
  private fun blockBack(activity: Activity) {
    val host = activity as? ComponentActivity ?: return
    if (backCallback == null || backActivity !== host) {
      backCallback?.remove()
      val callback =
        object : OnBackPressedCallback(true) {
          override fun handleOnBackPressed() = Unit
        }
      host.onBackPressedDispatcher.addCallback(host, callback)
      backCallback = callback
      backActivity = host
    } else {
      backCallback?.isEnabled = true
    }
  }

  private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
}
