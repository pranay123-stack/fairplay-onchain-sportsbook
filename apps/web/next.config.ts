import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@fairplay/shared"],
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: {
    // See lib/optional-dep-stub.ts: an unused server-side SDK reached through RainbowKit's wallet list.
    resolveAlias: { "@coinbase/cdp-sdk": "./lib/optional-dep-stub.ts" },
  },
};
export default config;
