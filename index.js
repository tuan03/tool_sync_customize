const fs = require("fs");

const DEFAULT_INPUT = "amazon.har";
const DEFAULT_OUTPUT = "res.json";

function isUrl(value) {
  return /^https?:\/\//i.test(value);
}

async function fetchHtml(url) {
  const headers = {
    "accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    "pragma": "no-cache",
    "sec-ch-ua":
      '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
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

  if (process.env.AMAZON_COOKIE) {
    headers.cookie = process.env.AMAZON_COOKIE;
  }

  const response = await fetch(url, {
    redirect: "follow",
    headers,
  });

  const html = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }

  return {
    html,
    status: response.status,
    url: response.url,
  };
}

function readHtmlFromHar(harPath) {
  const har = JSON.parse(fs.readFileSync(harPath, "utf8"));
  const htmlEntry = har.log.entries.find((entry) => {
    const content = entry.response && entry.response.content;
    return content && content.mimeType === "text/html" && content.text;
  });

  if (!htmlEntry) {
    throw new Error("No text/html response found in HAR");
  }

  const content = htmlEntry.response.content;
  if (content.encoding === "base64") {
    return Buffer.from(content.text, "base64").toString("utf8");
  }

  return content.text;
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractAppConfig(html, sourceInfo = {}) {
  const scripts = html.match(
    /<script\b[^>]*type=["']a-state["'][^>]*>[\s\S]*?<\/script>/gi
  );

  for (const script of scripts || []) {
    if (!script.includes("gc:app-config")) continue;

    const bodyMatch = script.match(/>([\s\S]*?)<\/script>/i);
    if (!bodyMatch) continue;

    return JSON.parse(decodeHtmlEntities(bodyMatch[1].trim()));
  }

  if (/captcha|robot check|enter the characters/i.test(html)) {
    throw new Error("Amazon returned a CAPTCHA/robot-check page, not customization HTML");
  }

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleText = title ? decodeHtmlEntities(title[1].replace(/\s+/g, " ").trim()) : "unknown";
  const detail = [
    `Amazon gc:app-config state not found in HTML`,
    sourceInfo.status ? `status=${sourceInfo.status}` : null,
    sourceInfo.url ? `url=${sourceInfo.url}` : null,
    `title=${titleText}`,
  ]
    .filter(Boolean)
    .join("; ");

  throw new Error(detail);
}

function collectConfig(config) {
  const placements = [];
  const optionGroups = [];

  function walk(node, path = []) {
    if (!node || typeof node !== "object") return;

    const title = node.name || node.label || node.type || node.identifier;
    const nextPath = [...path, title].filter(Boolean);

    if (node.type === "PlacementContainerComponent") {
      placements.push({
        path: nextPath.join(" > "),
        identifier: node.identifier,
        name: node.name,
        label: node.label,
        position: node.position,
        dimension: node.dimension,
        isFreePlacement: node.isFreePlacement,
        childTypes: (node.children || []).map((child) => child.type),
      });
    }

    if (node.type === "OptionChooserComponent") {
      optionGroups.push({
        path: nextPath.join(" > "),
        identifier: node.identifier,
        name: node.name,
        label: node.label,
        options: (node.options || []).map((option) => ({
          identifier: option.identifier,
          name: option.name,
          label: option.label,
          cost: option.additionalCost && option.additionalCost.amount,
          overlayImage: option.overlayImage,
          thumbnailImage: option.thumbnailImage,
        })),
      });
    }

    for (const child of node.children || []) {
      walk(child, nextPath);
    }
  }

  walk(config.sellerConfigComponents);

  return {
    asin: config.asin,
    marketplaceId: config.marketplaceId,
    sellerConfigVersion: config.sellerConfigVersion,
    previewSize: config.preview && config.preview.previewSize,
    placements,
    optionGroups,
  };
}

async function main() {
  const input = process.argv[2] || DEFAULT_INPUT;
  const output = process.argv[3] || DEFAULT_OUTPUT;
  const source = isUrl(input)
    ? await fetchHtml(input)
    : { html: readHtmlFromHar(input), url: input };
  const config = extractAppConfig(source.html, source);
  fs.writeFileSync(output, JSON.stringify(collectConfig(config), null, 2));
  console.log(`Wrote ${output}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
