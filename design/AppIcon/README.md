# App icon, iOS 26 (Icon Composer)

The bottom "glow" on the home screen is the iOS 26 Liquid Glass material, applied by
the system to every icon (Safari, Fitness, etc. all get it). It is not baked into the
app's PNG (that file is flat orange) and it cannot be fully removed, only tuned. Authoring
the icon in Icon Composer gives control over the specular, so the sheen reads intentionally.

## Layers (already prepared here)

- Background: solid orange `#ff7a00`
- Foreground: `Glyph.svg`, the dark Voltz mark (`#231f20`) on transparent, 1024x1024

## Steps (Xcode 26, ~2 min)

1. Open **Icon Composer** (Xcode > Open Developer Tool > Icon Composer).
2. New document. Set the background fill to solid `#ff7a00`.
3. Drag `Glyph.svg` in as the foreground layer; center it.
4. In the inspector, lower **Specular** (turn it down/off) until the bottom glow is
   subtle. Preview in Light / Dark / Clear to check all appearances.
5. Export as `AppIcon.icon`.
6. In Xcode, add `AppIcon.icon` to the app target and set it as the app icon
   (removing the old `AppIcon.appiconset` reference). Build and check the springboard.

## Fallback

On the flat PNG the icon still looks correct and consistent with every other iOS 26
app. The sheen is the platform look, not a defect.
