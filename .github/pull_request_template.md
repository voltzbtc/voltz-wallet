## What and why

<!-- What the change does, and the defect or need behind it. -->

## Device

<!-- For anything that depends on a device (native modules, the Keychain, rendering, a live SDK
connection), whether it was run on a device or simulator, and on which platform. Otherwise, "not
device dependent". -->

## Photos

<!-- A change that touches a screen attaches a before and an after photo of that screen, on Android
and on iPhone, side by side. The reviewer looks at them and says so before approving. How to take
them is in CONTRIBUTING.md. Otherwise, "no screen changed". -->

- [ ] Before and after photos of every screen touched, on Android and on iPhone, or no screen changed
- [ ] The Figma frame of each new or changed screen is linked, and the file matches the code (see Design in CONTRIBUTING.md), or no screen changed

## Checks

CI runs all five on every pull request. Run the first four locally before opening it, and the audit
as well when the change touches `package.json` or `package-lock.json`.

- [ ] `./scripts/typecheck.sh` passes
- [ ] `npx eslint .` passes
- [ ] `npx jest` passes
- [ ] `node scripts/check-secrets.mjs` passes
- [ ] `node scripts/audit-gate.mjs` passes

## Contributor terms

- [ ] I agree to the contributor terms in CONTRIBUTING.md
