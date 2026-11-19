import { randomInt } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { load } from "cheerio";
import { proxyClient, proxyUrl } from "./proxy.js";
import { resultLimit, WorkerError } from "./upstream.js";

const google = "https://www.google.com";
const countries = new Set(["US", "GB", "CA", "AU", "DE", "FR", "IN"]);
const languages = new Set(["en", "de", "fr"]);
const maxHtmlBytes = 4_000_000;
const maxBrowserBytes = 5_000_000;

export function parseInput(body) {
  const allowed = ["query", "country", "language", "max_total_results"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new WorkerError(400, "Unknown input field");
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query || query.length > 250 || /[\x00-\x1f\x7f]/.test(query)) {
    throw new WorkerError(400, "Enter a product search query of up to 250 characters");
  }
  const country = body.country ?? "US";
  const language = body.language ?? "en";
  if (!countries.has(country) || !languages.has(language)) throw new WorkerError(400, "Unsupported country or language");
  return { query, country, language, max_total_results: resultLimit(body.max_total_results ?? 20, 40) };
}

export function privateTrawlUrl(value) {
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
        url.pathname === "/" && !url.search && !url.hash &&
        (["localhost", "127.0.0.1", "host.docker.internal"].includes(url.hostname) ||
          url.hostname.endsWith(".railway.internal"))) return url.origin;
  } catch { /* Report invalid configuration without its value. */ }
  throw new WorkerError(503, "The private Shopping browser is not configured");
}

export function sourceReady(env) {
  try { privateTrawlUrl(env.GOOGLE_SHOPPING_TRAWL_BASE_URL); return true; }
  catch { return false; }
}

function searchUrl(query, input) {
  const url = new URL("/search", google);
  url.search = new URLSearchParams({ udm: "28", q: query, hl: input.language, gl: input.country.toLowerCase() }).toString();
  return url.href;
}

function cleanText(value) {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : null;
}

function httpUrl(value) {
  if (!value || value.startsWith("data:")) return null;
  try {
    const url = new URL(value, google);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Ignore invalid links. */ }
  return null;
}

function priceAndCurrency(value, country) {
  const match = (value || "").match(/(?:US|CA|AU)?\s*([$£€₹])\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!match) return [null, null];
  const currency = { "$": { US: "USD", CA: "CAD", AU: "AUD" }[country] || "USD", "£": "GBP", "€": "EUR", "₹": "INR" }[match[1]];
  return [Number(match[2].replaceAll(",", "")), currency];
}

export function parseShoppingHtml(html, input) {
  if (typeof html !== "string" || Buffer.byteLength(html) > maxHtmlBytes) {
    throw new WorkerError(502, "Google Shopping returned an invalid page");
  }
  const $ = load(html);
  const rows = [];
  const seen = new Set();
  $("g-inner-card").each((_index, element) => {
    if (rows.length >= input.max_total_results) return false;
    const card = $(element);
    const title = cleanText(card.find(".gkQHve").first().text()) ||
      cleanText(card.find("[role=img][title]").first().attr("title"));
    if (!title) return;
    const merchant = cleanText(card.find(".WJMUdc").first().text());
    const [price, currency] = priceAndCurrency(card.find("[aria-label^='Current Price:']").first().attr("aria-label") || card.text(), input.country);
    const productId = cleanText(card.attr("data-docid") || card.attr("data-product-id"));
    const productLink = httpUrl(card.find("a[href*='/shopping/product/']").first().attr("href"));
    const identity = productId || productLink || `${title.toLowerCase()}|${merchant?.toLowerCase() || ""}|${price ?? ""}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const ratingMatch = (cleanText(card.text()) || "").match(/\b([0-5](?:\.\d)?)\s*\(([\d,.]+)([KM]?)\)/i);
    const reviewValue = ratingMatch && Number(ratingMatch[2].replaceAll(",", "")) *
      ({ K: 1000, M: 1_000_000 }[ratingMatch[3].toUpperCase()] || 1);
    rows.push({
      position: rows.length + 1,
      product_id: productId,
      title,
      merchant,
      price,
      currency,
      rating: ratingMatch ? Number(ratingMatch[1]) : null,
      reviews: Number.isSafeInteger(reviewValue) ? reviewValue : null,
      seller_url: httpUrl(card.find("a[href^='http']:not([href*='google.com'])").first().attr("href")),
      shopping_url: productLink || searchUrl(title, input),
      image_url: httpUrl(card.find("img[alt]").first().attr("data-src") || card.find("img[alt]").first().attr("src")),
      sponsored: /\bSponsored\b/i.test(card.text()) ? true : null,
    });
  });
  if (rows.length || /(?:no shopping results|did not match any products|couldn't find any products)/i.test($("body").text())) return rows;
  throw new WorkerError(502, "Google Shopping did not provide product listings");
}

async function boundedText(response, max) {
  if (Number(response.headers.get("content-length")) > max) throw new WorkerError(502, "Google Shopping response is too large");
  const reader = response.body?.getReader();
  if (!reader) throw new WorkerError(502, "Google Shopping response is empty");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new WorkerError(502, "Google Shopping response is too large");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function requestBrowser(url, env, fetcher, signal) {
  const base = privateTrawlUrl(env.GOOGLE_SHOPPING_TRAWL_BASE_URL);
  for (let attempt = 0; attempt < 2; attempt++) {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(35_000)]);
    let response;
    try {
      response = await fetcher(`${base}/scrape`, {
        method: "POST", redirect: "error", signal: requestSignal,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ url, skipHttp: true, maxTier: 3, omitRawBody: true, maxTimeout: 28_000,
          ...(proxyUrl(env) && { proxy: proxyUrl(env) }) }),
      });
    } catch {
      signal.throwIfAborted();
      if (requestSignal.aborted) throw new WorkerError(504, "The Shopping browser timed out");
      if (attempt === 1) throw new WorkerError(502, "The Shopping browser is unavailable");
      await wait(500 + randomInt(200), undefined, { signal });
      continue;
    }
    if (response.status === 503 && attempt === 0) {
      await response.body?.cancel().catch(() => {});
      await wait(500 + randomInt(200), undefined, { signal });
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new WorkerError(response.status === 429 ? 503 : 502, "The Shopping browser could not retrieve public results");
    }
    let data;
    try { data = JSON.parse(await boundedText(response, maxBrowserBytes)); }
    catch (error) { if (error instanceof WorkerError) throw error; throw new WorkerError(502, "The Shopping browser returned invalid data"); }
    let landed;
    try { landed = new URL(data.url); } catch { throw new WorkerError(502, "The Shopping browser returned invalid data"); }
    if (landed.origin !== google || landed.pathname !== "/search" || data.statusCode !== 200 || typeof data.html !== "string") {
      throw new WorkerError(502, "The Shopping browser did not reach Google results");
    }
    return data.html;
  }
}

async function directHtml(url, input, fetcher, signal) {
  try {
    const response = await fetcher(url, {
      redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      headers: { accept: "text/html", "accept-language": `${input.language},en;q=0.8`,
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36" },
    });
    if (response.ok) {
      const html = await boundedText(response, maxHtmlBytes);
      try { return parseShoppingHtml(html, input); }
      catch (error) { if (!(error instanceof WorkerError) || error.message !== "Google Shopping did not provide product listings") throw error; }
    } else await response.body?.cancel().catch(() => {});
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof WorkerError && error.message !== "Google Shopping did not provide product listings") throw error;
  }
  return null;
}

export async function collect(input, { env, fetcher = fetch, signal }) {
  const url = searchUrl(input.query, input);
  const direct = await directHtml(url, input, fetcher, signal);
  if (direct) return direct;
  const proxy = proxyClient(env);
  try {
    if (proxy) {
      const proxied = await directHtml(url, input, proxy.fetcher, signal);
      if (proxied) return proxied;
    }
    return parseShoppingHtml(await requestBrowser(url, env, fetcher, signal), input);
  } finally { await proxy?.close(); }
}
