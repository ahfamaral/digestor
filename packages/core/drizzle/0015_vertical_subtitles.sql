UPDATE "subtitle_tracks" t SET "burn_status" = 'stale' FROM "clips" c WHERE c.id = t.clip_id AND c.format = '9:16' AND t.burn_status = 'done';
