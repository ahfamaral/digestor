# Câmara monitor fixtures

Recorded 2026-11-11 from the Câmara open data (no key, `Accept: application/json`), then trimmed. Deputies' e-mail
fields blanked; long `transcricao` cut at 1,500 characters with "[trimmed]".

| File | Source |
|---|---|
| `deputados-2026.recorded.json` | `GET https://dadosabertos.camara.leg.br/api/v2/deputados?dataInicio=2026-02-01&dataFim=2026-11-11&itens=100&ordem=ASC&ordenarPor=nome`, page 1 trimmed to 2 deputies; its `next` link (pagina=2) kept |
| `deputados-2026-p2.recorded.json` | the same list, page 3 (the one holding 204407 Fernanda Melchionna), trimmed to her, `next` removed: served as "page 2" in tests |
| `deputados-em-exercicio.recorded.json` | `GET …/deputados?itens=100&ordem=ASC&ordenarPor=nome` (deputies in office today), trimmed to 204407 and 204379, `next` removed |
| `discursos-204407.recorded.json` | `GET …/deputados/204407/discursos?dataInicio=2026-02-01&dataFim=2026-11-11&itens=100&ordenarPor=dataHoraInicio&ordem=ASC` (48 speeches, no `next`), trimmed to 4, one with an empty `transcricao` (not transcribed yet) |
| `proposicao-2462009.recorded.json` | `GET …/proposicoes/2462009` (PL 3880/2024) |
| `proposicoes-PL-3880-2024.recorded.json`, `proposicoes-PL-2942-2024.recorded.json` | `GET …/proposicoes?siglaTipo=PL&numero=…&ano=2024` |
| `votacoes-2026.excerpt.csv`, `votacoesObjetos-2026.excerpt.csv`, `votacoesVotos-2026.excerpt.csv` | `https://dadosabertos.camara.leg.br/arquivos/{kind}/csv/{kind}-2026.csv` (5, 15 and 18 MB; `;`, BOM, all fields quoted, LF), rows of votações 2449741-72 (PL 2942/2024), 2462009-57 (PL 3880/2024), 2600277-9 (urgency request, no objects, `ultimaApresentacaoProposicao_idProposicao` 0), 2601223-8 (urgency request with one object, REQ 284/2026), 2555417-29 (symbolic plenary vote), 2622112-4 (committee vote whose `descricao` has CRLF line breaks); votes cut to 204407, 204379 and a few others per roll call. Re-written with Python's csv module (same columns and quoting) |
| `historico-204407.recorded.json` | `GET …/deputados/204407/historico` (6 rows, all PSOL: legislature 57's two, three of legislature 56 and one labelled legislature 58 dated 2023-02-01; `fetchHistory` keeps 57's) |
| `historico-220576.recorded.json` | `GET …/deputados/220576/historico` (Alfredo Gaspar: 3 rows, UNIÃO → PL on 2026-04-29) |
| `historico-73806.recorded.json` | `GET …/deputados/73806/historico` (Roseana Sarney, the deputy with leave: 20 rows, `situacao` "Licença" (Secretário de Estado, health leave) and "Exercício"; the last row is a PFL row of legislature 49 dated 2023-02-01, which `fetchHistory` drops) |
| `profissoes-204407`, `mandatosExternos-204407`, `frentes-204407`, `orgaos-204407` `.recorded.json` | `GET …/deputados/204407/{profissoes, mandatosExternos, frentes, orgaos?dataInicio=2023-02-01&itens=100}` (fronts: 165, legislatures 56 and 57; bodies: 40, one page) |
| `votacoesOrientacoes-2026.excerpt.csv` | bulk file (0.45 MB): the guidance rows of 2449741-72 and 2462009-57 (13 each, some with an empty `orientacao`) |
| `eventos-2026.excerpt.csv` | bulk file (1.1 MB): sessions 83243 and 83188 ("Sessão Deliberativa", Encerrada), 82553 (Cancelada) and committee meeting 80841 ("Reunião Deliberativa") |
| `eventosPresencaDeputados-2026.excerpt.csv` | bulk file (10 MB): presence at those events cut to 204407 (83243, 83188, 80841) and 220576 |
| `proposicoes-2026.excerpt.csv` | bulk file (44 MB): 2600034 RCP 1/2026, 2646307 PL 5330/2026 (204407 first author), 2599885 PL 1/2026 (presented in January), 2652548 EMC-A 2 (a committee amendment, `ano` 0) |
| `proposicoesAutores-2026.excerpt.csv` | bulk file (16 MB): first author, one co-author and 204407 (signature 49) of 2600034, the committee author of 2652548, 204407 on 2646307, the Executive on 2599885 |

The second group was recorded 2026-11-11 14:40–14:50 the same way; the five bulk excerpts re-written with Python's csv module.

Real-data notes (whole 2026 files): 126 plenary roll calls of 1,575 plenary votações; 36 have no main bill among their
objects (urgency requests, appeals), 11 of them no objects at all; vote labels are `Sim`, `Não`, `Abstenção`,
`Obstrução`, `Artigo 17` and `""` (466 rows).

- `evento-82635.recorded.json` (recorded 2026-11-12): `GET /api/v2/eventos/82635`, the plenary of 30 Jun 2026; its
  `urlRegistro` is the session's official YouTube video (the video-evidence job reads only that field).
