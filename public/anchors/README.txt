OpenTimestamps proofs of the Commons log head (GET /api/log). File <N>.ots = proof that h of row N-1 (log seq N-1) existed at stamp time, as first written by the daily cron (calendar-pending). <N>.confirmed.ots = same, upgraded with a Bitcoin attestation (different bytes, different sha256).
Verify: ots verify -d <head> <N>.ots, then check GET /api/log?from=N-1&limit=1 has that h.
