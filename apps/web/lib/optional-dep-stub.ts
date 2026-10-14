/**
 * Stub for `@coinbase/cdp-sdk`, which `@base-org/account` (pulled in transitively by RainbowKit's wallet
 * list) imports only for its server-side payment/subscription helpers. FairPlay never calls those paths.
 * The real SDK drags in dozens of optional `@x402/*` modules that Turbopack cannot resolve, so it is
 * aliased here. If it were ever actually used, this throws loudly instead of silently doing nothing.
 */
export class CdpClient {
  constructor() {
    throw new Error("@coinbase/cdp-sdk is not bundled in FairPlay (Base Account payment helpers are unused)");
  }
}
