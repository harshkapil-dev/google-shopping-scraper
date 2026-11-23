import { randomInt } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { load } from "cheerio";
import { proxyCandidates, proxyClient } from "./proxy.js";
import { resultLimit, WorkerError } from "./upstream.js";

const google = "https://www.google.com";
const googleOrigins = new Set([
  "https://www.google.com",
  "https://www.google.co.uk",
  "https://www.google.ca",
  "https://www.google.com.au",
  "https://www.google.de",
  "https://www.google.fr",
  "https://www.google.co.in",
]);
const countries = new Set(["US", "GB", "CA", "AU", "DE", "FR", "IN"]);
const languages = new Set(["en", "de", "fr"]);
const maxHtmlBytes = 4_000_000;
const maxBrowserBytes = 5_000_000;
const cardSelector = [
  "g-inner-card",
  "li.I8iMf",
  ".sh-dgr__grid-result",
  ".sh-dgr__content",
  ".liKJJe",
  ".kzKZ7b",
  ".njFjte",
  "div[data-docid]",
  "div[data-cid]",
].join(", ");
const titleSelectors = [".gkQHve", ".tAxDx", ".Xjkr3b", "h3", "h4", "[role='heading']"];
const merchantSelectors = [".WJMUdc", ".aULzUe", ".IuHnof", ".E5ocAb", "[data-merchant-name]"];
const priceSelectors = ["[aria-label^='Current Price:']", "[aria-label*='Price']", ".lmQWe", ".a8Pemb", ".HRLxBb", ".T14wmb"];

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
  try {
    privateTrawlUrl(env.GOOGLE_SHOPPING_TRAWL_BASE_URL);
    proxyCandidates(env, "US");
    return true;
  } catch { return false; }
}

function searchUrl(query, input) {
  const url = new URL("/search", google);
  url.search = new URLSearchParams({ udm: "28", q: query, hl: input.language, gl: input.country.toLowerCase() }).toString();
  return url.href;
}

function cleanText(value) {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : null;
}

function httpUrl(value, base = google) {
  if (!value || value.startsWith("data:") || value.startsWith("javascript:")) return null;
  try {
    const url = new URL(value, base);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Ignore invalid links. */ }
  return null;
}

function isGoogleHost(hostname) {
  const host = (hostname || "").toLowerCase();
  return host === "google.com" || host.endsWith(".google.com") ||
    /^(?:www\.)?google\.(?:co\.uk|ca|com\.au|de|fr|co\.in)$/.test(host) ||
    host.endsWith(".gstatic.com") || host.endsWith(".googleusercontent.com");
}

function extractSellerUrl(card, $) {
  const anchors = card.find("a[href]");
  for (let index = 0; index < anchors.length; index += 1) {
    const href = $(anchors[index]).attr("href");
    const parsedHref = httpUrl(href);
    if (!parsedHref) continue;
    const url = new URL(parsedHref);
    if (isGoogleHost(url.hostname) && url.pathname === "/url") {
      const target = httpUrl(url.searchParams.get("q") || url.searchParams.get("url"));
      if (target && !isGoogleHost(new URL(target).hostname)) return target;
      continue;
    }
    if (!isGoogleHost(url.hostname)) return parsedHref;
  }
  return null;
}

function parseAmount(raw) {
  const value = raw.replace(/\s+/g, "");
  if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(value)) return Number(value.replaceAll(".", "").replace(",", "."));
  if (/^\d+,\d{1,2}$/.test(value)) return Number(value.replace(",", "."));
  return Number(value.replaceAll(",", ""));
}

function priceAndCurrency(value, country) {
  const text = value || "";
  const prefix = text.match(/(?:US|CA|AU)?\s*([$£€₹])\s*([\d.,]+)/);
  const suffix = !prefix && text.match(/([\d.,]+)\s*([£€₹$])/);
  const symbol = prefix ? prefix[1] : suffix ? suffix[2] : null;
  const amount = prefix ? prefix[2] : suffix ? suffix[1] : null;
  if (!symbol || !amount || !/\d/.test(amount)) return [null, null];
  const numeric = parseAmount(amount.replace(/[.,]+$/, ""));
  if (!Number.isFinite(numeric)) return [null, null];
  const currency = { "$": { US: "USD", CA: "CAD", AU: "AUD" }[country] || "USD", "£": "GBP", "€": "EUR", "₹": "INR" }[symbol];
  return [numeric, currency];
}

function parseRatingAndReviews(card, $) {
  const text = cleanText(card.text()) || "";
  const inline = text.match(/\b([0-5](?:\.\d)?)\s*\(([\d,.]+)([KM]?)\)/i);
  if (inline) {
    const count = Math.round(Number(inline[2].replaceAll(",", "")) * ({ K: 1000, M: 1_000_000 }[inline[3].toUpperCase()] || 1));
    return [Number(inline[1]), Number.isSafeInteger(count) ? count : null];
  }
  const labels = card.find("[aria-label]").map((_i, el) => $(el).attr("aria-label") || "").get().join(" ");
  const ariaRating = labels.match(/\b([0-5](?:\.\d)?)\s+out of 5\b/i);
  const ariaReviews = labels.match(/\b([\d,]+)\s+(?:product\s+)?reviews?\b/i);
  const rating = ariaRating ? Number(ariaRating[1]) : null;
  const reviews = ariaReviews ? Number(ariaReviews[1].replaceAll(",", "")) : null;
  return [Number.isFinite(rating) ? rating : null, Number.isSafeInteger(reviews) ? reviews : null];
}

function isTrafficChallenge(url, html) {
  if (url && url.pathname.startsWith("/sorry")) return true;
  return /unusual traffic|our systems have detected|verify you are human|not a robot/i.test(html || "");
}

function isJsShell(html) {
  return /\/httpservice\/retry\/enablejs|enable javascript/i.test(html || "");
}

function pickFirstText(card, selectors) {
  for (const selector of selectors) {
    const value = cleanText(card.find(selector).first().text());
    if (value) return value;
  }
  return null;
}

export function parseShoppingHtml(html, input) {
  if (typeof html !== "string" || Buffer.byteLength(html) > maxHtmlBytes) {
    throw new WorkerError(502, "Google Shopping returned an invalid page");
  }
  if (isTrafficChallenge(null, html)) {
    throw new WorkerError(503, "Google Shopping requires a traffic challenge; collection stopped");
  }
  const $ = load(html);
  const rows = [];
  const seen = new Set();
  const candidates = $(cardSelector).filter((_index, element) => $(element).find(cardSelector).length === 0);
  candidates.each((_index, element) => {
    if (rows.length >= input.max_total_results) return false;
    const card = $(element);
    const title = pickFirstText(card, titleSelectors) ||
      cleanText(card.find("[role=img][title]").first().attr("title"));
    if (!title) return;
    const merchant = pickFirstText(card, merchantSelectors);
    let priceText = null;
    for (const selector of priceSelectors) {
      const node = card.find(selector).first();
      if (!node.length) continue;
      priceText = node.attr("aria-label") || node.text();
      if (priceText) break;
    }
    const [price, currency] = priceAndCurrency(priceText || card.text(), input.country);
    const productId = cleanText(
      card.attr("data-docid") || card.attr("data-product-id") || card.attr("data-cid") ||
      card.closest("[data-docid], [data-product-id], [data-cid]").attr("data-docid"),
    );
    const productLink = httpUrl(card.find("a[href*='/shopping/product/'], a[href*='ibp=oshop']").first().attr("href"));
    const identity = productId || productLink || `${title.toLowerCase()}|${merchant?.toLowerCase() || ""}|${price ?? ""}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const [rating, reviews] = parseRatingAndReviews(card, $);
    const img = card.find("img[alt]").first().length ? card.find("img[alt]").first() : card.find("img").first();
    rows.push({
      position: rows.length + 1,
      product_id: productId,
      title,
      merchant,
      price,
      currency,
      rating,
      reviews,
      seller_url: extractSellerUrl(card, $),
      shopping_url: productLink || searchUrl(title, input),
      image_url: httpUrl(img.attr("data-src") || img.attr("src")),
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

export async function requestBrowser(url, { env, fetcher, signal, checkpoint, input }) {
  const base = privateTrawlUrl(env.GOOGLE_SHOPPING_TRAWL_BASE_URL);
  const proxies = proxyCandidates(env, input.country);
  const plans = proxies.length
    ? [
        { proxy: null, timeoutMs: 45_000, maxTimeout: 40_000 },
        { proxy: proxies[0], timeoutMs: 50_000, maxTimeout: 45_000 },
        ...(proxies[1] ? [{ proxy: proxies[1], timeoutMs: 35_000, maxTimeout: 30_000, proxyFallbackOnly: true }] : []),
      ]
    : [
        { proxy: null, timeoutMs: 45_000, maxTimeout: 40_000 },
        { proxy: null, timeoutMs: 45_000, maxTimeout: 40_000 },
      ];

  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    const isLast = index === plans.length - 1;
    // Refresh the job lease before each bounded browser attempt.
    await checkpoint({});
    const attemptTimeout = AbortSignal.timeout(plan.timeoutMs);
    const requestSignal = AbortSignal.any([signal, attemptTimeout]);
    let response;
    try {
      response = await fetcher(`${base}/scrape`, {
        method: "POST", redirect: "error", signal: requestSignal,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          url,
          skipHttp: true,
          maxTier: 3,
          omitRawBody: true,
          settleTimeout: 2_000,
          maxTimeout: plan.maxTimeout,
          ...(plan.proxy && { proxy: plan.proxy }),
        }),
      });
    } catch {
      signal.throwIfAborted();
      if (!isLast) {
        await wait(500 + randomInt(200), undefined, { signal });
        continue;
      }
      if (attemptTimeout.aborted) throw new WorkerError(504, "The Shopping browser timed out");
      throw new WorkerError(502, "The Shopping browser is unavailable");
    }
    if ((response.status === 429 || response.status >= 500) && !isLast) {
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
    if (isTrafficChallenge(landed, data.html)) {
      throw new WorkerError(503, "Google Shopping requires a traffic challenge; collection stopped");
    }
    if (!googleOrigins.has(landed.origin) || landed.pathname !== "/search" || data.statusCode !== 200 || typeof data.html !== "string") {
      const next = plans[index + 1];
      if (!isLast && (!next?.proxyFallbackOnly || plan.proxy)) continue;
      throw new WorkerError(502, "The Shopping browser did not reach Google results");
    }
    try { return parseShoppingHtml(data.html, input); }
    catch (error) {
      if (error instanceof WorkerError && error.status === 503) {
        throw error;
      }
      const next = plans[index + 1];
      if (!isLast && !next?.proxyFallbackOnly && error instanceof WorkerError &&
          error.message === "Google Shopping did not provide product listings") continue;
      throw error;
    }
  }
}

async function directHtml(url, input, fetcher, signal) {
  try {
    const response = await fetcher(url, {
      redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      headers: { accept: "text/html", "accept-language": `${input.language},en;q=0.8`,
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36" },
    });
    if (response.ok) {
      const html = await boundedText(response, maxHtmlBytes);
      if (isJsShell(html)) return { rows: null, jsShell: true };
      try { return { rows: parseShoppingHtml(html, input), jsShell: false }; }
      catch (error) {
        if (error instanceof WorkerError && error.message === "Google Shopping did not provide product listings") {
          return { rows: null, jsShell: false };
        }
        throw error;
      }
    } else await response.body?.cancel().catch(() => {});
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof WorkerError) throw error;
  }
  return { rows: null, jsShell: false };
}

export async function collect(input, { env, fetcher = fetch, signal, checkpoint }) {
  const url = searchUrl(input.query, input);
  const direct = await directHtml(url, input, fetcher, signal);
  if (direct.rows) return direct.rows;
  if (!direct.jsShell) {
    const proxy = proxyClient(env, input.country);
    try {
      if (proxy) {
        await checkpoint({});
        const proxied = await directHtml(url, input, proxy.fetcher, signal);
        if (proxied.rows) return proxied.rows;
      }
    } finally { await proxy?.close(); }
  }
  return await requestBrowser(url, { env, fetcher, signal, checkpoint, input });
}
