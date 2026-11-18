CREATE TABLE IF NOT EXISTS marketplace_worker_jobs (
  key text PRIMARY KEY,
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  lease_owner text,
  lease_until timestamptz
);

CREATE INDEX IF NOT EXISTS marketplace_worker_jobs_expires_at
  ON marketplace_worker_jobs (expires_at);
