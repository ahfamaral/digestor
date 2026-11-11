import type { ProfileInput } from "@digestor/core/server";
import type { MonitorLocale } from "@/lib/monitor/i18n";

/** "Bibliotecária · Vereador(a) · Porto Alegre (RS) · 2009–2018, PSOL": profession and earlier mandates, as published. */
export function ProfileLine({ profile }: { locale: MonitorLocale; profile: ProfileInput }) {
  const mandates = profile.externalMandates.map((m) => {
    const place = m.place && m.uf ? `${m.place} (${m.uf})` : m.place || m.uf;
    const years = m.to === null ? `${m.from}–` : m.to === m.from ? `${m.from}` : `${m.from}–${m.to}`;
    return `${[m.office, place, years].filter(Boolean).join(" · ")}${m.party ? `, ${m.party}` : ""}`;
  });
  const parts = [profile.profession, ...mandates].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <p lang="pt-BR" className="text-sm break-words text-muted-foreground">
      {parts.join(" · ")}
    </p>
  );
}
