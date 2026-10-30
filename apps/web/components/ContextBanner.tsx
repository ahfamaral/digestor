import { type ContextCard } from "@digestor/core";
import { t } from "@/lib/i18n";

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** One-line summary of the context card above the briefing: profile · language · date · setting · title. */
export function ContextBanner({ card }: { card: ContextCard }) {
  const parts = [
    t(`profile.${card.profile.value}`),
    card.language.value && languageName(card.language.value),
    card.dateOrYear.value,
    card.setting.value,
    card.title.value,
  ].filter((p): p is string => Boolean(p?.trim()));

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-white px-3 py-2 text-sm">
      <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[11px] font-semibold text-purple-800">{t("context.bannerLabel")}</span>
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden className="text-muted-foreground">·</span>}
          <span>{p}</span>
        </span>
      ))}
    </div>
  );
}
