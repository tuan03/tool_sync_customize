"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ShopifyAdmin } = require("../lib/shopify-admin");

test("plans an app-managed fee product without mutating Shopify", async () => {
  const admin = new ShopifyAdmin({ shop: "example.myshopify.com", token: "test-token" });
  admin.findProductByHandle = async () => null;
  const result = await admin.ensurePersonalizationAddon("gid://shopify/Product/123", [8, 3, 5, 5], "USD", false);
  assert.equal(result.action, "create");
  assert.deepEqual(result.amounts, [3, 5, 8]);
  assert.equal(result.input.handle, "personalization-fee-123");
  assert.deepEqual(result.input.variants.map((variant) => variant.price), ["3.00", "5.00", "8.00"]);
  assert(result.input.variants.every((variant) => variant.inventoryItem.tracked === false));
});

test("does not create an add-on product when Etsy has no surcharge", async () => {
  const admin = new ShopifyAdmin({ shop: "example.myshopify.com", token: "test-token" });
  const result = await admin.ensurePersonalizationAddon("123", [], "USD", false);
  assert.equal(result.action, "none");
  assert.equal(result.marker, null);
});

test("plans generic metafields without touching amazon_customizer", async () => {
  const admin = new ShopifyAdmin({ shop: "example.myshopify.com", token: "test-token" });
  admin.product = async () => ({
    id: "gid://shopify/Product/123",
    title: "Personalized rug",
    personalizer: null,
    personalizerAddon: null,
  });
  const result = await admin.setProductPersonalizer("123", { schemaVersion: 2, questions: [] }, null, false);
  assert.equal(result.inputs[0].key, "product_personalizer");
  assert.equal(result.inputs[1].key, "product_personalizer_addon");
  assert(result.inputs.every((input) => input.key !== "amazon_customizer"));
});

test("retries confirmed Shopify throttles", async () => {
  const originalFetch = global.fetch;
  const originalWarn = console.warn;
  let calls = 0;
  console.warn = () => {};
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }),
      };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: { shop: { name: "Example" } } }) };
  };
  try {
    const admin = new ShopifyAdmin({ shop: "throttle-test.myshopify.com", token: "test-token", throttleBaseDelayMs: 0 });
    const data = await admin.graphql("query Shop { shop { name } }");
    assert.equal(data.shop.name, "Example");
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("does not retry ambiguous Shopify mutation failures", async () => {
  const originalFetch = global.fetch;
  const originalError = console.error;
  let calls = 0;
  console.error = () => {};
  global.fetch = async () => {
    calls += 1;
    return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({ error: "server error" }) };
  };
  try {
    const admin = new ShopifyAdmin({ shop: "failure-test.myshopify.com", token: "test-token", throttleBaseDelayMs: 0 });
    await assert.rejects(() => admin.graphql("mutation Create { productCreate(input: {}) { product { id } } }"));
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
    console.error = originalError;
  }
});
