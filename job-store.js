import { Redis } from "ioredis";
import { postgresStore } from "./postgres-store.js";

const RETENTION_SECONDS = 86400;
const LEASE_MS = 45_000;

export class StorageError extends Error {}

export function jobStore(slug, env) {
  if (env.PULLDATA_RESULTS_DATABASE_URL) return postgresStore(slug, env, StorageError);
  const url = env.SCRAPER_QUEUE_REDIS_URL || env.REDIS_URL;
  const prefix = `marketplace:worker:${env.SCRAPER_QUEUE_NAMESPACE || "local"}:${slug}`;
  const key = (id) => `${prefix}:${id}`;
  const lease = (id) => `${key(id)}:lease`;

  // Connections exist only during a readiness probe or an active job request.
  async function withRedis(operation) {
    if (!url) throw new StorageError("Job storage is unavailable");
    const client = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 1500,
      commandTimeout: 2000,
      retryStrategy: () => null,
    });
    client.on("error", () => {});
    try {
      await client.connect();
      return await operation(client);
    } catch {
      throw new StorageError("Job storage is temporarily unavailable");
    } finally {
      client.disconnect();
    }
  }

  return {
    ready: () => withRedis((client) => client.ping()),
    get: (id) => withRedis(async (client) => JSON.parse(await client.get(key(id)))),
    create: (id, job) => withRedis(async (client) =>
      Boolean(await client.set(key(id), JSON.stringify(job), "EX", RETENTION_SECONDS, "NX"))),
    claim: (id, owner) => withRedis(async (client) =>
      Boolean(await client.set(lease(id), owner, "PX", LEASE_MS, "NX"))),
    save: (id, owner, job) => withRedis(async (client) => Boolean(await client.eval(
      `if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
       local existing = redis.call('GET', KEYS[1])
       if not existing then return 0 end
       local status = cjson.decode(existing).status
       if status == 'done' or status == 'failed' then return 0 end
       redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
       redis.call('PEXPIRE', KEYS[2], ARGV[4])
       return 1`,
      2, key(id), lease(id), owner, JSON.stringify(job), RETENTION_SECONDS, LEASE_MS,
    ))),
    release: (id, owner) => withRedis((client) => client.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end",
      1, lease(id), owner,
    )),
  };
}
