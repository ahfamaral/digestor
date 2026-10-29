import { existsSync } from "node:fs";
import path from "node:path";

// The paths below are runtime lookups, not imports: `turbopackIgnore` stops Next from tracing the whole repo.

/** The monorepo root (nearest folder with pnpm-workspace.yaml above cwd), or cwd when there is none (prod image). */
export function repoRoot(start = process.cwd()): string {
  for (let dir = path.resolve(/*turbopackIgnore: true*/ start); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(/*turbopackIgnore: true*/ dir, "pnpm-workspace.yaml"))) return dir;
    if (path.dirname(dir) === dir) return path.resolve(/*turbopackIgnore: true*/ start);
  }
}

/** Host runs read the repo-root .env; in containers compose provides the environment and there is no file. */
export function loadRootEnv(): void {
  const file = path.join(/*turbopackIgnore: true*/ repoRoot(), ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

/** DATA_DIR, with a relative value resolved against the repo root (not apps/web). */
export function dataDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ repoRoot(), process.env.DATA_DIR ?? "./data");
}
