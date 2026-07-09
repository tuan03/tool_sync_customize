"use strict";

const http = require("http");
const { ProxyAgent, setGlobalDispatcher } = require("undici");
const { loadEnv } = require("./env");

loadEnv();

let configured = false;
let lastStatus = null;
let locationCache = { key: "", expiresAt: 0, value: null };

function isEnabled() {
  return String(process.env.SHOPIFY_PROXY_ENABLED || "").trim() === "1";
}

function sanitizeProxyUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    const parsed = new URL(rawUrl);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return String(rawUrl).replace(/\/\/([^:@/]+):([^@/]+)@/, "//***:***@");
  }
}

function buildProxyUri() {
  const rawUrl = process.env.SHOPIFY_PROXY_URL || "";
  if (!rawUrl) throw new Error("SHOPIFY_PROXY_URL is required when SHOPIFY_PROXY_ENABLED=1.");
  const parsed = new URL(rawUrl);
  const username = process.env.SHOPIFY_PROXY_USERNAME || "";
  const password = process.env.SHOPIFY_PROXY_PASSWORD || "";
  if (username && !parsed.username) parsed.username = username;
  if (password && !parsed.password) parsed.password = password;
  return parsed.toString();
}

function proxyHost() {
  const rawUrl = process.env.SHOPIFY_PROXY_URL || "";
  if (!rawUrl) return "";
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "";
  }
}

function fetchJsonWithoutProxy(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs, headers: { accept: "application/json" } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Geo lookup failed with HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body || "{}"));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error("Geo lookup timed out"));
    });
    request.on("error", reject);
  });
}

async function proxyLocation() {
  const host = proxyHost();
  if (!host) return null;
  const now = Date.now();
  if (locationCache.key === host && locationCache.expiresAt > now) return locationCache.value;
  try {
    const fields = "status,message,query,country,regionName,city,timezone,isp,org,as,proxy,hosting";
    const data = await fetchJsonWithoutProxy(`http://ip-api.com/json/${encodeURIComponent(host)}?fields=${fields}`);
    if (data.status !== "success") throw new Error(data.message || "Geo lookup failed");
    const value = {
      ip: data.query || host,
      city: data.city || "",
      region: data.regionName || "",
      country: data.country || "",
      timezone: data.timezone || "",
      isp: data.isp || "",
      org: data.org || "",
      as: data.as || "",
      proxy: Boolean(data.proxy),
      hosting: Boolean(data.hosting),
    };
    locationCache = { key: host, expiresAt: now + 10 * 60 * 1000, value };
    return value;
  } catch (error) {
    const value = { ip: host, error: error.message };
    locationCache = { key: host, expiresAt: now + 2 * 60 * 1000, value };
    return value;
  }
}

function proxyStatus() {
  const username = process.env.SHOPIFY_PROXY_USERNAME || "";
  const password = process.env.SHOPIFY_PROXY_PASSWORD || "";
  return {
    enabled: isEnabled(),
    configured,
    url: sanitizeProxyUrl(process.env.SHOPIFY_PROXY_URL || ""),
    host: proxyHost(),
    authConfigured: Boolean(username || password),
    error: lastStatus && lastStatus.error || "",
  };
}

async function proxyStatusWithLocation() {
  const status = proxyStatus();
  if (!status.enabled) return { ...status, location: null };
  return { ...status, location: await proxyLocation() };
}

function configureProxy() {
  if (configured || !isEnabled()) {
    lastStatus = proxyStatus();
    return lastStatus;
  }
  try {
    const proxyUri = buildProxyUri();
    setGlobalDispatcher(new ProxyAgent(proxyUri));
    configured = true;
    lastStatus = proxyStatus();
    return lastStatus;
  } catch (error) {
    configured = false;
    lastStatus = { ...proxyStatus(), error: error.message };
    console.warn(`Shopify proxy is enabled but could not be configured: ${error.message}`);
    return lastStatus;
  }
}

module.exports = { configureProxy, proxyStatus, proxyStatusWithLocation };
