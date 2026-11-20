// react-native-get-random-values@2.0.0 declares a top-level `let module`, which collides with the
// `module` parameter injected by every CommonJS wrapper, so requiring it under Jest throws
// `SyntaxError: Identifier 'module' has already been declared`. The declaration is an upstream
// regression, absent from 1.11.0.
//
// The no-op is safe because Node already exposes a native `globalThis.crypto.getRandomValues`, which
// the real package would leave untouched (it only assigns when missing). bip39's randomBytes() keeps
// using real entropy in tests rather than a fake RNG.
export {}
