// Parliament monitor: a deputy's party history and profile as published by the Câmara (client-safe, no DB).

/** A row of `/deputados/{id}/historico`: `at` is Brasília local time "YYYY-MM-DDTHH:MM"; `status` is `situacao`. */
export type HistoryRow = { at: string; party: string | null; uf: string | null; status: string | null; description: string };
/** An earlier mandate (`/mandatosExternos`), consecutive terms merged: "Vereador(a) · Porto Alegre (RS) · 2009–2018". */
export type ExternalMandate = { office: string; place: string; uf: string | null; from: number; to: number | null; party: string | null };
/** A seat in a body (`/orgaos`): `title` as published ("Titular", "Presidente"…); days. */
export type Position = { body: string; bodyName: string; title: string; from: string; to: string | null };
