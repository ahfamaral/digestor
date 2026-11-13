/**
 * Words left out of "Words used more than the chamber" (`refreshWordCounts`): the plenary's procedure and courtesy, the
 * Câmara's stock phrases, stage directions, and the Portuguese function words that `pt_unaccent` keeps because the
 * accent is removed before its stopword list is checked ("não", "também", "você"). Written as words: Postgres stems them
 * with the same `pt_unaccent` config as the speeches, so "deputado", "deputada" and "deputados" all drop one stem.
 * Stems shorter than 3 letters and anything with a digit are dropped separately.
 */
export const MONITOR_STOPLIST: readonly string[] = [
  // Procedure and courtesy
  "presidente", "presidenta", "presidência", "senhor", "senhora", "senhores", "senhoras", "sr", "sra", "srs", "sras",
  "deputado", "deputada", "deputados", "deputadas", "excelência", "excelências", "vossa", "exa", "nobre", "colega",
  "colegas", "parlamentar", "parlamentares", "sessão", "sessões", "palavra", "tempo", "minuto", "minutos", "orador",
  "oradora", "obrigado", "obrigada", "câmara", "plenário", "casa", "requerimento", "requerimentos", "votação", "votações",
  "ordem", "pauta", "matéria", "item", "encaminhamento", "encaminhar", "orientação", "orienta", "oriento", "orientar",
  "liderança", "líder", "bloco", "aparte", "concedo", "conceder", "tribuna", "pronunciamento", "discurso", "microfone",
  "interrupção", "inscrito", "inscrita", "inscrição", "regimento", "regimental", "questão", "expediente", "voto",
  "votos", "votar", "votamos", "nominal", "texto", "proposição", "preside", "presidir", "presidindo",
  // Stock phrases: "solicito a divulgação nos meios de comunicação da Casa e no programa A Voz do Brasil"
  "registrar", "registro", "solicito", "solicitar", "divulgação", "divulgado", "divulgar", "meios", "programa", "voz",
  "cumprimentar", "cumprimento", "parabenizar", "parabéns", "agradecer", "agradeço", "saudar", "saúdo", "pronuncia",
  "seguinte", "íntegra", "encaminhado", "taquigráfico", "revisão",
  // Stage directions
  "pausa", "palmas", "risos", "apupos", "manifestação", "manifestações", "tumulto",
  // Function words, filler and very common verbs
  "não", "também", "até", "está", "estão", "estava", "você", "vocês", "então", "após", "têm", "são", "será", "serão",
  "seria", "seriam", "teria", "aqui", "ali", "aí", "todo", "toda", "todos", "todas", "tudo", "fazer", "faz", "fez",
  "feito", "pode", "podem", "poder", "possa", "ser", "ter", "tem", "tinha", "porque", "porquê", "vai", "vão", "vamos",
  "hoje", "agora", "ainda", "diz", "dizer", "disse", "falar", "fala", "falou", "desse", "dessa", "deste", "desta", "neste",
  "nesta", "nesse", "nessa", "outro", "outra", "outros", "outras", "esta", "este", "sobre", "muito", "muita", "muitos",
  "muitas", "deve", "devem", "dever", "bem", "apenas", "inclusive", "cada", "quero", "queremos", "querem", "gostaria",
  "gente", "aqueles", "aquelas", "aquele", "aquela", "sempre", "nunca", "nada", "coisa", "coisas", "assim", "lado",
  "dia", "dias", "vez", "vezes", "momento", "exatamente", "realmente", "simplesmente", "efetivamente", "verdade",
  "sabe", "sabemos", "saber", "precisa", "precisamos", "precisar", "fica", "ficar", "dar", "dá", "der", "veio", "vir",
  "ver", "vejo", "estar", "estamos", "isto", "isso", "aquilo", "onde", "quando", "quanto", "lá", "cá", "mesmo", "mesma",
  "qualquer", "algum", "alguma", "alguns", "algumas", "nenhum", "nenhuma", "ninguém", "alguém", "certo", "claro",
  "quer", "querer", "acho", "achar", "acha", "acham", "olha", "olhe", "ok", "sim", "obviamente", "absolutamente",
  "importante", "vou", "parte", "lembrar", "lembro", "próprio", "própria",
];
