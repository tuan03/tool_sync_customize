"use strict";

const SCHEMA_VERSION = 1;
const MAX_METAFIELD_BYTES = 128 * 1024;

function image(value) {
  if (!value || !value.imageUrl) return null;
  return {
    url: value.imageUrl,
    width: value.dimension && value.dimension.width,
    height: value.dimension && value.dimension.height,
  };
}

function money(value) {
  const amount = value && value.amount;
  return Number.isFinite(Number(amount)) ? Number(amount) : 0;
}

function normalizeAmazonConfig(raw, sourceUrl = "") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Amazon config must be a JSON object.");
  }
  if (!raw.sellerConfigComponents || typeof raw.sellerConfigComponents !== "object") {
    throw new Error("Missing sellerConfigComponents. Paste the complete gc:app-config JSON object.");
  }

  const previewSize = Number(raw.preview && raw.preview.previewSize) || 400;
  const result = {
    schemaVersion: SCHEMA_VERSION,
    source: {
      asin: raw.asin || "",
      marketplaceId: raw.marketplaceId || "",
      merchantId: raw.merchantId || "",
      sku: raw.sku || "",
      sellerConfigVersion: raw.sellerConfigVersion || "",
      sourceUrl,
    },
    product: { productImageUrl: raw.productImageUrl || "", previewSize },
    surfaces: [], optionGroups: [], textInputs: [], imageInputs: [],
    fontGroups: [], colorGroups: [], placements: [], conditionalRules: [],
    regexChoices: {}, controlOrder: [], componentParent: {}, componentTypes: {},
    assets: [], warnings: [], pricing: { amounts: [], currencyCode: "" },
  };
  const placementStack = [];
  const surfaceStack = [];
  const assetMap = new Map();

  function addAsset(asset, role) {
    if (!asset || !asset.url) return asset;
    const key = asset.url;
    if (!assetMap.has(key)) assetMap.set(key, { ...asset, roles: [] });
    const item = assetMap.get(key);
    if (!item.roles.includes(role)) item.roles.push(role);
    return asset;
  }
  function defaultOption(node) {
    const direct = node.defaultOptionIdentifier || node.defaultOptionId || node.selectedOptionIdentifier || node.selectedOptionId;
    if (direct) return direct;
    const selected = (node.options || []).find((item) => item.selected || item.isSelected || item.default || item.isDefault);
    return selected ? selected.identifier : "";
  }
  function nearestParent(id, type) {
    let current = id;
    while (result.componentParent[current]) {
      current = result.componentParent[current];
      if (result.componentTypes[current] === type) return current;
    }
    return null;
  }
  function pushControl(type, id) {
    if (id) result.controlOrder.push({ type, id });
  }

  function walk(node, parent = null, ancestors = [], path = []) {
    if (!node || typeof node !== "object") return;
    const id = node.identifier || "";
    const title = node.label || node.name || node.type || id || "Component";
    const nextPath = [...path, title];
    if (id) {
      result.componentTypes[id] = node.type || "UnknownComponent";
      if (parent && parent.identifier) result.componentParent[id] = parent.identifier;
    }
    for (const rule of node.conditionalDisplayRules || []) {
      result.conditionalRules.push({
        ownerComponentId: id,
        dependentId: rule.dependentId || "",
        matcher: rule.matcher || {},
      });
    }

    if (node.type === "PreviewContainerComponent") {
      const surface = {
        id: id || `surface-${result.surfaces.length + 1}`,
        label: node.label || node.name || `Surface ${result.surfaces.length + 1}`,
        baseImage: addAsset(image(node.baseImage), "base"),
        maskImage: addAsset(image(node.maskImage), "mask"),
        previewSize,
      };
      result.surfaces.push(surface);
      surfaceStack.push(surface.id);
    }
    if (node.type === "PlacementContainerComponent") {
      result.placements.push({
        id, label: node.label || node.name || "Placement",
        surfaceId: surfaceStack.at(-1) || null,
        position: node.position || { x: 0, y: 0 },
        dimension: node.dimension || { width: previewSize, height: previewSize },
        isFreePlacement: Boolean(node.isFreePlacement),
      });
      placementStack.push(id);
    }
    if (node.type === "OptionChooserComponent") {
      pushControl("option", id);
      const options = (node.options || []).map((option) => ({
        id: option.identifier,
        label: option.label || option.name || "Option",
        cost: money(option.additionalCost),
        overlayImage: addAsset(image(option.overlayImage), "overlay"),
        thumbnailImage: addAsset(image(option.thumbnailImage), "thumbnail"),
      }));
      result.optionGroups.push({
        id, label: node.label || node.name || "Option", required: Boolean(node.isRequired),
        defaultOptionId: defaultOption(node), instructions: node.instructions || "", options,
        displayHint: options.length && options.every((item) => item.thumbnailImage || item.overlayImage) ? "choice-grid" : "select",
      });
    }
    if (node.type === "TextInputComponent") {
      pushControl("text", id);
      result.textInputs.push({
        id, label: node.label || node.name || "Text", required: Boolean(node.isRequired),
        minLength: Number(node.minLength) || 0, maxLength: node.maxLength == null ? null : Number(node.maxLength),
        maxLines: Number(node.maxLines) || 1, placeholder: node.placeholder || "", instructions: node.instructions || "",
        regexChoice: node.regexChoice || "", placementId: placementStack.at(-1) || null,
        groupId: nearestParent(id, "ContainerComponent"), ancestors,
      });
    }
    if (node.type === "ImageInputComponent") {
      pushControl("image", id);
      result.imageInputs.push({
        id, label: node.label || node.name || "Image", required: Boolean(node.isRequired),
        instructions: node.instructions || "", placementId: placementStack.at(-1) || null,
        groupId: nearestParent(id, "ContainerComponent"), ancestors,
      });
    }
    if (node.type === "FontChooserComponent") {
      pushControl("font", id);
      result.fontGroups.push({
        id, label: node.label || node.name || "Font", defaultFontId: node.defaultFontIdentifier || "",
        groupId: nearestParent(id, "ContainerComponent"), ancestors,
        options: (node.fontOptions || []).map((font) => {
          const fontUrl = font.fontUrl || "";
          if (fontUrl) addAsset({ url: fontUrl }, "font");
          return { id: font.identifier, family: font.family || font.name || "Arial", fontType: font.fontType || "", fontUrl };
        }),
      });
    }
    if (node.type === "ColorChooserComponent") {
      pushControl("color", id);
      result.colorGroups.push({
        id, label: node.label || node.name || "Color", defaultColorId: node.defaultColorIdentifier || "",
        groupId: nearestParent(id, "ContainerComponent"), ancestors,
        options: (node.colorOptions || []).map((color) => ({ id: color.identifier, name: color.name || "Color", value: color.value || "#000000" })),
      });
    }

    const nextAncestors = id ? [...ancestors, id] : ancestors;
    for (const child of node.children || []) walk(child, node, nextAncestors, nextPath);
    if (node.type === "PlacementContainerComponent") placementStack.pop();
    if (node.type === "PreviewContainerComponent") surfaceStack.pop();
  }

  for (const [id, choice] of Object.entries(raw.regexChoices || {})) {
    result.regexChoices[id] = {
      pattern: choice.pattern || "",
      instructions: choice.instructions && choice.instructions.defaultValue || "",
      description: choice.description && choice.description.defaultValue || "",
    };
  }
  walk(raw.sellerConfigComponents);
  result.assets = [...assetMap.values()];
  if (result.product.productImageUrl) addAsset({ url: result.product.productImageUrl }, "product");
  result.assets = [...assetMap.values()];
  result.pricing.amounts = [...new Set(result.optionGroups.flatMap((group) => group.options.map((option) => option.cost)).filter((cost) => cost > 0))].sort((a, b) => a - b);
  if (!result.surfaces.length) result.warnings.push({ code: "NO_SURFACE", message: "No preview surface was found." });
  return result;
}

function byteSize(config) {
  return Buffer.byteLength(JSON.stringify(config), "utf8");
}

function validateMetafieldSize(config, limit = MAX_METAFIELD_BYTES) {
  const bytes = byteSize(config);
  if (bytes > limit) throw new Error(`Normalized config is ${bytes} bytes; Shopify JSON metafields are limited to ${limit} bytes.`);
  return bytes;
}

function replaceAssetUrls(config, replacements) {
  const cloned = JSON.parse(JSON.stringify(config));
  function walk(value) {
    if (!value || typeof value !== "object") return;
    if (typeof value.url === "string" && replacements[value.url]) value.url = replacements[value.url];
    if (typeof value.fontUrl === "string" && replacements[value.fontUrl]) value.fontUrl = replacements[value.fontUrl];
    for (const child of Object.values(value)) walk(child);
  }
  walk(cloned);
  return cloned;
}

module.exports = { SCHEMA_VERSION, MAX_METAFIELD_BYTES, normalizeAmazonConfig, byteSize, validateMetafieldSize, replaceAssetUrls };
