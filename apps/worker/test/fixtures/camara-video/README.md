# camara-video fixtures

Recorded 2026-11-12 for the video-evidence matching (`src/monitor/videoAlign.ts`).

- `NmI46Y25mEU-first16min.pt-orig.vtt`: the first 16 minutes of YouTube's automatic Portuguese captions (`pt-orig`,
  word-timed VTT, as yt-dlp 2026.10.26 writes them with `--write-auto-subs --sub-format vtt`) of the Câmara's official
  video of the plenary of 30 Jun 2026 (event 82635, `urlRegistro` https://www.youtube.com/watch?v=NmI46Y25mEU). The
  stream started at 2026-06-30 17:24:31 UTC (`timestamp` 1782840271 in the info JSON; `release_timestamp` is 21 s later), 14:24:31 in Brasília.
- `speeches-2026-06-30.json`: four official speech texts of that day from the Câmara's open data API
  (`/deputados/{id}/discursos`): the first three spoken ones and one sent in writing ("sem registro taquigráfico").
- `info-NmI46Y25mEU.recorded.json`: that run's info JSON, trimmed to the fields the caption job reads.
