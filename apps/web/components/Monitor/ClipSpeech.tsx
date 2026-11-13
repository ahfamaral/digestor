"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Scissors } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { errorMessage } from "@/lib/http";
import { clipMinutes } from "@/lib/monitor/clip";
import { tm, type MonitorLocale } from "@/lib/monitor/i18n";
import type { VideoMoment } from "@/lib/monitor/video";

/**
 * "Clip this speech": opens the speech's moment in the plenary video (± 20 s) as a new Digestor session, after a
 * confirm dialog, then goes to it. Shown only with `MONITOR_CLIP_ENABLED=true` (`SpeechVideo` says why otherwise).
 */
export function ClipSpeech({ locale, speechKey, video }: { locale: MonitorLocale; speechKey: string; video: VideoMoment }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const minutes = clipMinutes(video);

  async function start() {
    const res = await fetch("/api/monitor/clip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speechKey }),
    });
    if (!res.ok) throw new Error(await errorMessage(res, tm(locale, "clip.failed")));
    const { sessionId } = (await res.json()) as { sessionId: string };
    router.push(`/s/${sessionId}`);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border bg-white px-2.5 py-1 text-sm font-medium outline-none hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-stone-500"
      >
        <Scissors className="size-3.5" aria-hidden />
        {tm(locale, "clip.button")}
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={tm(locale, "clip.confirmTitle")}
        description={minutes === 1 ? tm(locale, "clip.confirmBodyOne") : tm(locale, "clip.confirmBody", { minutes })}
        actionLabel={tm(locale, "clip.confirmAction")}
        busyLabel={tm(locale, "clip.starting")}
        cancelLabel={tm(locale, "clip.cancel")}
        onConfirm={start}
      />
    </>
  );
}
