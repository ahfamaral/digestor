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

Real-data notes (whole 2026 files): 126 plenary roll calls of 1,575 plenary votações; 36 have no main bill among their
objects (urgency requests, appeals), 11 of them no objects at all; vote labels are `Sim`, `Não`, `Abstenção`,
`Obstrução`, `Artigo 17` and `""` (466 rows).
