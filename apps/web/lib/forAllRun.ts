/** What a "For all clips" run came to: the clips that saved and the clips that did not. */
export interface ForAllOutcome {
  ok: string[];
  failed: string[];
  /** Every clip saved / some did / none did. */
  result: "all" | "partial" | "none";
}

/**
 * Runs `save` for each clip id in order, one at a time. A clip that fails (`save` resolves false or throws) is recorded
 * and the rest go on; `onProgress` is told how many are done after each clip.
 */
export async function runForAll(
  ids: string[],
  save: (id: string) => Promise<boolean>,
  onProgress: (done: number) => void = () => {},
): Promise<ForAllOutcome> {
  const ok: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    let saved = false;
    try {
      saved = await save(id);
    } catch {
      saved = false;
    }
    (saved ? ok : failed).push(id);
    onProgress(ok.length + failed.length);
  }
  return { ok, failed, result: failed.length === 0 ? "all" : ok.length === 0 ? "none" : "partial" };
}
