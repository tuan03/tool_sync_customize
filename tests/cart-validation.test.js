"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("cart validation accepts matching main and fee lines", async () => {
  const { cartValidationsGenerateRun } = await import("../extensions/cart-validation/src/cart_validations_generate_run.js");
  const config = { optionGroups: [{ id: "g", options: [{ id: "paid", cost: 5000 }] }] };
  const result = cartValidationsGenerateRun({ cart: { lines: [
    { id:"1", quantity:1, customizationId:{value:"c1"}, expectedFee:{value:"5000"}, selectedOptions:{value:'{"g":"paid"}'}, feeComponent:null, merchandise:{id:"gid://shopify/ProductVariant/10",product:{customizer:{value:JSON.stringify(config)}}} },
    { id:"2", quantity:1, customizationId:{value:"c1"}, feeComponent:{value:"5000"}, parentVariant:{value:"10"}, merchandise:{id:"gid://shopify/ProductVariant/20",product:{customizer:null}} },
  ] } });
  assert.deepEqual(result, { operations: [] });
});

test("cart validation rejects a missing surcharge", async () => {
  const { cartValidationsGenerateRun } = await import("../extensions/cart-validation/src/cart_validations_generate_run.js");
  const config = { optionGroups: [{ id: "g", options: [{ id: "paid", cost: 5000 }] }] };
  const result = cartValidationsGenerateRun({ cart: { lines: [
    { id:"1", quantity:1, customizationId:{value:"c1"}, expectedFee:{value:"5000"}, selectedOptions:{value:'{"g":"paid"}'}, feeComponent:null, merchandise:{id:"gid://shopify/ProductVariant/10",product:{customizer:{value:JSON.stringify(config)}}} },
  ] } });
  assert.equal(result.operations[0].validationAdd.errors.length, 1);
});
