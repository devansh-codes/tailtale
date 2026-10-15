-- Live airliner snapshot written by GitHub Actions (pipeline/live_snapshot.py) every ~10 minutes.
-- k: "h00".."h31" (by hex), "c00".."c31" (by callsign), "meta". WITHOUT ROWID: one row write per bucket.
CREATE TABLE IF NOT EXISTS live_bucket (
  k TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  data TEXT NOT NULL
) WITHOUT ROWID;
