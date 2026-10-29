import { defineConfig } from "vitest/config";

try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // no root .env (e.g. in containers, where compose provides the environment)
}

export default defineConfig({
  test: {
    globalSetup: ["./test/globalSetup.ts"],
    fileParallelism: false,
  },
});
