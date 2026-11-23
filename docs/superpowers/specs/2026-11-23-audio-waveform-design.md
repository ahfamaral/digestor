# Live waveform preview and audio download

Date: 2026-11-23. Status: approved 2026-11-23 ("banana", option 2 of 3) and built the same day.

## Why

The owner tested an audio-only upload (10 min of the Globo debate). The audio processing is good, but the screens don't match what comes out:

- The exported video of an audio-only clip already shows a white waveform on a dark background (ffmpeg `showwaves`, `mode=cline`, `#17181c`), in 16:9 or 9:16, with subtitles and credit.
- Before export, nothing shows it. Prepare has a Play button and a plain audio bar, the line editor has a hidden player, and "Change look" shows an empty dark box.
- Export offers MP4 and SRT/VTT only. A journalist may want just the audio (radio, podcast) or the video for social media.

## Goals

1. In an audio-only session, every preview of a clip shows a frame in the clip's shape (16:9 or 9:16) with a waveform that moves with the voice being played, and the subtitles on top where they show today. Places: Prepare's clip preview, the line editor (with the overlay), and the "Change look" dialog.
2. Every made clip can also be downloaded as audio only ("Audio (.m4a)"), for video sessions too.

## Non-goals

Option 3's extras: bar style, title, speaker name and role on screen, square 1:1. They can be added later on top of this.

## Anti-goals

- The preview looking different from the export (other colours, other shape).
- Encoding anything in a web request (the zip stays stored files only).
- A clip's audio offered when its video wouldn't be (the export checklist rules apply the same).

## Approaches considered

1. Audio download and a still waveform picture per clip with a moving playhead. Cheap, but doesn't move with the voice.
2. **Live waveform everywhere and the audio download (picked).** The browser draws the waveform from the audio playing, in the export's look.
3. Audiogram for social media: option 2 plus a designed export (bars, title, speaker, 1:1). Most work, more design choices.

## Design

**Waveform (web).** A `Waveform` client component draws on a `<canvas>` filling the frame. It connects to the player through the Web Audio API (`createMediaElementSource` → `AnalyserNode` → speakers) and, while playing, draws the time-domain samples each frame as a centred line mirrored around the middle (the `cline` look), white on `#17181c`. As built, each column is the average size of its samples (×π/2), which is what the render's waveform looks like at the preview's smaller size; one sample per column looked noisy there. Paused or before play it shows a flat centre line. With `prefers-reduced-motion` it stays flat (subtitles still change). One shared look constant, so the web and the worker's `WAVE_BG` say the same colour. The canvas is `aria-hidden` (the player and the line list are the accessible view).

- Prepare (audio-only clip): the preview becomes the same frame as for video, in the clip's shape, with the waveform and the Play/Stop button; the player has no visible bar.
- Line editor (audio-only): the frame with the waveform, plus `SubtitleOverlay` as for video.
- "Change look" (nothing plays there): a still sample waveform behind the subtitle preview, so the shape and position are judged on the real background.

**Browser rule.** `createMediaElementSource` can be called once per element and then routes its sound through the page's audio context, so the component keeps one context and source per element and resumes the context on the Play click (browsers start it suspended).

**Audio download (worker + Export).** The plain render (`clip.render`) also writes `clips/<clipId>.m4a`: the same cut from the original, AAC 160 kbit/s, `+faststart`. Migration 0039 adds `clips.audio_key` (nullable), set by `finishClipRender` with `render_key` and cleared whenever the render is redone or goes stale (same rule). Export shows "Audio (.m4a)" next to the MP4 for a clip whose render is done and which passes the checklist now (`cleared`), for video and audio sessions. "Download all" gets a fourth choice, "Audio only" (`choice=audio`: the .m4a files), with `check=1` counting them. A clip made before this change (done, no `audio_key`) says on Export that its audio isn't made yet; it counts in the bar's "files to make" and "Make the videos" reruns its render (`claimClipRender` accepts a `done` render without `audio_key`). As built, no separate button.

## Left to the builder

Analyser size and line thickness (match a frame of the export by eye), the exact Export copy, tests: `exportRows` audio rules, the `download` choice, `finishClipRender` setting/clearing `audio_key`, the worker render writing the `.m4a` (in the container). Verify with `digestor-run` on a seeded audio-only `ready` session (16:9 and 9:16, 1280 px and 390 px), and on the owner's uploaded test file only by looking, nothing paid.

Estimate: about 1 working day (7–8 h).
