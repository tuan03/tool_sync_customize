"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("cart transform merges one customized line with its surcharge add-ons", async () => {
  const { cartTransformRun } = await import("../extensions/cart-transformer/src/cart_transform_run.js");
  const result = cartTransformRun({
    cart: {
      lines: [
        {
          id: "main-1",
          quantity: 1,
          customizationId: { value: "c1" },
          feeComponent: null,
          merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/10" },
        },
        {
          id: "addon-1",
          quantity: 1,
          customizationId: { value: "c1" },
          feeComponent: { value: "5000" },
          merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/20" },
        },
      ],
    },
  });

  assert.deepEqual(result, {
    operations: [
      {
        linesMerge: {
          parentVariantId: "gid://shopify/ProductVariant/10",
          cartLines: [
            { cartLineId: "main-1", quantity: 1 },
            { cartLineId: "addon-1", quantity: 1 },
          ],
        },
      },
    ],
  });
});

test("cart transform skips zero-surcharge customized lines", async () => {
  const { cartTransformRun } = await import("../extensions/cart-transformer/src/cart_transform_run.js");
  const result = cartTransformRun({
    cart: {
      lines: [
        {
          id: "main-1",
          quantity: 1,
          customizationId: { value: "c1" },
          feeComponent: null,
          merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/10" },
        },
      ],
    },
  });

  assert.deepEqual(result, { operations: [] });
});

test("cart transform skips malformed groups with multiple main lines", async () => {
  const { cartTransformRun } = await import("../extensions/cart-transformer/src/cart_transform_run.js");
  const result = cartTransformRun({
    cart: {
      lines: [
        {
          id: "main-1",
          quantity: 1,
          customizationId: { value: "c1" },
          feeComponent: null,
          merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/10" },
        },
        {
          id: "main-2",
          quantity: 1,
          customizationId: { value: "c1" },
          feeComponent: null,
          merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/11" },
        },
        {
          id: "addon-1",
          quantity: 1,
          customizationId: { value: "c1" },
          feeComponent: { value: "5000" },
          merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/20" },
        },
      ],
    },
  });

  assert.deepEqual(result, { operations: [] });
});
