"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseCustomizeVariantSource,
  buildCustomizeVariantPlan,
  productSetInput,
} = require("../lib/customize-variants");

function rawConfig() {
  return {
    asin: "B0WRYDECO1",
    sellerConfigComponents: {
      type: "ContainerComponent",
      identifier: "root",
      children: [
        {
          type: "OptionChooserComponent",
          identifier: "size-component",
          label: "Frame Size",
          isRequired: true,
          defaultOptionIdentifier: "size-small",
          options: [
            { identifier: "size-small", label: "Small", additionalCost: { amount: 0 } },
            { identifier: "size-large", label: "Large", additionalCost: { amount: 10 } },
            { identifier: "size-sold", label: "Sold Out", additionalCost: { amount: 15 }, outOfStock: true },
          ],
        },
        {
          type: "OptionChooserComponent",
          identifier: "gift-component",
          label: "Gift Wrap",
          isRequired: false,
          options: [
            { identifier: "gift-yes", label: "Yes", additionalCost: { amount: 2.5 } },
          ],
        },
        { type: "TextInputComponent", identifier: "name-input", label: "Name", isRequired: true },
      ],
    },
  };
}

function product(overrides = {}) {
  return {
    id: "gid://shopify/Product/100",
    title: "Wrydeco Product",
    updatedAt: "2026-08-12T00:00:00Z",
    options: [{ id: "gid://shopify/ProductOption/1", name: "Color", position: 1, optionValues: [{ id: "1", name: "Red" }, { id: "2", name: "Blue" }] }],
    variants: [
      {
        id: "gid://shopify/ProductVariant/1",
        price: "20.00",
        compareAtPrice: "25.00",
        sku: "WRY-RED",
        taxable: true,
        inventoryPolicy: "DENY",
        selectedOptions: [{ name: "Color", value: "Red" }],
        inventoryItem: { tracked: false },
        mediaIds: ["gid://shopify/MediaImage/1"],
      },
      {
        id: "gid://shopify/ProductVariant/2",
        price: "22.00",
        compareAtPrice: null,
        sku: "WRY-BLUE",
        taxable: true,
        inventoryPolicy: "CONTINUE",
        selectedOptions: [{ name: "Color", value: "Blue" }],
        inventoryItem: { tracked: false },
        mediaIds: ["gid://shopify/MediaImage/2"],
      },
    ],
    customizeVariantMarker: null,
    ...overrides,
  };
}

test("parses finite option groups, config defaults, costs and unsupported controls", () => {
  const source = parseCustomizeVariantSource(rawConfig(), {
    selectionRules: [{ componentIds: ["size-component"] }],
    priceMultiplier: 2,
  });
  assert.equal(source.groups.length, 2);
  assert.equal(source.selectedGroups.length, 1);
  assert.deepEqual(source.selectedGroups[0].options.map((item) => item.id), ["size-small", "size-large"]);
  assert.equal(source.selectedGroups[0].options[1].cost, 20);
  assert.equal(source.defaultSelection[0].selectedBy, "config");
  assert.deepEqual(source.unsupportedControls, [{ type: "text", id: "name-input", label: "Name" }]);
});

test("UI selection excludes out-of-stock values and overrides config defaults", () => {
  const source = parseCustomizeVariantSource(rawConfig(), {
    selectionRules: [{ componentIds: ["size-component"] }],
    selection: [{ groupId: "size-component", optionIds: ["size-large", "size-sold"] }],
  });
  assert.deepEqual(source.selectedGroups[0].options.map((item) => item.id), ["size-large"]);
  assert(source.skipped.some((item) => item.optionId === "size-sold" && item.reason === "out_of_stock"));
});

test("multiplies existing variants by customize combinations and adds surcharge to both prices", () => {
  const source = parseCustomizeVariantSource(rawConfig(), {
    selection: [{ groupId: "size-component", optionIds: ["size-small", "size-large"] }],
  });
  const plan = buildCustomizeVariantPlan(product(), source, { profileSlug: "wrydeco" });
  assert.equal(plan.ok, true);
  assert.equal(plan.summary.baseVariantCount, 2);
  assert.equal(plan.summary.customizeCombinationCount, 2);
  assert.equal(plan.summary.targetVariantCount, 4);
  const redLarge = plan.variants.find((item) => item.optionValues.some((value) => value.name === "Red") && item.optionValues.some((value) => value.name === "Large"));
  assert.equal(redLarge.price, "30.00");
  assert.equal(redLarge.compareAtPrice, "35.00");
  assert.deepEqual(redLarge.desiredMediaIds, ["gid://shopify/MediaImage/1"]);
  assert.equal(plan.variants.filter((item) => item.id).length, 2);
  assert.equal(productSetInput(plan).variants.length, 4);
});

test("adds None to optional groups and keeps the original variant ID on the no-surcharge combination", () => {
  const source = parseCustomizeVariantSource(rawConfig(), {
    selection: [{ groupId: "gift-component", optionIds: ["gift-yes"] }],
  });
  const single = product({ options: [], variants: [product().variants[0]] });
  single.variants[0].selectedOptions = [{ name: "Title", value: "Default Title" }];
  const plan = buildCustomizeVariantPlan(single, source);
  assert.equal(plan.ok, true);
  assert.equal(plan.summary.targetVariantCount, 2);
  const none = plan.variants.find((item) => item.optionValues.some((value) => value.name === "None"));
  const wrapped = plan.variants.find((item) => item.optionValues.some((value) => value.name === "Yes"));
  assert.equal(none.id, "gid://shopify/ProductVariant/1");
  assert.equal(none.price, "20.00");
  assert.equal(wrapped.price, "22.50");
});

test("blocks tracked inventory and plans over three Shopify options", () => {
  const source = parseCustomizeVariantSource(rawConfig(), {
    selection: [
      { groupId: "size-component", optionIds: ["size-small"] },
      { groupId: "gift-component", optionIds: ["gift-yes"] },
    ],
  });
  const trackedProduct = product();
  trackedProduct.variants[0].inventoryItem.tracked = true;
  const trackedPlan = buildCustomizeVariantPlan(trackedProduct, source);
  assert.equal(trackedPlan.ok, false);
  assert(trackedPlan.blockers.some((item) => item.includes("track inventory")));

  const tooManyOptions = product({
    options: [
      { name: "Color", optionValues: [{ name: "Red" }] },
      { name: "Material", optionValues: [{ name: "Wood" }] },
    ],
  });
  tooManyOptions.variants = [{ ...product().variants[0], selectedOptions: [{ name: "Color", value: "Red" }, { name: "Material", value: "Wood" }] }];
  const optionPlan = buildCustomizeVariantPlan(tooManyOptions, source);
  assert.equal(optionPlan.ok, false);
  assert(optionPlan.blockers.some((item) => item.includes("at most 3 product options")));
});

test("rebuilds baseline prices from the marker so repeat sync does not compound surcharge", () => {
  const source = parseCustomizeVariantSource(rawConfig(), {
    selection: [{ groupId: "size-component", optionIds: ["size-small", "size-large"] }],
  });
  const first = buildCustomizeVariantPlan(product({ options: [], variants: [product().variants[0]] }), source, { profileSlug: "wrydeco" });
  assert.equal(first.ok, true);
  const currentVariants = first.variants.map((item, index) => ({
    id: item.id || `gid://shopify/ProductVariant/${10 + index}`,
    price: item.price,
    compareAtPrice: item.compareAtPrice,
    sku: item.sku,
    taxable: item.taxable,
    inventoryPolicy: item.inventoryPolicy,
    selectedOptions: item.optionValues.map((value) => ({ name: value.optionName, value: value.name })),
    inventoryItem: { tracked: false },
    mediaIds: item.desiredMediaIds,
  }));
  const rerunProduct = product({
    options: [{ name: "Frame Size", position: 1, optionValues: [{ name: "Small" }, { name: "Large" }] }],
    variants: currentVariants,
    customizeVariantMarker: { value: JSON.stringify(first.marker) },
  });
  const second = buildCustomizeVariantPlan(rerunProduct, source, { profileSlug: "wrydeco" });
  assert.equal(second.ok, true);
  assert.deepEqual(second.variants.map((item) => item.price), first.variants.map((item) => item.price));
  assert.equal(second.summary.createdCount, 0);
  assert.equal(second.summary.deletedCount, 0);
});
