-- Ten-minute counts of aircraft per ICAO type, written by the cron trigger.
-- n = airborne (seen and not on the ground), total = all aircraft of the type currently seen.
CREATE TABLE IF NOT EXISTS type_counts (
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  n INTEGER NOT NULL,
  total INTEGER
);
CREATE INDEX IF NOT EXISTS idx_type_counts_type_ts ON type_counts (type, ts);

CREATE TABLE IF NOT EXISTS cron_runs (
  ts INTEGER PRIMARY KEY,
  grp TEXT,
  ok INTEGER NOT NULL,
  types INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  ms INTEGER NOT NULL
);
-- Latest-slot lookups for the home page (SELECT ... WHERE ts >= MAX(ts) - 600) must not scan the table.
CREATE INDEX IF NOT EXISTS idx_type_counts_ts ON type_counts (ts);
