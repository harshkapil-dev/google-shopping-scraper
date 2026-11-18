import pg from "pg";

const lease = "interval '32 seconds'";
const retention = "interval '24 hours'";

export function postgresStore(slug, env, StorageError) {
  const connectionString = env.PULLDATA_RESULTS_DATABASE_URL;
  const prefix = `marketplace:worker:${env.SCRAPER_QUEUE_NAMESPACE || "local"}:${slug}`;
  const key = (id) => `${prefix}:${id}`;

  // Open connections only for on-demand work so the compute can suspend.
  async function query(text, parameters = []) {
    const client = new pg.Client({
      connectionString,
      connectionTimeoutMillis: 3000,
      statement_timeout: 2500,
      query_timeout: 3000,
      enableChannelBinding: true,
    });
    client.on("error", () => {});
    try {
      await client.connect();
      return await client.query(text, parameters);
    } catch {
      throw new StorageError("Job storage is temporarily unavailable");
    } finally {
      await client.end().catch(() => {});
    }
  }

  return {
    ready: () => query("SELECT 1 FROM marketplace_worker_jobs LIMIT 1"),
    get: async (id) => (await query(
      "SELECT payload FROM marketplace_worker_jobs WHERE key = $1 AND expires_at > now()",
      [key(id)],
    )).rows[0]?.payload,
    create: async (id, job) => (await query(
      `WITH expired AS (
         SELECT key FROM marketplace_worker_jobs
         WHERE expires_at <= now() AND key <> $1
         ORDER BY expires_at LIMIT 25 FOR UPDATE SKIP LOCKED
       ), discarded AS (
         DELETE FROM marketplace_worker_jobs USING expired WHERE marketplace_worker_jobs.key = expired.key
       )
       INSERT INTO marketplace_worker_jobs (key, payload, expires_at)
       VALUES ($1, $2, now() + ${retention})
       ON CONFLICT (key) DO UPDATE
       SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at, lease_owner = NULL, lease_until = NULL
       WHERE marketplace_worker_jobs.expires_at <= now()`,
      [key(id), job],
    )).rowCount === 1,
    claim: async (id, owner) => (await query(
      `UPDATE marketplace_worker_jobs SET lease_owner = $2, lease_until = now() + ${lease}
       WHERE key = $1 AND expires_at > now() AND (lease_until IS NULL OR lease_until <= now())
       AND payload->>'status' IN ('queued', 'running')`,
      [key(id), owner],
    )).rowCount === 1,
    save: async (id, owner, job) => (await query(
      `UPDATE marketplace_worker_jobs
       SET payload = $3, expires_at = now() + ${retention}, lease_until = now() + ${lease}
       WHERE key = $1 AND lease_owner = $2 AND lease_until > now() AND expires_at > now()
       AND payload->>'status' IN ('queued', 'running')`,
      [key(id), owner, job],
    )).rowCount === 1,
    release: (id, owner) => query(
      "UPDATE marketplace_worker_jobs SET lease_owner = NULL, lease_until = NULL WHERE key = $1 AND lease_owner = $2",
      [key(id), owner],
    ),
  };
}
