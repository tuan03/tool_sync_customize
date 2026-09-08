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
