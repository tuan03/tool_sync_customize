"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { normalizeAmazonConfig, validateMetafieldSize, replaceAssetUrls } = require("../lib/amazon-config");
const { ShopifyAdmin } = require("../lib/shopify-admin");

function appConfigFromHar(file) {
  const har = JSON.parse(fs.readFileSync(file, "utf8"));
  const entry = har.log.entries.find((item) => {
    const content = item.response && item.response.content;
    if (!content || content.mimeType !== "text/html" || !content.text) return false;
    const html = content.encoding === "base64" ? Buffer.from(content.text, "base64").toString("utf8") : content.text;
    return html.includes("gc:app-config");
  });
  assert(entry, `No gc:app-config response in ${file}`);
  let html = entry.response.content.text;
  if (entry.response.content.encoding === "base64") html = Buffer.from(html, "base64").toString("utf8");
  const script = (html.match(/<script\b[^>]*type=["']a-state["'][^>]*>[\s\S]*?<\/script>/gi) || []).find((value) => value.includes("gc:app-config"));
  assert(script, `No gc:app-config script in ${file}`);
  const body = script.match(/>([\s\S]*?)<\/script>/i)[1].trim().replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return JSON.parse(body);
}

for (const file of ["amazon.har", "new.har", "new2.har"]) {
  test(`normalizes ${file} into a Shopify-safe config`, () => {
    const config = normalizeAmazonConfig(appConfigFromHar(file));
    assert.equal(config.schemaVersion, 1);
    assert(config.controlOrder.length > 0);
    assert(config.placements.length > 0);
    assert(validateMetafieldSize(config) <= 128 * 1024);
  });
}

test("rejects incomplete raw JSON", () => assert.throws(() => normalizeAmazonConfig({ asin: "x" }), /sellerConfigComponents/));

test("replaces regular and font asset URLs without mutation", () => {
  const source = { image: { url: "https://old/image.png" }, font: { fontUrl: "https://old/font.woff2" } };
  const result = replaceAssetUrls(source, { "https://old/image.png": "https://new/image.png", "https://old/font.woff2": "https://new/font.woff2" });
  assert.equal(result.image.url, "https://new/image.png");
  assert.equal(result.font.fontUrl, "https://new/font.woff2");
  assert.equal(source.image.url, "https://old/image.png");
});

test("enforces an explicit metafield byte limit", () => assert.throws(() => validateMetafieldSize({ value: "x".repeat(100) }, 20), /limited/));

test("surcharge product is unlisted, SEO-hidden, and preserves fee mapping", async () => {
  const admin = new ShopifyAdmin({ shop: "unit-test.myshopify.com", token: "test-token" });
  const result = await admin.ensureSurchargeProduct([5000, 10000, 5000], false);
  assert.equal(result.input.handle, "amazon-customization-addon");
  assert.equal(result.input.status, "UNLISTED");
  assert.deepEqual(result.input.metafields, [{ namespace: "seo", key: "hidden", type: "number_integer", value: "1" }]);
  assert.deepEqual(result.input.variants.map((variant) => variant.price), ["5000", "10000"]);
  assert.deepEqual(Object.keys(result.variants), ["5000", "10000"]);
});
