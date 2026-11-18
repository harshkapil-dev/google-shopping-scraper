import { setTimeout as wait } from "node:timers/promises";
import { requestJson, resultLimit, WorkerError } from "./upstream.js";

const api = "https://api.dataforseo.com/v3/merchant/google/products";
const locations = new Map([
  ["US", 2840], ["GB", 2826], ["CA", 2124], ["AU", 2036], ["DE", 2276], ["FR", 2250], ["IN", 2356],
]);
const languages = new Set(["en", "de", "fr"]);
const taskIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function parseInput(body) {
  const allowed = ["query", "country", "language", "max_total_results"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new WorkerError(400, "Unknown input field");
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query || query.length > 250 || /[\x00-\x1f\x7f]/.test(query)) {
    throw new WorkerError(400, "Enter a product search query of up to 250 characters");
  }
  const country = body.country ?? "US";
  const language = body.language ?? "en";
  if (!locations.has(country) || !languages.has(language)) throw new WorkerError(400, "Unsupported country or language");
  return { query, country, language, max_total_results: resultLimit(body.max_total_results ?? 20, 40) };
}

export function sourceReady(env) {
  return Boolean(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD
    && (!env.RAILWAY_SERVERLESS_MODE || env.PULLDATA_WORKER_TOKEN));
}

function readTask(response) {
  if (response?.status_code !== 20000 || response.tasks?.length !== 1 || !Number.isInteger(response.tasks[0]?.status_code)) {
    throw new WorkerError(502, "The Google Shopping data provider rejected the request");
  }
  return response.tasks[0];
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value))) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function httpUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {
    return null;
  }
  return null;
}

function normalizeRows(groups, limit) {
  if (!Array.isArray(groups) || groups.some((group) => !group || !Array.isArray(group.items) && group.items !== null)) {
    throw new WorkerError(502, "The Google Shopping data provider returned unexpected results");
  }
  const rows = [];
  const seen = new Set();
  for (const group of groups) {
    for (const entry of group.items || []) {
      let products;
      if (["google_shopping_sponsored_carousel", "google_shopping_carousel"].includes(entry?.type)) {
        products = Array.isArray(entry.items) ? entry.items : [];
      }
      else if (["google_shopping_serp", "google_shopping_paid"].includes(entry?.type)) products = [entry];
      else continue;
      for (const product of products) {
        const title = text(product?.title);
        if (!title) continue;
        const productId = text(product.product_id) ?? text(product.data_docid) ?? text(product.gid);
        const merchant = text(product.seller);
        const shoppingUrl = httpUrl(product.shopping_url);
        const sellerUrl = httpUrl(product.url);
        const price = number(product.price);
        const identity = JSON.stringify([productId || shoppingUrl || sellerUrl || title.toLowerCase(), merchant]);
        if (seen.has(identity)) continue;
        seen.add(identity);
        const reviews = number(product.reviews_count ?? product.product_rating?.votes_count);
        rows.push({
          position: rows.length + 1,
          product_id: productId,
          title,
          merchant,
          price,
          currency: /^[A-Z]{3}$/.test(product.currency) ? product.currency : null,
          rating: number(product.product_rating?.value),
          reviews: Number.isSafeInteger(reviews) ? reviews : null,
          seller_url: sellerUrl,
          shopping_url: shoppingUrl,
          image_url: (Array.isArray(product.product_images) && httpUrl(product.product_images[0])) || null,
          sponsored: ["google_shopping_paid", "google_shopping_sponsored_carousel"].includes(entry.type),
        });
        if (rows.length === limit) return rows;
      }
    }
  }
  return rows;
}

export async function collect(input, { env, fetcher, signal, job, checkpoint }) {
  const auth = Buffer.from(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`).toString("base64");
  const headers = { authorization: `Basic ${auth}`, accept: "application/json", "content-type": "application/json" };
  let id = job.upstreamTask;
  if (!id) {
    if (job.submitting) throw new WorkerError(502, "The provider task could not be confirmed after an interruption");
    // A task POST can incur a charge even if its response is lost. Never replay it automatically.
    await checkpoint({ submitting: true });
    const task = readTask(await requestJson(`${api}/task_post`, {
      method: "POST", headers, body: JSON.stringify([{
        keyword: input.query,
        location_code: locations.get(input.country),
        language_code: input.language,
        depth: input.max_total_results,
        max_crawl_pages: 1,
        priority: 2,
        search_param: "&udm=28",
      }]),
    }, signal, { fetcher, attempts: 1 }));
    if (task.status_code !== 20100 || !taskIdPattern.test(task.id)) {
      throw new WorkerError(502, "The Google Shopping data provider could not create the task");
    }
    id = task.id;
    await checkpoint({ upstreamTask: id, submitting: false });
  }

  for (let poll = 0; poll < 30; poll += 1) {
    const task = readTask(await requestJson(`${api}/task_get/advanced/${id}`, { headers }, signal, { fetcher }));
    if (task.status_code === 20000) return normalizeRows(task.result, input.max_total_results);
    if (![40601, 40602].includes(task.status_code)) {
      throw new WorkerError(502, "The Google Shopping data provider could not complete the task");
    }
    await checkpoint({});
    await wait(Math.min(5000, 1500 + poll * 500), undefined, { signal });
  }
  throw new WorkerError(504, "The Google Shopping task timed out");
}
