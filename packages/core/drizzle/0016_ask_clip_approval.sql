INSERT INTO "selections" ("owner_id", "moment_id", "status")
SELECT DISTINCT c.owner_id, m.id, 'approved' FROM "moments" m JOIN "clips" c ON c.moment_id = m.id WHERE m.origin = 'ask' AND c.deleted_at IS NULL
ON CONFLICT DO NOTHING;
