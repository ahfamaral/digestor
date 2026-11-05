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
  // Preview and Full briefing became one Briefing page at /s/[id] (2026-11-05); old links keep their query string.
  async redirects() {
    return [{ source: "/s/:id/briefing", destination: "/s/:id", permanent: false }];
  },
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
