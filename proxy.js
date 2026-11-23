import { fetch as undiciFetch, ProxyAgent } from "undici";
import { WorkerError } from "./upstream.js";

function countryTargetingEnabled(env) {
  const mode = env.WEBSHARE_PROXY_COUNTRY_TARGETING;
  if (mode === undefined || mode === "" || mode === "true") return true;
  if (mode === "false") return false;
  throw new WorkerError(503, "The Shopping proxy is not configured correctly");
}

export function proxyUrl(env, country) {
  const { WEBSHARE_PROXY_DOMAIN: host, WEBSHARE_PROXY_PORT: port,
    WEBSHARE_PROXY_USERNAME: user, WEBSHARE_PROXY_PASSWORD: password } = env;
  if (![host, port, user, password].some(Boolean)) return null;
  if (![host, port, user, password].every(Boolean) ||
      !/^[a-z0-9.-]+$/i.test(host) || !/^\d{1,5}$/.test(port) ||
      Number(port) < 1 || Number(port) > 65535) {
    throw new WorkerError(503, "The Shopping proxy is not configured correctly");
  }
  const allowCountry = countryTargetingEnabled(env);
  const url = new URL(`http://${host}:${port}`);
  const target = allowCountry && typeof country === "string" ? country.toLowerCase() : null;
  const rotatedUser = target && /^[a-z]{2}$/.test(target) && /-rotate$/i.test(user) &&
    !/-(?:city_|state_|postalcode_|asn_)/i.test(user)
    ? user.replace(/(?:-[a-z]{2})?-rotate$/i, `-${target}-rotate`) : user;
  url.username = rotatedUser;
  url.password = password;
  return url.href;
}

export function proxyCandidates(env, country) {
  const primary = proxyUrl(env, country);
  if (!primary) return [];
  const fallback = proxyUrl(env, null);
  return fallback && fallback !== primary ? [primary, fallback] : [primary];
}

export function proxyClient(env, country) {
  const url = proxyUrl(env, country);
  if (!url) return null;
  const dispatcher = new ProxyAgent(url);
  return {
    fetcher: (target, options) => undiciFetch(target, { ...options, dispatcher }),
    close: () => dispatcher.close(),
    url,
  };
}
