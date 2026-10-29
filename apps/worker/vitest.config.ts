import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // DB (migrate + truncate TEST_DATABASE_URL) and media fixtures.
    globalSetup: ["./test/dbSetup.ts", "./test/globalSetup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
