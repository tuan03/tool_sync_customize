"use strict";

const crypto = require("crypto");
const { normalizeAmazonConfig } = require("./amazon-config");

const SCHEMA_VERSION = 1;
const MAX_PRODUCT_OPTIONS = 3;
const MAX_PRODUCT_VARIANTS = 2048;
const NONE_SUFFIX = "__none";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function parseRawConfig(raw) {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`rawAmazonJson is not valid JSON: ${error.message}`);
  }
}

function optionCost(option, multiplier) {
  const amount = Number(option && option.cost || 0);
  const scale = Number(multiplier);
  if (!Number.isFinite(amount)) return 0;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("priceMultiplier must be a number greater than 0.");
  return Math.round(amount * scale * 100) / 100;
}

function matchesAny(value, patterns = []) {
  return (patterns || []).some((pattern) => {
    try {
      return new RegExp(String(pattern), "i").test(String(value || ""));
    } catch {
      return false;
    }
  });
}

function ruleMatchesGroup(group, rule) {
  const ids = Array.isArray(rule.componentIds) ? rule.componentIds.map(String) : [];
  if (ids.length && ids.includes(String(group.id))) return true;
  if (!rule.labelRegex) return false;
  return matchesAny(group.label, [rule.labelRegex]);
}

function ruleOptionIds(group, rule) {
  const includesById = new Set((rule.includeOptionIds || []).map(String));
  const excludesById = new Set((rule.excludeOptionIds || []).map(String));
  const hasIncludes = includesById.size > 0 || (rule.includeOptionLabelRegex || []).length > 0;
  return group.options.filter((option) => {
    if (option.outOfStock) return false;
    if (excludesById.has(String(option.id)) || matchesAny(option.label, rule.excludeOptionLabelRegex)) return false;
    if (!hasIncludes) return true;
    return includesById.has(String(option.id)) || matchesAny(option.label, rule.includeOptionLabelRegex);
  }).map((option) => option.id);
}

function defaultSelection(groups, rules = []) {
  const result = [];
  for (const group of groups) {
    const rule = (rules || []).find((candidate) => candidate && ruleMatchesGroup(group, candidate));
    if (!rule) continue;
    const optionIds = ruleOptionIds(group, rule);
    if (optionIds.length) result.push({ groupId: group.id, optionIds, selectedBy: "config" });
  }
  return result;
}

function normalizeSelection(groups, selection = [], rules = []) {
  const requested = Array.isArray(selection) && selection.length ? selection : defaultSelection(groups, rules);
  const requestedByGroup = new Map(requested.map((item) => [String(item.groupId || ""), item]));
  const selected = [];
  const skipped = [];
  for (const group of groups) {
    const item = requestedByGroup.get(String(group.id));
    if (!item) continue;
    const ids = new Set((item.optionIds || []).map(String));
    const options = group.options.filter((option) => {
      if (!ids.has(String(option.id))) return false;
      if (option.outOfStock) {
        skipped.push({ groupId: group.id, optionId: option.id, reason: "out_of_stock" });
        return false;
      }
      return true;
    });
    if (options.length) {
      selected.push({ ...group, options, selectedBy: item.selectedBy || "user" });
    } else {
      skipped.push({ groupId: group.id, reason: "no_selectable_options" });
    }
  }
  return { selected, skipped, defaultSelection: defaultSelection(groups, rules) };
}

function parseCustomizeVariantSource(rawAmazonJson, { selection = [], selectionRules = [], priceMultiplier = 1 } = {}) {
  const raw = parseRawConfig(rawAmazonJson);
  const normalized = normalizeAmazonConfig(raw);
  const groups = (normalized.optionGroups || []).map((group) => ({
    id: String(group.id || ""),
    label: String(group.label || group.id || "Option").trim(),
    required: Boolean(group.required),
    defaultOptionId: String(group.defaultOptionId || ""),
    options: (group.options || []).map((option) => ({
      id: String(option.id || ""),
      label: String(option.label || option.id || "Option").trim(),
      cost: optionCost(option, priceMultiplier),
      outOfStock: Boolean(option.outOfStock),
      thumbnailUrl: option.thumbnailImage && option.thumbnailImage.url || "",
      overlayUrl: option.overlayImage && option.overlayImage.url || "",
    })).filter((option) => option.id && option.label),
  })).filter((group) => group.id && group.label && group.options.length);
  const resolved = normalizeSelection(groups, selection, selectionRules);
  return {
    source: normalized.source,
    sourceFingerprint: fingerprint(raw),
    groups,
    selectedGroups: resolved.selected,
    defaultSelection: resolved.defaultSelection,
    skipped: resolved.skipped,
    unsupportedControls: [
      ...(normalized.textInputs || []).map((item) => ({ type: "text", id: item.id, label: item.label })),
      ...(normalized.imageInputs || []).map((item) => ({ type: "image", id: item.id, label: item.label })),
      ...(normalized.fontGroups || []).map((item) => ({ type: "font", id: item.id, label: item.label })),
      ...(normalized.colorGroups || []).map((item) => ({ type: "color", id: item.id, label: item.label })),
      ...(normalized.placements || []).map((item) => ({ type: "placement", id: item.id, label: item.label })),
    ],
  };
}

function money(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function moneyString(value) {
  const number = money(value);
  return number == null ? null : number.toFixed(2);
}

function selectionKey(selectedOptions = []) {
  return JSON.stringify((selectedOptions || []).map((item) => [String(item.name), String(item.value)]));
}

function combinationKey(optionValues = []) {
  return selectionKey(optionValues.map((item) => ({ name: item.optionName, value: item.name })));
}

function combinations(groups) {
  if (!groups.length) return [{ options: [], surcharge: 0, optionIds: [] }];
  let result = [{ options: [], surcharge: 0, optionIds: [] }];
  for (const group of groups) {
    let options = [...group.options];
    if (!group.required) {
      options = [{ id: `${group.id}${NONE_SUFFIX}`, label: "None", cost: 0, synthetic: true }, ...options];
    }
    const preferredId = group.required && group.defaultOptionId && options.some((item) => item.id === group.defaultOptionId)
      ? group.defaultOptionId
      : options[0] && options[0].id;
    options.sort((left, right) => Number(right.id === preferredId) - Number(left.id === preferredId));
    result = result.flatMap((current) => options.map((option) => ({
      options: [...current.options, { groupId: group.id, groupLabel: group.optionName || group.label, optionId: option.id, label: option.label, cost: Number(option.cost || 0) }],
      surcharge: Math.round((current.surcharge + Number(option.cost || 0)) * 100) / 100,
      optionIds: [...current.optionIds, option.id],
    })));
  }
  return result;
}

function markerFromProduct(product) {
  const value = product && product.customizeVariantMarker && product.customizeVariantMarker.value;
  if (!value) return null;
  try {
    const marker = JSON.parse(value);
    return marker && marker.schemaVersion === SCHEMA_VERSION ? marker : null;
  } catch {
    return null;
  }
}

function productFingerprint(product) {
  return fingerprint({
    id: product.id,
    updatedAt: product.updatedAt,
    options: (product.options || []).map((item) => ({ id: item.id, name: item.name, position: item.position, values: (item.optionValues || []).map((value) => value.name) })),
    variants: (product.variants || []).map((variant) => ({
      id: variant.id,
      price: variant.price,
      compareAtPrice: variant.compareAtPrice,
      sku: variant.sku,
      selectedOptions: variant.selectedOptions,
      tracked: Boolean(variant.inventoryItem && variant.inventoryItem.tracked),
      mediaIds: variant.mediaIds || [],
    })),
  });
}

function uniqueOptionNames(selectedGroups, baseOptionNames) {
  const used = new Set(baseOptionNames.map((name) => String(name).toLowerCase()));
  const errors = [];
  const groups = selectedGroups.map((group) => {
    const optionName = String(group.label || "Option").trim();
    const key = optionName.toLowerCase();
    if (used.has(key)) errors.push(`Customize option name conflicts with another product option: ${optionName}`);
    used.add(key);
    const optionLabels = new Set();
    for (const option of group.options || []) {
      const labelKey = String(option.label || "").trim().toLowerCase();
      if (optionLabels.has(labelKey)) errors.push(`Customize group ${optionName} contains duplicate option value: ${option.label}`);
      optionLabels.add(labelKey);
    }
    return { ...group, optionName };
  });
  return { groups, errors };
}

function previousSurcharge(variant, marker) {
  if (!marker || !Array.isArray(marker.groups)) return 0;
  const values = new Map((variant.selectedOptions || []).map((item) => [String(item.name), String(item.value)]));
  let total = 0;
  for (const group of marker.groups) {
    const value = values.get(String(group.optionName));
    if (value == null) continue;
    const option = (group.options || []).find((item) => String(item.label) === value);
    if (option) total += Number(option.cost || 0);
  }
  return Math.round(total * 100) / 100;
}

function baseState(product, marker) {
  const previousNames = new Set((marker && marker.groups || []).map((group) => String(group.optionName)));
  const baseOptionNames = (product.options || []).map((option) => String(option.name)).filter((name) => name.toLowerCase() !== "title" && !previousNames.has(name));
  const byBaseKey = new Map();
  for (const variant of product.variants || []) {
    const baseOptions = (variant.selectedOptions || []).filter((item) => baseOptionNames.includes(String(item.name)));
    const key = selectionKey(baseOptions);
    const surcharge = previousSurcharge(variant, marker);
    const candidate = {
      representativeId: variant.id,
      selectedOptions: baseOptions,
      price: Math.round((Number(variant.price || 0) - surcharge) * 100) / 100,
      compareAtPrice: variant.compareAtPrice == null ? null : Math.round((Number(variant.compareAtPrice) - surcharge) * 100) / 100,
      sku: String(variant.sku || ""),
      taxable: variant.taxable !== false,
      inventoryPolicy: variant.inventoryPolicy || "DENY",
      mediaIds: variant.mediaIds || [],
    };
    if (!byBaseKey.has(key)) byBaseKey.set(key, candidate);
  }
  return { baseOptionNames, variants: [...byBaseKey.values()] };
}

function skuFor(baseSku, optionIds, isPrimary) {
  if (!baseSku || isPrimary) return baseSku || "";
  const suffix = crypto.createHash("sha1").update(optionIds.join("|")).digest("hex").slice(0, 8).toUpperCase();
  return `${baseSku}-${suffix}`.slice(0, 255);
}

function markerPayload(profileSlug, source, groups) {
  return {
    schemaVersion: SCHEMA_VERSION,
    profileSlug: String(profileSlug || ""),
    sourceFingerprint: source.sourceFingerprint,
    sourceAsin: source.source && source.source.asin || "",
    groups: groups.map((group) => ({
      id: group.id,
      optionName: group.optionName,
      required: group.required,
      defaultOptionId: group.required ? (group.defaultOptionId || group.options[0] && group.options[0].id || "") : `${group.id}${NONE_SUFFIX}`,
      options: [
        ...(!group.required ? [{ id: `${group.id}${NONE_SUFFIX}`, label: "None", cost: 0 }] : []),
        ...group.options.map((option) => ({ id: option.id, label: option.label, cost: option.cost })),
      ],
    })),
  };
}

function buildCustomizeVariantPlan(product, source, { profileSlug = "" } = {}) {
  const blockers = [];
  const warnings = [];
  const marker = markerFromProduct(product);
  const base = baseState(product, marker);
  const named = uniqueOptionNames(source.selectedGroups || [], base.baseOptionNames);
  blockers.push(...named.errors);
  const selectedGroups = named.groups;
  if (!selectedGroups.length) blockers.push("Select at least one customize option group.");
  if ((base.baseOptionNames.length + selectedGroups.length) > MAX_PRODUCT_OPTIONS) {
    blockers.push(`Shopify supports at most ${MAX_PRODUCT_OPTIONS} product options; this plan would use ${base.baseOptionNames.length + selectedGroups.length}.`);
  }
  const tracked = (product.variants || []).filter((variant) => variant.inventoryItem && variant.inventoryItem.tracked);
  if (tracked.length) blockers.push(`${tracked.length} existing variant(s) track inventory. Disable inventory tracking before native customize variant sync.`);
  if (!base.variants.length) blockers.push("Shopify product has no base variants.");

  const combos = combinations(selectedGroups);
  const totalVariants = base.variants.length * combos.length;
  if (totalVariants > MAX_PRODUCT_VARIANTS) blockers.push(`Variant plan contains ${totalVariants} variants; Shopify allows at most ${MAX_PRODUCT_VARIANTS}.`);

  const existingByKey = new Map((product.variants || []).map((variant) => [selectionKey(variant.selectedOptions || []), variant]));
  const reservedIds = new Set();
  const targets = [];
  for (const baseVariant of base.variants) {
    combos.forEach((combo, comboIndex) => {
      const optionValues = [
        ...baseVariant.selectedOptions.map((item) => ({ optionName: item.name, name: item.value })),
        ...combo.options.map((item) => ({ optionName: item.groupLabel, name: item.label })),
      ];
      const exact = existingByKey.get(combinationKey(optionValues));
      const target = {
        optionValues,
        price: moneyString(Number(baseVariant.price || 0) + combo.surcharge),
        compareAtPrice: baseVariant.compareAtPrice == null ? null : moneyString(Number(baseVariant.compareAtPrice) + combo.surcharge),
        taxable: baseVariant.taxable,
        inventoryPolicy: baseVariant.inventoryPolicy,
        inventoryItem: { tracked: false },
        sku: skuFor(baseVariant.sku, combo.optionIds, comboIndex === 0),
        surcharge: combo.surcharge,
        baseVariantId: baseVariant.representativeId,
        desiredMediaIds: baseVariant.mediaIds,
      };
      if (exact && !reservedIds.has(exact.id)) {
        target.id = exact.id;
        reservedIds.add(exact.id);
      }
      targets.push(target);
    });
  }
  for (const baseVariant of base.variants) {
    const primary = targets.find((target) => target.baseVariantId === baseVariant.representativeId);
    if (primary && !primary.id && !reservedIds.has(baseVariant.representativeId)) {
      primary.id = baseVariant.representativeId;
      reservedIds.add(baseVariant.representativeId);
    }
  }

  const optionValuesByName = new Map();
  for (const target of targets) {
    for (const item of target.optionValues) {
      if (!optionValuesByName.has(item.optionName)) optionValuesByName.set(item.optionName, []);
      if (!optionValuesByName.get(item.optionName).includes(item.name)) optionValuesByName.get(item.optionName).push(item.name);
    }
  }
  const productOptions = [...base.baseOptionNames, ...selectedGroups.map((group) => group.optionName)].map((name, index) => ({
    name,
    position: index + 1,
    values: (optionValuesByName.get(name) || []).map((value) => ({ name: value })),
  }));
  const usedIds = new Set(targets.map((target) => target.id).filter(Boolean));
  const deletedVariantIds = (product.variants || []).map((item) => item.id).filter((id) => !usedIds.has(id));
  const markerValue = markerPayload(profileSlug, source, selectedGroups);
  const prices = targets.map((item) => Number(item.price)).filter(Number.isFinite);
  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    sourceFingerprint: source.sourceFingerprint,
    productFingerprint: productFingerprint(product),
    product: { id: product.id, title: product.title, optionCount: (product.options || []).length, variantCount: (product.variants || []).length },
    currentProduct: {
      options: (product.options || []).map((item) => ({ id: item.id, name: item.name, position: item.position, values: (item.optionValues || []).map((value) => value.name) })),
      variants: (product.variants || []).map((item) => ({
        id: item.id,
        title: item.title,
        price: item.price,
        compareAtPrice: item.compareAtPrice,
        sku: item.sku,
        selectedOptions: item.selectedOptions,
        tracked: Boolean(item.inventoryItem && item.inventoryItem.tracked),
        mediaIds: item.mediaIds || [],
      })),
    },
    groups: source.groups,
    selectedGroups,
    unsupportedControls: source.unsupportedControls,
    productOptions,
    variants: targets,
    marker: markerValue,
    summary: {
      baseVariantCount: base.variants.length,
      customizeCombinationCount: combos.length,
      targetVariantCount: targets.length,
      createdCount: targets.filter((item) => !item.id).length,
      updatedCount: targets.filter((item) => item.id).length,
      deletedCount: deletedVariantIds.length,
      deletedVariantIds,
      minPrice: prices.length ? Math.min(...prices).toFixed(2) : null,
      maxPrice: prices.length ? Math.max(...prices).toFixed(2) : null,
    },
  };
}

function productSetInput(plan) {
  return {
    productOptions: plan.productOptions,
    variants: plan.variants.map((variant, position) => ({
      ...(variant.id ? { id: variant.id } : {}),
      optionValues: variant.optionValues,
      price: variant.price,
      compareAtPrice: variant.compareAtPrice,
      taxable: variant.taxable,
      inventoryPolicy: variant.inventoryPolicy,
      inventoryItem: variant.inventoryItem,
      sku: variant.sku || null,
      position: position + 1,
    })),
  };
}

module.exports = {
  SCHEMA_VERSION,
  MAX_PRODUCT_OPTIONS,
  MAX_PRODUCT_VARIANTS,
  fingerprint,
  productFingerprint,
  parseCustomizeVariantSource,
  buildCustomizeVariantPlan,
  productSetInput,
  combinations,
  defaultSelection,
  selectionKey,
  combinationKey,
};
