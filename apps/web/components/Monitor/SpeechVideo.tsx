"use client";

import { useState } from "react";
import { Play, X } from "lucide-react";
import { tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { embedUrl, videoLength, videoPosition, watchUrl, type VideoMoment } from "@/lib/monitor/video";
import { ClipSpeech } from "./ClipSpeech";
import { ExternalLink } from "./ExternalLink";

/**
 * "Watch the speech": the session's official video (the Câmara's YouTube channel) loads only when clicked, in the
 * privacy-enhanced player, from the speech's start to its end; plus a plain link to YouTube at that moment. Nothing
 * from YouTube loads before the click. The button names the speech's length ("Watch the speech · 3:32") and the
 * YouTube link where it starts; `label="at"`: the button names where the video starts ("Watch from 1:18:42": the
 * speech's start, not the quoted sentence; a quoted passage on "Ask the record") and the YouTube link doesn't repeat it.
 * `note`: the line about YouTube's cookies under the button, shown once per list (its first video), not on every row.
 * `clip`: "Clip this speech" into a Digestor session when enabled
 * (`MONITOR_CLIP_ENABLED=true`); when off, a line under the opened player says why (once, where the person looks, not
 * on every row).
 */
export function SpeechVideo(props: SpeechVideoProps) {
  const [open, setOpen] = useState(false);
  return <SpeechVideoView {...props} open={open} onOpenChange={setOpen} />;
}

type SpeechVideoProps = {
  locale: MonitorLocale; video: VideoMoment; label?: "length" | "at"; clip?: { speechKey: string; enabled: boolean }; note?: boolean;
};

/** `SpeechVideo` without its state (exported for tests: the opened player renders on the server too). */
export function SpeechVideoView({
  locale, video, label = "length", clip, note = true, open, onOpenChange: setOpen,
}: SpeechVideoProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const src = embedUrl(video);
  const href = watchUrl(video);
  if (!src || !href) return null;
  const at = videoPosition(video.startS);
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {open ? (
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border bg-white px-2.5 py-1 text-sm font-medium outline-none hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-stone-500"
          >
            <X className="size-3.5" aria-hidden />
            {tm(locale, "speech.hideVideo")}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={tm(locale, "speech.watchLabel", { at })}
            className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border bg-white px-2.5 py-1 text-sm font-medium outline-none hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-stone-500"
          >
            <Play className="size-3.5" aria-hidden />
            {label === "at" ? tm(locale, "speech.watchAt", { at }) : tm(locale, "speech.watch", { length: videoLength(video.endS - video.startS) })}
          </button>
        )}
        {clip?.enabled && <ClipSpeech locale={locale} speechKey={clip.speechKey} video={video} />}
        <ExternalLink href={href} className="text-xs font-medium underline">
          {label === "at" ? tm(locale, "speech.openOnYouTubePlain") : tm(locale, "speech.openOnYouTube", { at })}
        </ExternalLink>
      </div>
      {open ? (
        <>
          <div className="aspect-video w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-black">
            <iframe
              src={src}
              title={tm(locale, "speech.videoFrameTitle", { at })}
              className="size-full"
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
            />
          </div>
          {clip && !clip.enabled && <p className="text-xs text-muted-foreground">{tm(locale, "clip.disabled")}</p>}
        </>
      ) : (
        note && <p className="text-xs text-muted-foreground">{tm(locale, "speech.videoNote")}</p>
      )}
    </div>
  );
}
