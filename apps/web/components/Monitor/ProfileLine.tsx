import type { ProfileInput } from "@digestor/core/server";
import { tm, type MonitorLocale } from "@/lib/monitor/i18n";

/**
 * The profession and earlier mandates, as published, each labelled: "Profession: Bibliotecária" and "Earlier office:
 * Vereador(a) · Porto Alegre (RS) · 2009–2018, PSOL" (several mandates: "Earlier offices:", separated by ";").
 */
export function ProfileLine({ locale, profile }: { locale: MonitorLocale; profile: ProfileInput }) {
  const mandates = profile.externalMandates.map((m) => {
    const place = m.place && m.uf ? `${m.place} (${m.uf})` : m.place || m.uf;
    const years = m.to === null ? `${m.from}–` : m.to === m.from ? `${m.from}` : `${m.from}–${m.to}`;
    return `${[m.office, place, years].filter(Boolean).join(" · ")}${m.party ? `, ${m.party}` : ""}`;
  });
  if (!profile.profession && mandates.length === 0) return null;
  return (
    <div className="grid text-sm break-words text-muted-foreground">
      {profile.profession && (
        <p>
          {tm(locale, "profile.profession")} <span lang="pt-BR" className="text-foreground">{profile.profession}</span>
        </p>
      )}
      {mandates.length > 0 && (
        <p>
          {tm(locale, mandates.length === 1 ? "profile.earlierOffice" : "profile.earlierOffices")}{" "}
          <span lang="pt-BR" className="text-foreground">{mandates.join("; ")}</span>
        </p>
      )}
    </div>
  );
}
