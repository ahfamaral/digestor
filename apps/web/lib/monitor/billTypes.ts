import { billLabel } from "@digestor/core";
import { tm, type MonitorLocale } from "./i18n";

/**
 * Official names of the Câmara's proposition type codes, as published in its open-data reference list
 * (`/referencias/proposicoes/siglaTipo`, read 2026-11-11), for the codes in the 2026 data. Shown in Portuguese, as
 * published; an unknown code shows as is.
 */
export const BILL_TYPE_NAMES: Record<string, string> = {
  "PRL": "Parecer do Relator",
  "RPD": "Requerimento de Retirada da OD de proposições com pareceres favoraveis",
  "REQ": "Requerimento",
  "PL": "Projeto de Lei",
  "PAR": "Parecer de Comissão",
  "RIC": "Requerimento de Informação",
  "DOC": "Documento",
  "EMC": "Emenda na Comissão",
  "SBT": "Substitutivo",
  "INC": "Indicação",
  "PDL": "Projeto de Decreto Legislativo",
  "RDF": "Redação Final",
  "SBT-A": "Substitutivo adotado pela Comissão",
  "PARF": "Parecer de Comissão para Redação Final",
  "EMR": "Emenda de Relator",
  "EMP": "Emenda de Plenário",
  "MSC": "Mensagem",
  "ATA": "Ata",
  "EMC-A": "Emenda Adotada pela Comissão",
  "PRLP": "Parecer Preliminar",
  "DTQ": "Destaque",
  "SBR": "Subemenda de Relator",
  "PLP": "Projeto de Lei Complementar",
  "TVR": "Ato de Concessão e Renovação de Concessão de Emissora de Rádio e Televisão",
  "SBE-A": "Subemenda Adotada pela Comissão",
  "PPP": "Parecer Proferido em Plenário",
  "ESB": "Emenda ao Substitutivo",
  "PRLE": "Parecer Preliminar às Emendas de Plenário",
  "MPV": "Medida Provisória",
  "SIT": "Solicitação de Informação ao TCU",
  "PEP": "Parecer às Emendas de Plenário",
  "PRC": "Projeto de Resolução",
  "VTS": "Voto em Separado",
  "PLN": "Projeto de Lei (CN)",
  "ERD": "Emenda de Redação",
  "OF": "Ofício do Congresso Nacional",
  "RRL": "Relatório do Relator (CMO)",
  "PFC": "Proposta de Fiscalização e Controle",
  "SSP": "Subemenda Substitutiva de Plenário",
  "SUG": "Sugestão",
  "AVN": "Aviso (CN)",
  "PES": "Parecer às Emendas Apresentadas ao Substitutivo do Relator",
  "RPDR": "Requerimento Procedimental Genérico de Sessão/Reunião",
  "CAC": "Comunicado de Alteração do Controle Societário",
  "CVO": "Complementação de Voto",
  "REC": "Recurso",
  "REL": "Relatório de Subcomissão",
  "PLV": "Projeto de Lei de Conversão",
  "PSS": "Parecer às Emendas ou ao Substitutivo do Senado",
  "REP": "Representação",
  "PPR": "Parecer Reformulado de Plenário",
  "INA": "Indicação de Autoridade",
  "PEC": "Proposta de Emenda à Constituição",
  "PROC": "Processo Interno",
  "PRV": "Parecer Vencedor",
  "EMA": "Emenda Aglutinativa",
  "SOR": "Sugestão de Emenda ao Orçamento - Comissões",
  "REL-A": "Relatório Adotado pela Comissão",
  "PRO": "Proposta",
  "RCP": "Requerimento de Instituição de CPI",
  "EMS": "Emenda/Substitutivo do Senado",
  "RLP": "Relatório Prévio",
  "MCN": "Mensagem (CN)",
  "RPL": "Relatório Preliminar",
  "OBJ": "Objeto de Deliberação",
};

export const billTypeName = (code: string): string | null => BILL_TYPE_NAMES[code] ?? null;

/** First words of feminine type names ("a PEC", "a MPV"), for "sobre a …"; everything else reads "sobre o …". */
const FEMININE = new Set(["Proposta", "Medida", "Emenda", "Subemenda", "Indicação", "Mensagem", "Redação", "Sugestão", "Solicitação", "Representação", "Ata"]);

/** Whether a type code's official name is feminine in Portuguese (an unknown code counts as masculine). */
export const billTypeFeminine = (code: string): boolean => FEMININE.has(billTypeName(code)?.split(/[\s/]/)[0] ?? "");

/**
 * A deputy's bill row as listed: "PL 5330/2026"; an item numbered inside its main bill (year 0: an opinion, substitute
 * or amendment) without the year, and with the main bill when known: "PRL 1 on PL 1761/2025" ("PRL 1 sobre o PL
 * 1761/2025"). Never "/0".
 */
export function billRowLabel(locale: MonitorLocale, b: { type: string; number: number; year: number; mainBillLabel?: string | null }): string {
  const item = billLabel(b.type, b.number, b.year);
  const main = b.year > 0 ? null : b.mainBillLabel?.trim();
  if (!main) return item;
  return tm(locale, billTypeFeminine(main.split(" ")[0]!) ? "bills.onMainF" : "bills.onMain", { item, main });
}
