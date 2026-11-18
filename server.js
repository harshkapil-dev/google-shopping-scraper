import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import { redisStore, StorageError } from "./job-store.js";
import { collect, parseInput, sourceReady } from "./source.js";
import { WorkerError } from "./upstream.js";

const manifest = JSON.parse(readFileSync(new URL("./pulldata.scraper.json", import.meta.url)));
const { slug } = manifest;
const timeoutMs = manifest.smokeTest.timeoutSeconds * 1000 - 5000;
const maxActive = 2;
const activeStatus = new Set(["queued", "running"]);
const platformFields = new Set([
  "source", "run_id", "request_id", "user_id", "queue_namespace", "callback_url",
  "effective_max_total_results", "affordable_rows_at_start", "affordable_rows_at_dispatch",
  "available_credits_at_start", "wallet_balance_cents_at_start", "wallet_balance_cents_at_dispatch",
  "wallet_reserved_cents_at_start", "wallet_reserved_cents_at_dispatch",
  "wallet_unreserved_cents_at_start", "wallet_unreserved_cents_at_dispatch", "wallet_concurrency_mode",
  "max_leads_per_query", "scrape_emails", "custom_fields", "task_name",
]);

function log(event, id) {
  console.log(JSON.stringify({ scraper_slug: slug, job_id: id, event }));
}

function safeError(error) {
  if (error instanceof WorkerError) return error;
  if (error instanceof StorageError) return new WorkerError(503, error.message);
  if (error.name === "TimeoutError" || error.cause?.name === "TimeoutError") return new WorkerError(504, "The scrape timed out");
  if (error.type === "entity.parse.failed") return new WorkerError(400, "Invalid JSON input");
  if (error.type === "entity.too.large") return new WorkerError(413, "Request is too large");
  return new WorkerError(500, "The scrape could not be completed");
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new WorkerError(400, "A JSON input object is required");
  }
  const identity = body.run_id ?? body.request_id;
  if (identity !== undefined && (typeof identity !== "string" || !identity || identity.length > 128)) {
    throw new WorkerError(400, "Invalid run identifier");
  }
  const input = parseInput(Object.fromEntries(Object.entries(body).filter(([key]) => !platformFields.has(key))));
  if (body.effective_max_total_results !== undefined) {
    const cap = body.effective_max_total_results;
    if (!Number.isSafeInteger(cap) || cap < 1) throw new WorkerError(400, "Invalid effective result limit");
    input.max_total_results = Math.min(input.max_total_results, cap);
  }
  return {
    id: identity === undefined ? randomUUID() : hash(`${slug}:${identity}`),
    input,
    fingerprint: hash(JSON.stringify(input)),
  };
}

function pageParameter(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d{1,7}$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new WorkerError(400, "Invalid results pagination");
  }
  return Number(value);
}

export function createWorker({ env = process.env, store = redisStore(slug, env), fetcher = fetch } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  const tasks = new Map();
  const shutdown = new AbortController();
  let syncActive = 0;

  function canStart() {
    return !shutdown.signal.aborted && tasks.size + syncActive < maxActive;
  }

  async function run(job) {
    const owner = randomUUID();
    const { id } = job;
    if (!await store.claim(id, owner)) return;
    try {
      job = await store.get(id);
      if (!job || !activeStatus.has(job.status)) return;

      const save = async (changes) => {
        const updated = { ...job, ...changes };
        if (!await store.save(id, owner, updated)) throw new StorageError("Job lease is unavailable");
        job = updated;
      };

      try {
        if (job.deadline <= Date.now()) throw new WorkerError(504, "The scrape timed out");
        await save({ status: "running" });
        log("running", id);
        const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, job.deadline - Date.now())), shutdown.signal]);
        const results = await collect(job.input, { env, fetcher, signal, job, checkpoint: save });
        await save({ status: "done", results, cursor: null, upstreamTask: null, input: null });
        log("done", id);
      } catch (error) {
        if (shutdown.signal.aborted || error instanceof StorageError) return;
        await save({ status: "failed", error: safeError(error).message, cursor: null, upstreamTask: null, input: null });
        log("failed", id);
      }
    } finally {
      await store.release(id, owner);
    }
  }

  function start(job) {
    if (!activeStatus.has(job.status) || !canStart() || tasks.has(job.id)) return;
    const task = run(job).catch(() => log("storage_unavailable", job.id)).finally(() => tasks.delete(job.id));
    tasks.set(job.id, task);
  }

  function requireSource() {
    if (!sourceReady(env)) throw new WorkerError(503, "The upstream is not configured");
  }

  async function readJob(id) {
    if (!/^(?:[a-f\d-]{36}|[a-f\d]{64})$/.test(id)) throw new WorkerError(404, "Job not found");
    const job = await store.get(id);
    if (!job) throw new WorkerError(404, "Job not found");
    start(job);
    return job;
  }

  app.get("/health", (_req, res) => res.json({ ok: true }));

  const matches = (actual, expected) => timingSafeEqual(
    Buffer.from(hash(actual || ""), "hex"),
    Buffer.from(hash(expected), "hex"),
  );

  app.use((req, res, next) => {
    const token = env.PULLDATA_WORKER_TOKEN;
    const internal = env.INTERNAL_API_SECRET;
    const workerAuthorized = token && matches(req.get("authorization"), `Bearer ${token}`);
    const platformAuthorized = internal && matches(req.get("x-internal-secret"), internal);
    if (token && !workerAuthorized && !platformAuthorized) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  });

  app.get("/ready", async (_req, res) => {
    requireSource();
    await store.ready();
    res.json({ ready: true });
  });

  app.post("/scrape-sync", async (req, res) => {
    const { input, id } = parseRequest(req.body);
    requireSource();
    if (!canStart()) throw new WorkerError(503, "The worker is busy");
    syncActive += 1;
    try {
      log("sync_running", id);
      const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), shutdown.signal]);
      const results = await collect(input, { env, fetcher, signal, job: { results: [] }, checkpoint: async () => {} });
      log("sync_done", id);
      res.json({ status: "done", total: results.length, results });
    } finally {
      syncActive -= 1;
    }
  });

  app.post("/scrape", async (req, res) => {
    const { input, id, fingerprint } = parseRequest(req.body);
    requireSource();
    let job = await store.get(id);
    if (!job) {
      if (!canStart()) throw new WorkerError(503, "The worker is busy");
      const candidate = { id, input, fingerprint, status: "queued", results: [], deadline: Date.now() + timeoutMs };
      job = await store.create(id, candidate) ? candidate : await store.get(id);
      if (!job) throw new StorageError("Job storage is temporarily unavailable");
    }
    if (job.fingerprint !== fingerprint) throw new WorkerError(409, "Run identifier already exists with different input");
    start(job);
    res.json({ job_id: id, status: job.status });
  });

  app.get("/job/:jobId", async (req, res) => {
    const job = await readJob(req.params.jobId);
    res.json({ job_id: job.id, status: job.status, total: job.results.length, ...(job.error && { error: job.error }) });
  });

  app.get("/job/:jobId/results", async (req, res) => {
    const offset = pageParameter(req.query.offset, 0, 0, 10000);
    const limit = pageParameter(req.query.limit, 25, 1, 1000);
    const job = await readJob(req.params.jobId);
    res.json({ total: job.results.length, results: job.results.slice(offset, offset + limit) });
  });

  app.use((_req, res) => res.status(404).json({ error: "Route not found" }));
  app.use((error, _req, res, _next) => {
    const safe = safeError(error);
    res.status(safe.status).json({ error: safe.message });
  });
  return { app, stop: () => shutdown.abort() };
}

if (process.env.NODE_ENV !== "test") {
  const worker = createWorker();
  const listener = worker.app.listen(Number(process.env.PORT || 8080), "0.0.0.0");
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
      worker.stop();
      listener.close();
    });
  }
}
