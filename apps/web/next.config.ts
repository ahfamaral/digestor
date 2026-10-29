import type { NextConfig } from "next";
import { loadRootEnv } from "./lib/env";

// Host runs read the repo-root .env (DATABASE_URL, DATA_DIR, APP_PASSWORD, ...); containers get env from compose.
loadRootEnv();

const nextConfig: NextConfig = {
  output: "standalone",
  agentRules: false, // don't let `next dev` write AGENTS.md into the repo
  transpilePackages: ["@digestor/core"],
  serverExternalPackages: ["pg", "pg-boss"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
