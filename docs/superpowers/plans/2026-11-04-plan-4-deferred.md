# Plan 4: deferred items

Copied from the Plan 4 SDD ledger (git-ignored) on 2026-11-05, after Task 12 merged. Minor items accepted during review, plus open follow-ups. None blocks the current work.

## Follow-ups

- Task 1: ⚠️ US congress.gov URL shape unverified (403 to curl) — accepted as given; evidence URL only, not fetched
- Task 10: ⚠️ dismissed suggestion protected only because download runs once — note for Task 11/final review.
- Task 9: ⚠️ Senate labels/chamber S unverified (pro forma day only) → add to scripts/smoke.md in Task 12; package-partial publication assumption unverified
- Task 12: ⚠️ follow-up: for a non-evaluated house, transcript-proposed and record persons of the same name are separate rows → conflict → unnamed (Bundestag scored 0% before evaluated:true). Merge by name in the record step; affects US Senate now. FIXED (branch fix-duplicate-persons).
- Task 12: deferred: US connector matches the reading clerk's bill-title reading to the sponsor; chair (Bundestag Vizepräsident, no MdB id) never named.

## Minor (deferred)

- Task 1: minor (deferred): titles doc comment says lower-case/no dot but DE/US lists capitalised with dots (consumer must normalise — Tasks 3/7/9 to note)
- Task 1: minor (deferred): Bundestag "P/N" accepts any period >0 (e.g. 99/5)
- Task 1: minor (deferred): naming.ts placeholder for houses without connector throws a plain Error (transient → retry) — Task 3 replaces it with connectorFor; carry to Task 3 dispatch
- Task 1: minor (deferred): recordInputError looks only at first token; misses music.youtube.com; duplicates YOUTUBE_HOSTS from youtubeUrl.ts
- Task 1: minor (deferred): THRESHOLDS shared mutable object across houses (freeze)
- Task 1: minor (deferred): parity test lacks "Senado link without date under camara → null"
- Task 2: minor (deferred): linked_at mixes clocks (DB now() default vs process new Date() on change) — carry to Task 6 (window counted from linkedAt): use sql`now()`
- Task 2: minor (deferred): RecordStatus doc comment stale (no suggested/waiting)
- Task 2: minor (deferred): claim test can't fail on this change; backfill untested; SQL file no trailing newline
- Task 3: minor (deferred) M1: Senado members fetched for every day's speaker (plan-mandated) — new transient failure mode on unmatched speakers. Ruling: accept for now (free API, http retry + job retry, identical names) — cost if wrong: occasional extra retries on 429s; revisit (lazy members / lower concurrency) if seen.
- Task 3: minor M5: no web test for Câmara evidence carrying chamber — deferred.
- Task 4: minor (deferred): M2 test can't catch a revert (assert no person upsert, or propose < 0.35)
- Task 4: minor (deferred): situacao/PLEN predicates written twice (camara.ts:186-190 vs 100-102) → carry to Task 6 (waiting mapping edits both)
- Task 4: minor (deferred): merge test can't fail (81818 deputies subset of 82635)
- Task 4: minor (deferred): cross-event tiebreak compares n as text (localeCompare)
- Task 4: minor (deferred): CAMARA_NOT_COMPLETE wording "of this session" on a day ref → Task 6 checks wording
- Task 4: minor (deferred): memo assumes string URLs; ~500 bodies in memory per day — fine
- Task 5: minor (deferred): holdsLink misses scheme-less links (cosmetic)
- Task 5: minor (deferred): select doesn't return to remembered house after link removed
- Task 5: minor (deferred): no test that help examples parse; unused upload.recordHelp key; role kept first in person line (accepted)
- Task 5: minor (deferred): Who's who input placeholder truncates at 390 px ('…official rec')
- Task 5: minor (deferred): names.record.house key unused (dead copy)
- Task 6: minor (deferred): future dates treated as within window (wait until date+window); copy "check the date" for event links; weak linked_at clock test; empty-vs-empty attribution assert; per-row try/catch in retry handler
- Task 6: minor (deferred): event date carried via module WeakMap keyed by error (sound; Object.assign property simpler); waiting row without chamber renders as failed
- Task 7: minor (deferred): BODY_CLASSES J/J_1/O only (log unknown klasse); "Sitzungsleitung" fallback label for id-less redner
- Task 7: minor (deferred): WP20/19 list ids unrecorded/untested; DIP field names unverified live; stray space in parseListing
- Task 10: minor (deferred): sittingOnly redundant chamber param; past law dates in text can still mislead (first date wins)
- Task 10: minor (deferred): stale "title or description" comments in chambers.ts; consider Regierungsbefragung/Fragestunde/Aktuelle Stunde as Bundestag title sitting words (recall)
- Task 11: minor (deferred): late node + names job can both run the same record (harmless, identical writes; spec sentence about CAS not literal); no busy feedback on buttons; test titled Continue uses skip; dead suggested branch in RecordStatusLine; chamber ?? "senado" silent default
- Task 11: minor (deferred): stale wantFocus may steal focus later; top copy disappears on accept with no confirmation at the top (pending shows only in Who's who); a never-continued session keeps a pending row (harmless)
