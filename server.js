const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");
const crypto = require("crypto");
const { normalizeAmazonConfig, byteSize, MAX_METAFIELD_BYTES, replaceAssetUrls } = require("./lib/amazon-config");
const { ShopifyAdmin } = require("./lib/shopify-admin");
const { configureProxy, proxyStatusWithLocation } = require("./lib/proxy");

const PORT = Number(process.env.PORT || 3000);
configureProxy();
const PUBLIC_DIR = path.join(__dirname, "public");
const AMAZON_COOKIE = process.env.AMAZON_COOKIE || "";
const DEFAULT_HEADERS = {
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  pragma: "no-cache",
  "sec-ch-ua": '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
};
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function safeFileName(url, prefix = "amzcustom-config") {
  let extension = ".bin";
  try {
    const candidate = path.extname(new URL(url).pathname).toLowerCase();
    if (/^\.(png|jpe?g|webp|gif|svg|woff2?|ttf|otf)$/.test(candidate)) extension = candidate;
  } catch {}
  return `${prefix}-${crypto.createHash("sha1").update(url).digest("hex").slice(0, 16)}${extension}`;
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return output;
}

function shopifyFileUrl(file) {
  return file && ((file.image && file.image.url) || file.url) || "";
}

function externalConfigFilename(productId, config) {
  const digest = crypto.createHash("sha1").update(JSON.stringify(config)).digest("hex").slice(0, 16);
  const id = String(productId || "product").split("/").pop().replace(/[^A-Za-z0-9_-]/g, "") || "product";
  return `amzcustom-config-${id}-${digest}.json`;
}

function compactCustomizerConfig(config, configUrl, fullBytes) {
  return {
    schemaVersion: config.schemaVersion,
    externalConfig: true,
    configUrl,
    externalConfigBytes: fullBytes,
    source: config.source,
    pricing: config.pricing,
    optionGroups: (config.optionGroups || []).map((group) => ({
      id: group.id,
      options: (group.options || []).map((option) => ({ id: option.id, cost: Number(option.cost || 0) })),
    })),
  };
}

async function ensureExternalConfigFile(admin, product, config, apply) {
  const filename = externalConfigFilename(product.id, config);
  if (!apply) return { dryRun: true, filename, url: null };
  const existing = await admin.findFileByFilename(filename);
  if (existing && existing.fileStatus === "READY") {
    return { reused: true, filename, id: existing.id, url: shopifyFileUrl(existing) };
  }
  const file = await admin.uploadBuffer(Buffer.from(JSON.stringify(config), "utf8"), {
    filename,
    mimeType: "application/json",
    alt: `Amazon customizer config for ${product.title}`,
    contentType: "FILE",
  }, true);
  const url = shopifyFileUrl(file);
  if (!url) throw new Error("Shopify did not return a URL for the external config file.");
  return { filename, id: file.id, url };
}

async function syncConfigAssets(admin, config, apply) {
  if (!apply) return { config, assets: config.assets.map((asset) => ({ source: asset.url, dryRun: true, filename: safeFileName(asset.url) })) };
  const uploaded = await mapLimit(config.assets, 3, async (asset) => {
    const contentType = asset.roles && asset.roles.includes("font") ? "FILE" : "IMAGE";
    const ready = await admin.ensureFileFromUrl(asset.url, safeFileName(asset.url), "Amazon customizer config asset", true, contentType);
    return { source: asset.url, id: ready.id, url: shopifyFileUrl(ready) };
  });
  const replacements = Object.fromEntries(uploaded.filter((item) => item.url).map((item) => [item.source, item.url]));
  return { config: replaceAssetUrls(config, replacements), assets: uploaded };
}

async function handleShopifyConvert(req, res) {
  try {
    const body = JSON.parse(await readRequestBody(req) || "{}");
    const config = normalizeAmazonConfig(body.config, body.sourceUrl || "");
    const bytes = byteSize(config);
    jsonResponse(res, 200, { ok: true, config, summary: { bytes, externalStorageRequired: bytes > MAX_METAFIELD_BYTES, asin: config.source.asin, controls: config.controlOrder.length, assets: config.assets.length, surchargeAmounts: config.pricing.amounts, warnings: config.warnings } });
  } catch (error) {
    jsonResponse(res, 400, { ok: false, error: error.message });
  }
}

async function handleAdminStatus(req, res) {
  jsonResponse(res, 200, {
    ok: true,
    proxy: await proxyStatusWithLocation(),
    shop: process.env.SHOPIFY_SHOP || "",
    apiVersion: process.env.SHOPIFY_API_VERSION || "2026-04",
  });
}

function assertAdminAuthorized(req) {
  if (process.env.CUSTOMIZER_ADMIN_SECRET && req.headers.authorization !== `Bearer ${process.env.CUSTOMIZER_ADMIN_SECRET}`) {
    throw new Error("Unauthorized admin request.");
  }
}

async function performShopifySync(body = {}) {
  const apply = body.apply === true;
  const admin = new ShopifyAdmin();
  let config = body.normalizedConfig || normalizeAmazonConfig(body.config, body.sourceUrl || "");
  config = JSON.parse(JSON.stringify(config));
  const hasFractionalAmounts = config.pricing.amounts.some((amount) => !Number.isInteger(Number(amount)));
  const priceMultiplier = Number(body.priceMultiplier);
  if (hasFractionalAmounts && (!Number.isFinite(priceMultiplier) || priceMultiplier <= 0)) {
    throw new Error("Amazon surcharge contains decimal amounts. Enter an explicit price multiplier before Sync if your Shopify variant pricing needs conversion.");
  }
  if (Number.isFinite(priceMultiplier) && priceMultiplier > 0 && priceMultiplier !== 1) {
    for (const group of config.optionGroups) for (const option of group.options) option.cost = Math.round(Number(option.cost || 0) * priceMultiplier);
    config.pricing.amounts = [...new Set(config.optionGroups.flatMap((group) => group.options.map((option) => option.cost)).filter((amount) => amount > 0))].sort((a, b) => a - b);
    config.pricing.sourceMultiplier = priceMultiplier;
  }
  const paidOptionGroups = config.optionGroups.filter((group) => (group.options || []).some((option) => Number(option.cost || 0) > 0));
  const freeOptionGroups = config.optionGroups.filter((group) => !paidOptionGroups.includes(group));
  const migratedPaidGroups = paidOptionGroups.map((group) => {
    const options = [...(group.options || [])];
    if (!group.required && !options.some((option) => Number(option.cost || 0) === 0)) {
      options.unshift({ id: `${group.id}__none`, label: "None", cost: 0, overlayImage: null, thumbnailImage: null });
    }
    return { ...group, variantOptions: options };
  });
  const product = await admin.product(body.productId || "");
  const definition = await admin.ensureCustomizerDefinition(apply);
  const assetResult = await syncConfigAssets(admin, config, apply);
  config = assetResult.config;
  const variantMigration = await admin.syncPaidOptionsIntoProductVariants(product.id, migratedPaidGroups, apply);
  config.optionGroups = freeOptionGroups;
  config.controlOrder = (config.controlOrder || []).filter((entry) => entry.type !== "option" || !paidOptionGroups.some((group) => group.id === entry.id));
  config.pricing.currencyCode = "USD";
  config.pricing.mode = "product_variants";
  config.pricing.paidOptionGroups = migratedPaidGroups.map((group) => ({
    id: group.id,
    label: group.label,
    required: Boolean(group.required),
    options: (group.variantOptions || []).map((option) => ({
      id: option.id,
      label: option.label,
      cost: Number(option.cost || 0),
    })),
  }));
  const bytes = byteSize(config);
  let metafieldConfig = config;
  let externalConfig = null;
  if (bytes > MAX_METAFIELD_BYTES) {
    const externalFile = await ensureExternalConfigFile(admin, product, config, apply);
    metafieldConfig = compactCustomizerConfig(config, externalFile.url, bytes);
    const metafieldBytes = byteSize(metafieldConfig);
    if (metafieldBytes > MAX_METAFIELD_BYTES) throw new Error(`Compact customizer metafield is still too large (${metafieldBytes} bytes).`);
    externalConfig = { enabled: true, file: externalFile, metafieldBytes };
  }
  const metafield = await admin.setCustomizer(product.id, metafieldConfig, apply);
  return {
    ok: true,
    apply,
    product: { id: product.id, title: product.title },
    definition,
    assets: assetResult.assets,
    metafield,
    bytes,
    externalConfig,
    pricing: {
      currency: "USD",
      mode: "product_variants",
      paidOptionGroups: config.pricing.paidOptionGroups,
      variantMigration,
    }
  };
}

async function handleShopifySync(req, res) {
  try {
    assertAdminAuthorized(req);
    const body = JSON.parse(await readRequestBody(req) || "{}");
    const result = await performShopifySync(body);
    jsonResponse(res, 200, result);
  } catch (error) {
    jsonResponse(res, 400, { ok: false, error: error.message });
  }
}

async function handleShopifySyncApi(req, res) {
  try {
    assertAdminAuthorized(req);
    const body = JSON.parse(await readRequestBody(req) || "{}");
    if (!body.productId) throw new Error("Missing productId.");
    if (!body.rawAmazonJson && !body.config && !body.normalizedConfig) throw new Error("Missing rawAmazonJson.");
    const result = await performShopifySync({
      productId: body.productId,
      config: body.rawAmazonJson || body.config,
      normalizedConfig: body.normalizedConfig,
      sourceUrl: body.sourceUrl || "",
      priceMultiplier: body.priceMultiplier,
      apply: true,
    });
    jsonResponse(res, 200, {
      ok: true,
      message: `Sync successful for product ${result.product.title}.`,
      result,
    });
  } catch (error) {
    jsonResponse(res, 400, {
      ok: false,
      message: "Sync failed.",
      error: error.message,
    });
  }
}

function parseDataUrl(value) {
  const match = String(value || "").match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw new Error("Expected a base64 data URL.");
  return { mimeType: match[1], buffer: Buffer.from(match[2], "base64") };
}

function storefrontAuthorized(req, requestUrl) {
  const secret = process.env.CUSTOMIZER_UPLOAD_SECRET || "";
  if (secret && req.headers.authorization === `Bearer ${secret}`) return true;
  const signature = requestUrl.searchParams.get("signature");
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || "";
  if (!signature || !clientSecret) return false;
  const pairs = [...requestUrl.searchParams.entries()].filter(([key]) => key !== "signature").sort(([a], [b]) => a.localeCompare(b));
  const message = pairs.map(([key, value]) => `${key}=${value}`).join("");
  const expected = crypto.createHmac("sha256", clientSecret).update(message).digest("hex");
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function handleShopifyUpload(req, res, requestUrl) {
  const startedAt = Date.now();
  try {
    if (!storefrontAuthorized(req, requestUrl)) throw new Error("Unauthorized upload request.");
    const body = JSON.parse(await readRequestBody(req) || "{}");
    const admin = new ShopifyAdmin();
    const allowed = new Set(["image/png", "image/jpeg", "image/webp", "application/json"]);
    if (body.action === "prepare") {
      const mimeType = String(body.mimeType || "");
      const fileSize = Number(body.fileSize || 0);
      if (!allowed.has(mimeType)) throw new Error(`Unsupported MIME type: ${mimeType}`);
      if (!Number.isFinite(fileSize) || fileSize <= 0) throw new Error("Missing file size.");
      if (fileSize > 10 * 1024 * 1024) throw new Error("File exceeds the 10MB upload limit.");
      const timestamp = Date.now();
      const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "application/json": "json" }[mimeType];
      const filename = `amzcustom-order-${timestamp}-${crypto.randomUUID()}.${extension}`;
      console.log("[Amazon Customizer][Server] Upload prepare", { filename, mimeType, bytes: fileSize });
      const target = await admin.createStagedUploadTarget({ filename, mimeType, fileSize, contentType: mimeType === "application/json" ? "FILE" : "IMAGE" });
      jsonResponse(res, 200, {
        ok: true,
        upload: {
          filename,
          mimeType,
          contentType: mimeType === "application/json" ? "FILE" : "IMAGE",
          url: target.url,
          resourceUrl: target.resourceUrl,
          parameters: target.parameters,
        }
      });
      return;
    }
    if (body.action === "complete") {
      const mimeType = String(body.mimeType || "");
      const filename = String(body.filename || "");
      const resourceUrl = String(body.resourceUrl || "");
      if (!allowed.has(mimeType)) throw new Error(`Unsupported MIME type: ${mimeType}`);
      if (!filename || !resourceUrl) throw new Error("Missing upload completion data.");
      console.log("[Amazon Customizer][Server] Upload complete start", { filename, mimeType });
      const file = await admin.completeStagedUpload(resourceUrl, {
        filename,
        alt: `Amazon customizer order asset ${Date.now()}`,
        contentType: mimeType === "application/json" ? "FILE" : "IMAGE"
      }, true);
      console.log("[Amazon Customizer][Server] Upload completed", { filename, mimeType, elapsedMs: Date.now() - startedAt, fileId: file.id });
      jsonResponse(res, 200, { ok: true, file: { id: file.id, url: shopifyFileUrl(file), filename } });
      return;
    }
    const parsed = parseDataUrl(body.dataUrl);
    if (parsed.buffer.length > 10 * 1024 * 1024) throw new Error("File exceeds the 10MB upload limit.");
    if (!allowed.has(parsed.mimeType)) throw new Error(`Unsupported MIME type: ${parsed.mimeType}`);
    const timestamp = Date.now();
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "application/json": "json" }[parsed.mimeType];
    const filename = `amzcustom-order-${timestamp}-${crypto.randomUUID()}.${extension}`;
    console.log("[Amazon Customizer][Server] Upload started", { filename, mimeType: parsed.mimeType, bytes: parsed.buffer.length });
    const file = await admin.uploadBuffer(parsed.buffer, { filename, mimeType: parsed.mimeType, alt: `Amazon customizer order asset ${timestamp}`, contentType: parsed.mimeType === "application/json" ? "FILE" : "IMAGE" }, true);
    console.log("[Amazon Customizer][Server] Upload completed", { filename, mimeType: parsed.mimeType, bytes: parsed.buffer.length, elapsedMs: Date.now() - startedAt, fileId: file.id });
    jsonResponse(res, 200, { ok: true, file: { id: file.id, url: shopifyFileUrl(file), filename } });
  } catch (error) {
    console.warn("[Amazon Customizer][Server] Upload failed", { elapsedMs: Date.now() - startedAt, error: error.message });
    jsonResponse(res, 400, { ok: false, error: error.message });
  }
}

async function handleShopifyCleanup(req, res) {
  try {
    const authorization = req.headers.authorization || "";
    if (!process.env.CUSTOMIZER_CRON_SECRET || authorization !== `Bearer ${process.env.CUSTOMIZER_CRON_SECRET}`) throw new Error("Unauthorized cleanup request.");
    const body = JSON.parse(await readRequestBody(req) || "{}");
    const result = await new ShopifyAdmin().cleanupOrderFiles({ olderThanDays: Number(body.olderThanDays) || 30, apply: body.apply === true });
    jsonResponse(res, 200, { ok: true, ...result });
  } catch (error) { jsonResponse(res, 400, { ok: false, error: error.message }); }
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function renderProductionPreviewPage({ customizationId, order, lineItem, payload }) {
  const bootstrap = { customizationId, order, lineItem, payload };
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Production Preview</title>
    <style>
      :root {
        color-scheme: light;
        --navy: #10295c;
        --gold: #c8931b;
        --line: #e7dcc5;
        --surface: #ffffff;
        --surface-soft: #fffaf0;
        --text: #23395d;
        --muted: #6f7b92;
        --shadow: 0 18px 48px rgba(16, 41, 92, 0.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Arial, sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top, rgba(200, 147, 27, 0.15), transparent 30%),
          linear-gradient(180deg, #fffaf0 0%, #fff 100%);
      }
      .page {
        max-width: 1560px;
        margin: 0 auto;
        padding: 28px;
      }
      .panel {
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 32px;
        background: var(--surface);
        box-shadow: var(--shadow);
      }
      .panel__head {
        display: flex;
        justify-content: space-between;
        gap: 24px;
        align-items: flex-start;
        padding: 32px 34px 26px;
      }
      .panel__title {
        margin: 0 0 10px;
        font-size: clamp(32px, 4vw, 58px);
        line-height: 1;
        color: var(--navy);
      }
      .meta {
        display: grid;
        gap: 6px;
        font-size: 15px;
      }
      .meta strong {
        color: var(--navy);
      }
      .actions {
        display: flex;
        gap: 14px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .button {
        appearance: none;
        border-radius: 999px;
        min-height: 58px;
        padding: 0 28px;
        font-size: 16px;
        font-weight: 700;
        cursor: pointer;
        text-decoration: none;
        border: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.18s ease, box-shadow 0.18s ease;
      }
      .button:hover {
        transform: translateY(-1px);
      }
      .button--primary {
        background: linear-gradient(135deg, var(--gold) 0%, #d7a12d 100%);
        color: #fff;
        box-shadow: 0 14px 30px rgba(200, 147, 27, 0.25);
      }
      .button--ghost {
        background: #fff;
        color: var(--navy);
        border: 1px solid rgba(16, 41, 92, 0.15);
      }
      .panel__body {
        border-top: 1px solid var(--line);
        padding: 34px;
      }
      .preview-shell {
        min-height: 540px;
        display: flex;
        justify-content: center;
        align-items: center;
        border: 1px solid var(--line);
        border-radius: 28px;
        background: linear-gradient(180deg, #ffffff 0%, var(--surface-soft) 100%);
        padding: 30px;
      }
      canvas {
        display: block;
        max-width: 100%;
        max-height: 72vh;
        border-radius: 18px;
        background: #fff;
        box-shadow: 0 16px 40px rgba(16, 41, 92, 0.14);
      }
      .notice {
        font-size: 18px;
        color: var(--muted);
      }
      @media (max-width: 900px) {
        .page {
          padding: 16px;
        }
        .panel {
          border-radius: 24px;
        }
        .panel__head,
        .panel__body {
          padding: 22px;
        }
        .actions {
          width: 100%;
          justify-content: flex-start;
        }
        .button {
          width: 100%;
        }
        .preview-shell {
          min-height: 320px;
          padding: 18px;
        }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <section class="panel">
        <div class="panel__head">
          <div>
            <h1 class="panel__title">Production Preview</h1>
            <div class="meta">
              <div><strong>Product:</strong> ${escapeHtml(lineItem?.title || "Customization preview")}</div>
              <div><strong>Order:</strong> ${escapeHtml(order?.name || "")}</div>
              <div><strong>Customization ID:</strong> ${escapeHtml(customizationId)}</div>
            </div>
          </div>
          <div class="actions">
            <button type="button" class="button button--primary" id="downloadPng">Download PNG</button>
            <button type="button" class="button button--ghost" id="closePage">Close</button>
          </div>
        </div>
        <div class="panel__body">
          <div class="preview-shell" id="previewShell">
            <div class="notice">Rendering preview...</div>
          </div>
        </div>
      </section>
    </div>
    <script id="amzcustom-production-data" type="application/json">${escapeScriptJson(bootstrap)}</script>
    <script>
      (() => {
        const bootstrap = JSON.parse(document.getElementById("amzcustom-production-data").textContent);
        const previewModel = bootstrap?.payload?.previewModel;
        const previewShell = document.getElementById("previewShell");
        const downloadButton = document.getElementById("downloadPng");
        const closeButton = document.getElementById("closePage");
        const loadedFonts = new Set();
        const imageCache = new Map();
        let renderedCanvas = null;

        closeButton.addEventListener("click", () => {
          if (window.history.length > 1) {
            window.history.back();
            return;
          }
          window.close();
        });

        function ratioRect(rect, width, height) {
          return {
            x: rect.x * width,
            y: rect.y * height,
            width: rect.width * width,
            height: rect.height * height
          };
        }

        async function ensureFont(layer) {
          const key = \`\${layer.fontFamily || ""}|\${layer.fontUrl || ""}|\${layer.fontType || ""}\`;
          if (!key || loadedFonts.has(key)) return;
          loadedFonts.add(key);
          if (layer.fontUrl && "FontFace" in window) {
            try {
              const face = new FontFace(layer.fontFamily || "Arial", \`url(\${JSON.stringify(layer.fontUrl).slice(1, -1)})\`);
              const loaded = await face.load();
              document.fonts.add(loaded);
              return;
            } catch {}
          }
          if (/googlefont/i.test(layer.fontType || "") && layer.fontFamily) {
            const href = \`https://fonts.googleapis.com/css2?family=\${encodeURIComponent(layer.fontFamily).replace(/%20/g, "+")}&display=swap\`;
            if (![...document.querySelectorAll("link[href]")].some((link) => link.href === href)) {
              const link = document.createElement("link");
              link.rel = "stylesheet";
              link.href = href;
              document.head.appendChild(link);
            }
            if (document.fonts?.ready) {
              try {
                await document.fonts.ready;
              } catch {}
            }
          }
        }

        async function loadImage(url) {
          const key = String(url || "");
          if (!key) throw new Error("Missing image URL.");
          if (!imageCache.has(key)) {
            imageCache.set(key, new Promise((resolve, reject) => {
              const image = new Image();
              image.crossOrigin = "anonymous";
              image.onload = () => resolve(image);
              image.onerror = () => reject(new Error(\`Failed to load image: \${key}\`));
              image.src = key;
            }).catch((error) => {
              imageCache.delete(key);
              throw error;
            }));
          }
          return imageCache.get(key);
        }

        async function resolveCanvasSize(model) {
          const baseWidth = Math.max(1200, Number(model.width || 1200));
          const aspect = Math.max(0.1, Number(model.height || 1) / Math.max(1, Number(model.width || 1)));
          let width = baseWidth;
          for (const layer of model.layers || []) {
            if (layer.type !== "image" || !layer.rect?.width) continue;
            try {
              const image = await loadImage(layer.src);
              const candidate = image.naturalWidth / Math.max(layer.rect.width, 0.01);
              width = Math.max(width, candidate);
            } catch {}
          }
          width = Math.min(Math.round(width), 2400);
          return {
            width,
            height: Math.max(1, Math.round(width * aspect))
          };
        }

        async function render(model) {
          if (!model?.layers?.length) {
            previewShell.innerHTML = '<div class="notice">No renderable preview data is stored for this customization.</div>';
            downloadButton.disabled = true;
            return;
          }

          const { width, height } = await resolveCanvasSize(model);
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d");
          context.fillStyle = model.background || "#ffffff";
          context.fillRect(0, 0, canvas.width, canvas.height);

          const textLayers = (model.layers || []).filter((layer) => layer.type === "text");
          await Promise.all(textLayers.map(ensureFont));

          for (const layer of model.layers || []) {
            if (layer.type === "image") {
              const image = await loadImage(layer.src);
              const rect = ratioRect(layer.rect, canvas.width, canvas.height);
              context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
              continue;
            }
            if (layer.type === "clipped-image") {
              const image = await loadImage(layer.src);
              const clipRect = ratioRect(layer.clipRect, canvas.width, canvas.height);
              const imageRect = ratioRect(layer.imageRect, canvas.width, canvas.height);
              context.save();
              context.beginPath();
              context.rect(clipRect.x, clipRect.y, clipRect.width, clipRect.height);
              context.clip();
              context.drawImage(image, imageRect.x, imageRect.y, imageRect.width, imageRect.height);
              context.restore();
              continue;
            }
            if (layer.type === "text") {
              const rect = ratioRect(layer.rect, canvas.width, canvas.height);
              const lines = String(layer.text || "").split(/\\r?\\n/);
              const fontSize = Math.max(10, (Number(layer.fontSizeRatio) || 0.05) * canvas.width);
              const lineHeight = Math.max(fontSize * 1.18, (Number(layer.lineHeightRatio) || 0.06) * canvas.height);
              context.save();
              context.fillStyle = layer.color || "#000000";
              context.font = \`\${fontSize}px "\${String(layer.fontFamily || "Arial").replace(/"/g, '\\"')}", Arial, sans-serif\`;
              context.textAlign = "center";
              context.textBaseline = "middle";
              if (layer.singleLine) {
                context.fillText(lines.join(" ").replace(/\\s+/g, " "), rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width);
              } else {
                lines.forEach((line, index) => {
                  context.fillText(
                    line,
                    rect.x + rect.width / 2,
                    rect.y + rect.height / 2 + (index - (lines.length - 1) / 2) * lineHeight,
                    rect.width
                  );
                });
              }
              context.restore();
            }
          }

          renderedCanvas = canvas;
          previewShell.innerHTML = "";
          previewShell.appendChild(canvas);
        }

        downloadButton.addEventListener("click", async () => {
          if (!renderedCanvas) return;
          const blob = await new Promise((resolve) => renderedCanvas.toBlob(resolve, "image/png"));
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = \`production-preview-\${bootstrap.customizationId || "customization"}.png\`;
          document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        });

        render(previewModel).catch((error) => {
          previewShell.innerHTML = \`<div class="notice">\${String(error?.message || error || "Could not render preview.")}</div>\`;
          downloadButton.disabled = true;
        });
      })();
    </script>
  </body>
</html>`;
}

async function handleProductionPreview(req, res, requestUrl) {
  try {
    const customizationId = String(requestUrl.searchParams.get("customization_id") || "").trim();
    if (!customizationId) throw new Error("Missing customization_id.");
    const result = await new ShopifyAdmin().findCustomizationById(customizationId);
    if (!result) {
      jsonResponse(res, 404, { ok: false, error: "Customization not found in recent orders." });
      return;
    }
    const body = renderProductionPreviewPage({
      customizationId,
      order: result.order,
      lineItem: result.lineItem,
      payload: result.payload
    });
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store"
    });
    res.end(body);
  } catch (error) {
    jsonResponse(res, 400, { ok: false, error: error.message });
  }
}

function validateCustomFormUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }

  const hostname = parsed.hostname.toLowerCase();
  const isAmazonHost = hostname === "amazon.com" || hostname === "www.amazon.com" || hostname.endsWith(".amazon.com");
  if (!isAmazonHost) {
    throw new Error("Only amazon.com custom form URLs are allowed");
  }

  if (!parsed.pathname.includes("/customization/form")) {
    throw new Error("URL must point to /customization/form");
  }

  return parsed.toString();
}

function validateAmazonProductUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid Amazon product URL");
  }

  const hostname = parsed.hostname.toLowerCase();
  const isAmazonHost = hostname === "amazon.com" || hostname === "www.amazon.com" || hostname.endsWith(".amazon.com");
  if (!isAmazonHost) {
    throw new Error("Only amazon.com product URLs are allowed");
  }

  return parsed.toString();
}

function validateAssetUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid asset URL");
  }

  const hostname = parsed.hostname.toLowerCase();
  const allowed =
    hostname === "m.media-amazon.com" ||
    hostname === "images-na.ssl-images-amazon.com" ||
    hostname === "d1a6rwiznrii2i.cloudfront.net" ||
    hostname.endsWith(".media-amazon.com");

  if (!allowed) {
    throw new Error("Asset host is not allowed");
  }

  return parsed.toString();
}

async function fetchHtml(url) {
  const headers = { ...DEFAULT_HEADERS };
  if (AMAZON_COOKIE) headers.cookie = AMAZON_COOKIE;

  let response;
  try {
    response = await fetch(url, { redirect: "follow", headers });
  } catch (error) {
    const cause = error && error.cause;
    throw new Error(`Amazon fetch failed: ${error.code || cause && cause.code || error.message}`);
  }

  const html = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching custom form`);
  }

  if (/captcha|robot check|enter the characters/i.test(html)) {
    throw new Error("Amazon returned a CAPTCHA/robot-check page. Refresh AMAZON_COOKIE or retry later.");
  }

  if (/Hmm\.\.\.Something's not right|problem with our connection/i.test(html)) {
    throw new Error(
      "Amazon returned a connection/error shell instead of the customizer config. Set AMAZON_COOKIE or use a URL already cached in a local HAR."
    );
  }

  return { html, status: response.status, url: response.url };
}

function extractAppConfig(html, sourceInfo = {}) {
  const scripts =
    html.match(/<script\b[^>]*type=["']a-state["'][^>]*>[\s\S]*?<\/script>/gi) || [];

  for (const script of scripts) {
    if (!script.includes("gc:app-config")) continue;

    const bodyMatch = script.match(/>([\s\S]*?)<\/script>/i);
    if (!bodyMatch) continue;

    return JSON.parse(decodeHtmlEntities(bodyMatch[1].trim()));
  }

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleText = title ? decodeHtmlEntities(title[1].replace(/\s+/g, " ").trim()) : "unknown";
  const details = [
    "Amazon gc:app-config state not found in HTML",
    sourceInfo.status ? `status=${sourceInfo.status}` : null,
    sourceInfo.url ? `url=${sourceInfo.url}` : null,
    `title=${titleText}`,
  ]
    .filter(Boolean)
    .join("; ");
  throw new Error(details);
}

function extractProductInfo(html, sourceInfo = {}) {
  const scripts =
    html.match(/<script\b[^>]*type=["']a-state["'][^>]*>[\s\S]*?<\/script>/gi) || [];

  for (const script of scripts) {
    if (!script.includes("gc:productInfo")) continue;

    const bodyMatch = script.match(/>([\s\S]*?)<\/script>/i);
    if (!bodyMatch) continue;

    const productInfo = JSON.parse(decodeHtmlEntities(bodyMatch[1].trim()));
    if (!productInfo.customizationFormLink) {
      throw new Error("Amazon gc:productInfo was found, but customizationFormLink is missing.");
    }
    return productInfo;
  }

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleText = title ? decodeHtmlEntities(title[1].replace(/\s+/g, " ").trim()) : "unknown";
  const details = [
    "Amazon gc:productInfo state not found in product HTML",
    sourceInfo.status ? `status=${sourceInfo.status}` : null,
    sourceInfo.url ? `url=${sourceInfo.url}` : null,
    `title=${titleText}`,
  ]
    .filter(Boolean)
    .join("; ");
  throw new Error(details);
}

function amazonCustomizationUrl(productInfo) {
  const link = String(productInfo && productInfo.customizationFormLink || "");
  if (!link) throw new Error("customizationFormLink is missing.");
  return new URL(link, "https://www.amazon.com").toString();
}

function extractCustomizationFormLink(html) {
  const patterns = [
    /https?:\\?\/\\?\/(?:www\.)?amazon\.com\\?\/customization\\?\/form\?[^"'\\\s<>]+/i,
    /\/customization\/form\?[^"'\\\s<>]+/i,
  ];

  for (const pattern of patterns) {
    const match = String(html || "").match(pattern);
    if (!match) continue;

    let link = decodeHtmlEntities(match[0])
      .replace(/\\\//g, "/")
      .replace(/\\u0026/g, "&")
      .replace(/&amp;/g, "&");

    try {
      link = decodeURIComponent(link);
    } catch {}

    return new URL(link, "https://www.amazon.com").toString();
  }

  return "";
}

function normalizeImage(image) {
  if (!image || !image.imageUrl) return null;
  return {
    url: image.imageUrl,
    width: image.dimension && image.dimension.width,
    height: image.dimension && image.dimension.height,
  };
}

function collectAssetsFromNode(node, assets) {
  if (!node || typeof node !== "object") return;

  if (node.baseImage && node.baseImage.imageUrl) assets.baseImages.push(normalizeImage(node.baseImage));
  if (node.maskImage && node.maskImage.imageUrl) assets.maskImages.push(normalizeImage(node.maskImage));

  for (const option of node.options || []) {
    if (option.overlayImage && option.overlayImage.imageUrl) {
      assets.overlays.push(normalizeImage(option.overlayImage));
    }
    if (option.thumbnailImage && option.thumbnailImage.imageUrl) {
      assets.thumbnails.push(normalizeImage(option.thumbnailImage));
    }
  }
}

function dedupeAssets(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item || !item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function fontSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function collectFontUrlsFromHar(har) {
  const entries = har.log && har.log.entries ? har.log.entries : [];
  return entries
    .map((entry) => entry.request && entry.request.url)
    .filter((url) => /\.woff2?(?:\?|$)|\.ttf(?:\?|$)|\.otf(?:\?|$)/i.test(url || ""))
    .filter((url) => /gestalt-fonts/i.test(url));
}

function applyFontUrls(normalized, fontUrls) {
  if (!fontUrls || !fontUrls.length) return normalized;
  const bySlug = new Map();

  for (const url of fontUrls) {
    let name = "";
    try {
      name = path.basename(new URL(url).pathname);
    } catch {
      name = path.basename(url);
    }
    const slug = fontSlug(name.replace(/\.(woff2?|ttf|otf)$/i, "").replace(/-v\d+.*$/i, ""));
    if (slug) bySlug.set(slug, url);
  }

  for (const group of normalized.fontGroups) {
    for (const font of group.options) {
      if (font.fontUrl) continue;
      const url = bySlug.get(fontSlug(font.family));
      if (url) font.fontUrl = url;
    }
  }

  normalized.assets.fonts = dedupeAssets(
    normalized.fontGroups.flatMap((group) =>
      group.options.filter((font) => font.fontUrl).map((font) => ({ url: font.fontUrl, family: font.family }))
    )
  );
  return normalized;
}

function normalizeConfig(config, sourceUrl) {
  const previewSize = (config.preview && config.preview.previewSize) || 400;
  const result = {
    sourceUrl,
    product: {
      asin: config.asin,
      marketplaceId: config.marketplaceId,
      merchantId: config.merchantId,
      sku: config.sku,
      sellerConfigVersion: config.sellerConfigVersion,
      productImageUrl: config.productImageUrl,
      previewSize,
    },
    surfaces: [],
    optionGroups: [],
    textInputs: [],
    imageInputs: [],
    fontGroups: [],
    colorGroups: [],
    regexChoices: {},
    placements: [],
    conditionalRules: [],
    assets: {
      baseImages: [],
      maskImages: [],
      overlays: [],
      thumbnails: [],
      fonts: [],
      productImages: config.productImageUrl ? [{ url: config.productImageUrl }] : [],
    },
    componentPaths: {},
    componentParent: {},
    warnings: [],
    controlOrder: [],
    componentChildren: {},
    componentTypes: {},
  };

  const placementStack = [];
  const surfaceStack = [];
  const unresolvedRegexChoices = new Set();

  for (const [id, choice] of Object.entries(config.regexChoices || {})) {
    result.regexChoices[id] = {
      id: choice.id || id,
      pattern: choice.pattern || "",
      instructions: choice.instructions && choice.instructions.defaultValue,
      description: choice.description && choice.description.defaultValue,
      name: choice.name && choice.name.defaultValue,
    };
  }

  function remember(node, pathParts, parent) {
    if (node.identifier) {
      result.componentPaths[node.identifier] = pathParts.join(" > ");
      if (parent && parent.identifier) result.componentParent[node.identifier] = parent.identifier;
      if (parent && parent.identifier) {
        result.componentChildren[parent.identifier] = result.componentChildren[parent.identifier] || [];
        result.componentChildren[parent.identifier].push(node.identifier);
      }
      result.componentTypes[node.identifier] = node.type || "UnknownComponent";
    }
  }

  function nearestAncestorByType(id, type) {
    let current = id;
    while (result.componentParent[current]) {
      current = result.componentParent[current];
      if (result.componentTypes[current] === type) return current;
    }
    return null;
  }

  function pushControl(type, id) {
    if (!id) return;
    result.controlOrder.push({ type, id });
  }

  function findDefaultOptionId(node) {
    const direct =
      node.defaultOptionIdentifier ||
      node.defaultOptionId ||
      node.selectedOptionIdentifier ||
      node.selectedOptionId ||
      node.initialOptionIdentifier ||
      node.initialOptionId;
    if (direct) return direct;

    const selected = (node.options || []).find((option) => {
      return option.selected || option.isSelected || option.default || option.isDefault;
    });
    return selected ? selected.identifier : "";
  }

  function walk(node, pathParts = [], parent = null, ancestorIds = []) {
    if (!node || typeof node !== "object") return;

    const title = node.name || node.label || node.type || node.identifier || "Component";
    const nextPath = [...pathParts, title].filter(Boolean);
    remember(node, nextPath, parent);

    if (node.conditionalDisplayRules && node.identifier) {
      for (const rule of node.conditionalDisplayRules) {
        result.conditionalRules.push({
          ownerComponentId: node.identifier,
          dependentId: rule.dependentId,
          matcher: rule.matcher,
        });
      }
    }

    if (node.type === "PreviewContainerComponent") {
      const surface = {
        id: node.identifier || `surface-${result.surfaces.length + 1}`,
        label: node.label || node.name || `Surface ${result.surfaces.length + 1}`,
        baseImage: normalizeImage(node.baseImage),
        maskImage: normalizeImage(node.maskImage),
        previewSize,
      };
      result.surfaces.push(surface);
      surfaceStack.push(surface.id);
    }

    if (node.type === "PlacementContainerComponent") {
      const placement = {
        id: node.identifier,
        label: node.label,
        name: node.name,
        surfaceId: surfaceStack[surfaceStack.length - 1] || null,
        position: node.position || { x: 0, y: 0 },
        dimension: node.dimension || { width: previewSize, height: previewSize },
        isFreePlacement: Boolean(node.isFreePlacement),
        childComponentIds: (node.children || []).map((child) => child.identifier).filter(Boolean),
        path: nextPath.join(" > "),
      };
      result.placements.push(placement);
      placementStack.push(placement.id);
    }

    if (node.type === "OptionChooserComponent") {
      const imageOptionCount = (node.options || []).filter((option) => option.thumbnailImage || option.overlayImage).length;
      const hasDropdownName = /dropdown|下拉/i.test([node.name, node.label].filter(Boolean).join(" "));
      const displayHint =
        imageOptionCount === (node.options || []).length && imageOptionCount > 0
          ? "choice-grid"
          : hasDropdownName
            ? "select"
            : "choice-grid";
      pushControl("option", node.identifier);
      result.optionGroups.push({
        id: node.identifier,
        label: node.label || node.name || "Option",
        name: node.name,
        templateIdentifier: node.templateIdentifier,
        displayHint,
        defaultOptionId: findDefaultOptionId(node),
        required: Boolean(node.isRequired),
        instructions: node.instructions || "",
        attribute: node.attribute,
        path: nextPath.join(" > "),
        options: (node.options || []).map((option) => ({
          id: option.identifier,
          label: option.label || option.name || "Option",
          name: option.name,
          cost: option.additionalCost && Number(option.additionalCost.amount || 0),
          overlayImage: normalizeImage(option.overlayImage),
          thumbnailImage: normalizeImage(option.thumbnailImage),
        })),
      });
    }

    if (node.type === "TextInputComponent") {
      pushControl("text", node.identifier);
      result.textInputs.push({
        id: node.identifier,
        label: node.label || node.name || "Text",
        name: node.name,
        required: Boolean(node.isRequired),
        minLength: node.minLength || 0,
        maxLength: node.maxLength || null,
        maxLines: node.maxLines || 1,
        placeholder: node.placeholder || "",
        instructions: node.instructions || "",
        regexChoice: node.regexChoice,
        placementId: placementStack[placementStack.length - 1] || null,
        groupId: nearestAncestorByType(node.identifier, "ContainerComponent"),
        ancestors: ancestorIds,
        path: nextPath.join(" > "),
      });
      if (node.regexChoice) {
        unresolvedRegexChoices.add(node.regexChoice);
      }
    }

    if (node.type === "ImageInputComponent") {
      pushControl("image", node.identifier);
      result.imageInputs.push({
        id: node.identifier,
        label: node.label || node.name || "Image",
        name: node.name,
        required: Boolean(node.isRequired),
        instructions: node.instructions || "",
        placementId: placementStack[placementStack.length - 1] || null,
        groupId: nearestAncestorByType(node.identifier, "ContainerComponent"),
        ancestors: ancestorIds,
        path: nextPath.join(" > "),
      });
    }

    if (node.type === "FontChooserComponent") {
      pushControl("font", node.identifier);
      result.fontGroups.push({
        id: node.identifier,
        label: node.label || node.name || "Font",
        name: node.name,
        defaultFontId: node.defaultFontIdentifier,
        instructions: node.instructions || "",
        groupId: nearestAncestorByType(node.identifier, "ContainerComponent"),
        ancestors: ancestorIds,
        path: nextPath.join(" > "),
        options: (node.fontOptions || []).map((font) => ({
          id: font.identifier,
          family: font.family,
          fontType: font.fontType,
          fontUrl: font.fontUrl || null,
        })),
      });
    }

    if (node.type === "ColorChooserComponent") {
      pushControl("color", node.identifier);
      result.colorGroups.push({
        id: node.identifier,
        label: node.label || node.name || "Color",
        name: node.name,
        defaultColorId: node.defaultColorIdentifier,
        instructions: node.instructions || "",
        groupId: nearestAncestorByType(node.identifier, "ContainerComponent"),
        ancestors: ancestorIds,
        path: nextPath.join(" > "),
        options: (node.colorOptions || []).map((color) => ({
          id: color.identifier,
          name: color.name,
          value: color.value,
        })),
      });
    }

    collectAssetsFromNode(node, result.assets);

    const nextAncestorIds = node.identifier ? [...ancestorIds, node.identifier] : ancestorIds;
    for (const child of node.children || []) walk(child, nextPath, node, nextAncestorIds);

    if (node.type === "PlacementContainerComponent") placementStack.pop();
    if (node.type === "PreviewContainerComponent") surfaceStack.pop();
  }

  walk(config.sellerConfigComponents);

  if (!result.surfaces.length) {
    result.surfaces.push({
      id: "default-surface",
      label: "Surface",
      baseImage: null,
      maskImage: null,
      previewSize,
    });
  }

  result.assets.baseImages = dedupeAssets(result.assets.baseImages);
  result.assets.maskImages = dedupeAssets(result.assets.maskImages);
  result.assets.overlays = dedupeAssets(result.assets.overlays);
  result.assets.thumbnails = dedupeAssets(result.assets.thumbnails);
  result.assets.productImages = dedupeAssets(result.assets.productImages);

  if (!result.assets.baseImages.length) {
    result.warnings.push({
      code: "MISSING_BASE_IMAGE",
      message: "No baseImage was found. The preview will fall back to productImageUrl or a placeholder.",
    });
  }

  if (unresolvedRegexChoices.size) {
    const missingRegexChoices = Array.from(unresolvedRegexChoices).filter((id) => !result.regexChoices[id]);
    if (missingRegexChoices.length) {
      result.warnings.push({
        code: "UNRESOLVED_REGEX_CHOICES",
        message:
          "Some text fields include Amazon regexChoice IDs. This tool validates required/min/max/line count, but exact character rules are not available in the crawled data.",
        regexChoices: missingRegexChoices,
      });
    }
  }

  return result;
}

function readHtmlFromHarEntry(entry) {
  const content = entry.response && entry.response.content;
  if (!content || !content.text) return "";
  if (content.encoding === "base64") {
    return Buffer.from(content.text, "base64").toString("utf8");
  }
  return content.text;
}

function asinFromUrl(rawUrl) {
  try {
    return new URL(rawUrl).searchParams.get("asin") || "";
  } catch {
    return "";
  }
}

function paramsFromCustomFormUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return {
      asin: url.searchParams.get("asin") || "",
      sku: url.searchParams.get("sku") || "",
      merchantId: url.searchParams.get("merchantId") || "",
      marketplaceId: url.searchParams.get("marketplaceId") || "",
    };
  } catch {
    return { asin: "", sku: "", merchantId: "", marketplaceId: "" };
  }
}

function localHarConfigs() {
  const harFiles = fs.readdirSync(__dirname).filter((file) => file.toLowerCase().endsWith(".har"));
  const configs = [];

  for (const file of harFiles) {
    const fullPath = path.join(__dirname, file);
    let har;
    try {
      har = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    } catch {
      continue;
    }

    const htmlEntries = (har.log && har.log.entries ? har.log.entries : []).filter((entry) => {
      const content = entry.response && entry.response.content;
      return content && content.mimeType === "text/html" && content.text;
    });

    for (const entry of htmlEntries) {
      const html = readHtmlFromHarEntry(entry);
      if (!html || !html.includes("gc:app-config")) continue;

      try {
        const appConfig = extractAppConfig(html, {
          status: entry.response.status,
          url: entry.request && entry.request.url,
        });
        configs.push({
          file,
          url: entry.request && entry.request.url,
          appConfig,
          fontUrls: collectFontUrlsFromHar(har),
          summary: {
            file,
            asin: appConfig.asin || "",
            sku: appConfig.sku || "",
            merchantId: appConfig.merchantId || "",
            marketplaceId: appConfig.marketplaceId || "",
          },
        });
      } catch {
        continue;
      }
    }
  }

  return configs;
}

function matchCacheScore(target, appConfig) {
  let score = 0;
  if (target.asin && appConfig.asin === target.asin) score += 100;
  if (target.sku && appConfig.sku === target.sku) score += 40;
  if (target.merchantId && appConfig.merchantId === target.merchantId) score += 20;
  if (target.marketplaceId && appConfig.marketplaceId === target.marketplaceId) score += 5;
  return score;
}

function tryLoadConfigFromLocalHar(rawUrl) {
  const target = paramsFromCustomFormUrl(rawUrl);
  const configs = localHarConfigs();
  const scored = configs
    .map((item) => ({ ...item, score: matchCacheScore(target, item.appConfig) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return null;

  const normalized = applyFontUrls(normalizeConfig(best.appConfig, best.url), best.fontUrls);
  normalized.sourceUrl = rawUrl;
  normalized.loadedFrom = {
    type: "local-har-cache",
    file: best.file,
    matchedUrl: best.url,
    score: best.score,
  };
  normalized.warnings.unshift({
    code: "LOCAL_HAR_FALLBACK",
    message: `Live Amazon fetch did not return config. Loaded cached config from ${best.file}.`,
  });
  return normalized;
}

async function handleCustomForm(req, res) {
  let url = "";
  try {
    const body = await readRequestBody(req);
    const payload = body ? JSON.parse(body) : {};
    url = validateCustomFormUrl(payload.url || "");
    const source = await fetchHtml(url);
    const appConfig = extractAppConfig(source.html, source);
    jsonResponse(res, 200, normalizeConfig(appConfig, source.url || url));
  } catch (error) {
    const cached = url ? tryLoadConfigFromLocalHar(url) : null;
    if (cached) {
      jsonResponse(res, 200, cached);
      return;
    }

    jsonResponse(res, 400, {
      error: error.message,
      detail:
        "Amazon often returns a shell/error page to server-side crawlers without a valid browser session. Set AMAZON_COOKIE or keep a matching .har file in this folder as a fallback.",
      cachedConfigs: localHarConfigs().map((item) => item.summary),
    });
  }
}

async function handleAmazonProductInfoLink(req, res) {
  try {
    const body = await readRequestBody(req);
    const payload = body ? JSON.parse(body) : {};
    const url = validateAmazonProductUrl(payload.url || "");
    const source = await fetchHtml(url);
    let productInfo = null;
    let customizationUrl = "";
    try {
      productInfo = extractProductInfo(source.html, source);
      customizationUrl = amazonCustomizationUrl(productInfo);
    } catch (extractError) {
      customizationUrl = extractCustomizationFormLink(source.html);
      if (!customizationUrl) throw extractError;
    }
    jsonResponse(res, 200, {
      ok: true,
      sourceUrl: source.url || url,
      customizationUrl,
      productInfo,
    });
  } catch (error) {
    jsonResponse(res, 400, {
      ok: false,
      error: error.message,
      detail:
        "Amazon product pages may omit gc:productInfo when the request has no US delivery/browser session. Enable the shop proxy for this process and, if needed, set AMAZON_COOKIE from a browser session that can open the product page.",
    });
  }
}

async function handleAssetProxy(req, res, requestUrl) {
  try {
    const rawUrl = requestUrl.searchParams.get("url");
    const url = validateAssetUrl(rawUrl || "");
    const upstream = await fetch(url, {
      headers: {
        "user-agent": DEFAULT_HEADERS["user-agent"],
        accept: "*/*",
      },
    });

    if (!upstream.ok) {
      jsonResponse(res, upstream.status, { error: `Asset fetch failed with HTTP ${upstream.status}` });
      return;
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const arrayBuffer = await upstream.arrayBuffer();
    const body = Buffer.from(arrayBuffer);
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": body.length,
      "cache-control": "public, max-age=86400",
      "access-control-allow-origin": "*",
    });
    res.end(body);
  } catch (error) {
    jsonResponse(res, 400, { error: error.message });
  }
}

function serveStatic(res, requestUrl) {
  const pathname = requestUrl.pathname === "/" ? "/customizer.html" : requestUrl.pathname;
  const safePath = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    jsonResponse(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      jsonResponse(res, 404, { error: "Not found" });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "content-type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "POST" && requestUrl.pathname === "/api/custom-form") {
    handleCustomForm(req, res);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/amazon/product-info-link") {
    handleAmazonProductInfoLink(req, res);
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/admin/status") {
    handleAdminStatus(req, res).catch((error) => jsonResponse(res, 500, { ok: false, error: error.message }));
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/shopify/convert") {
    handleShopifyConvert(req, res);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/shopify/sync") {
    handleShopifySync(req, res);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/shopify/sync-api") {
    handleShopifySyncApi(req, res);
    return;
  }

  if (req.method === "POST" && (requestUrl.pathname === "/api/shopify/upload" || requestUrl.pathname === "/api/shopify/proxy/upload")) {
    handleShopifyUpload(req, res, requestUrl);
    return;
  }

  if (req.method === "GET" && (requestUrl.pathname === "/api/shopify/proxy/production-preview" || requestUrl.pathname === "/production-preview")) {
    handleProductionPreview(req, res, requestUrl);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/shopify/cleanup") {
    handleShopifyCleanup(req, res);
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/asset") {
    handleAssetProxy(req, res, requestUrl);
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET") {
    serveStatic(res, requestUrl);
    return;
  }

  jsonResponse(res, 405, { error: "Method not allowed" });
});

server.listen(PORT, () => {
  console.log(`Customizer server running at http://localhost:${PORT}`);
});
