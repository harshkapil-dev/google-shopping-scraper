import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { createWorker } from "./server.js";
import { parseInput } from "./source.js";
import { requestJson } from "./upstream.js";
import { createFixture } from "./source.fixture.js";

const output = JSON.parse(readFileSync(new URL("./pulldata.output.schema.json", import.meta.url)));
const manifest = JSON.parse(readFileSync(new URL("./pulldata.scraper.json", import.meta.url)));
const smoke = manifest.smokeTest.input;

const records = new Map();
const owners = new Map();
const store = {
  ready: async () => {},
  get: async (id) => structuredClone(records.get(id)),
  create: async (id, job) => {
    if (records.has(id)) return false;
    records.set(id, structuredClone(job));
    return true;
  },
  claim: async (id, owner) => {
    if (owners.has(id)) return false;
    owners.set(id, owner);
    return true;
  },
  save: async (id, owner, job) => {
    if (owners.get(id) !== owner || ["done", "failed"].includes(records.get(id)?.status)) return false;
    records.set(id, structuredClone(job));
    return true;
  },
  release: async (id, owner) => {
    if (owners.get(id) === owner) owners.delete(id);
  },
};

let listener;
let base;
const fixture = createFixture();
const { app, stop } = createWorker({
  store,
  env: { ...fixture.env, PULLDATA_WORKER_TOKEN: "local-placeholder" },
  fetcher: fixture.fetcher,
});

before(async () => {
  listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;
});
after(() => {
  stop();
  return new Promise((resolve) => listener.close(resolve));
});

async function call(path, body, authorization = "Bearer local-placeholder") {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", authorization },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.match(response.headers.get("content-type"), /^application\/json/);
  return { code: response.status, body: await response.json() };
}

async function finished(id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { body } = await call(`/job/${id}`);
    if (["done", "failed"].includes(body.status)) return body;
    await wait(15);
  }
  assert.fail("Job did not finish");
}

function validateRows(rows) {
  const keys = output.columns.map((column) => column.key).sort();
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), keys);
    for (const { key, type } of output.columns) {
      const value = row[key];
      if (value === null) continue;
      if (type === "url") assert.match(value, /^https?:\/\//);
      else if (type === "datetime") assert.equal(new Date(value).toISOString(), value);
      else if (type === "integer") assert.ok(Number.isSafeInteger(value));
      else assert.equal(typeof value, type);
    }
  }
}

test("health, readiness, authentication, sync and paginated async routes", async () => {
  assert.equal((await call("/health", undefined, "")).code, 200);
  assert.equal((await call("/ready")).code, 200);
  assert.equal((await call("/ready", undefined, "")).code, 401);
  assert.equal((await call("/scrape", smoke, "")).code, 401);

  const sync = await call("/scrape-sync", smoke);
  assert.equal(sync.code, 200);
  assert.equal(sync.body.status, "done");
  assert.equal(sync.body.total, 3);
  validateRows(sync.body.results);

  const request = { ...smoke, run_id: "repeatable-test", effective_max_total_results: 2 };
  const started = await call("/scrape", request);
  assert.equal(started.body.status, "queued");
  const url = `/job/${started.body.job_id}`;
  assert.deepEqual(await finished(started.body.job_id), { ...started.body, status: "done", total: 2 });
  const first = await call(`${url}/results?offset=0&limit=1`);
  const second = await call(`${url}/results?offset=1&limit=1`);
  assert.equal(first.body.total, 2);
  assert.equal(second.body.total, 2);
  assert.deepEqual([...first.body.results, ...second.body.results], sync.body.results.slice(0, 2));
  assert.deepEqual(await call(`${url}/results?offset=2&limit=1`), { code: 200, body: { total: 2, results: [] } });
  assert.equal((await call(`${url}/results?offset=-1`)).code, 400);
  assert.equal((await call(`${url}/results?limit=1001`)).code, 400);

  const repeat = await call("/scrape", request);
  assert.deepEqual(repeat.body, { ...started.body, status: "done" });
  assert.equal((await call("/scrape", { ...request, query: "different" })).code, 409);
});

test("rejects invalid input and enforces input limits before upstream work", async () => {
  const fields = JSON.parse(readFileSync(new URL("./pulldata.config.schema.json", import.meta.url))).fields;
  const max = fields.find((field) => field.key === "max_total_results").max;
  assert.equal(parseInput({ ...smoke, max_total_results: max }).max_total_results, max);
  for (const payload of [{}, [], { ...smoke, query: " " }, { ...smoke, extra: true },
    { ...smoke, max_total_results: 0 }, { ...smoke, max_total_results: max + 1 }]) {
    assert.equal((await call("/scrape-sync", payload)).code, 400);
  }
  const malformed = await fetch(base + "/scrape-sync", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer local-placeholder" },
    body: "{unvalidated-request",
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "Invalid JSON input" });
});

test("empty results are successful and upstream errors are safe", async () => {
  const empty = await call("/scrape-sync", { ...smoke, query: "missing.example" });
  assert.deepEqual(empty, { code: 200, body: { status: "done", total: 0, results: [] } });
  const error = await call("/scrape-sync", { ...smoke, query: "denied.example" });
  assert.deepEqual(error, { code: 502, body: { error: "The upstream denied access" } });

  const failed = await call("/scrape", { ...smoke, query: "denied.example" });
  assert.deepEqual(await finished(failed.body.job_id), {
    job_id: failed.body.job_id, status: "failed", total: 0, error: "The upstream denied access",
  });
});

test("bounds rate limit retries, propagates job timeout, and never exposes response text", async () => {
  const url = "https://example.test/data";
  let attempts = 0;
  const fetcher = async () => {
    attempts += 1;
    return new Response("private upstream details", { status: 429 });
  };
  await assert.rejects(requestJson(url, {}, new AbortController().signal, { fetcher, attempts: 2 }),
    { status: 503, message: "The upstream is rate limited" });
  assert.equal(attempts, 2);

  const hanging = (_url, { signal }) => wait(1000, undefined, { signal });
  await assert.rejects(requestJson(url, {}, AbortSignal.timeout(10), { fetcher: hanging }), { name: "TimeoutError" });
});
