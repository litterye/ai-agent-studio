// Augment Electron's App type with our custom `isQuitting` flag used
// by the close-to-hide and tray quit flows in src/main/index.ts.
declare namespace Electron {
  interface App {
    /** Set to true when the user explicitly quits (tray → exit, settings → quit). */
    isQuitting?: boolean
  }
}
