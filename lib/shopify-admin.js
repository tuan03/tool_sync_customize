"use strict";

const crypto = require("crypto");
const { loadEnv } = require("./env");
const { configureProxy } = require("./proxy");

loadEnv();
configureProxy();

function throwUserErrors(items) {
  if (!Array.isArray(items) || !items.length) return;
  const error = new Error(items.map((item) => item.message).join("; "));
  error.userErrors = items;
  throw error;
}

class ShopifyAdmin {
  constructor(options = {}) {
    this.shop = String(options.shop || process.env.SHOPIFY_SHOP || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
    this.token = options.token || process.env.SHOPIFY_ACCESS_TOKEN || "";
    this.version = options.version || process.env.SHOPIFY_API_VERSION || "2026-04";
    if (!this.shop || !this.token) throw new Error("SHOPIFY_SHOP and SHOPIFY_ACCESS_TOKEN are required.");
  }

  tokenFingerprint() {
    return {
      prefix: this.token.slice(0, 5),
      sha256: crypto.createHash("sha256").update(this.token).digest("hex").slice(0, 12),
    };
  }

  graphqlLogContext(query, errors = []) {
    const normalizedErrors = Array.isArray(errors) ? errors : [errors];
    const operation = String(query || "").match(/\b(query|mutation)\s+([A-Za-z0-9_]+)/);
    return {
      shop: this.shop,
      apiVersion: this.version,
      clientId: process.env.SHOPIFY_CLIENT_ID || "",
      token: this.tokenFingerprint(),
      operation: operation ? operation[2] : "anonymous",
      errorMessages: normalizedErrors.map((error) => error && (error.message || error.error || String(error))).filter(Boolean),
      errorCodes: [...new Set(normalizedErrors.map((error) => error && error.extensions && error.extensions.code).filter(Boolean))],
      errorPaths: normalizedErrors.map((error) => error && error.path).filter(Boolean),
    };
  }

  async graphql(query, variables = {}) {
    const startedAt = Date.now();
    const response = await fetch(`https://${this.shop}/admin/api/${this.version}/graphql.json`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": this.token },
      body: JSON.stringify({ query, variables }),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.errors) {
      const errors = Array.isArray(json.errors) ? json.errors : json.errors ? [json.errors] : [json];
      console.error("[ShopifyAdmin] GraphQL request failed", {
        ...this.graphqlLogContext(query, errors),
        httpStatus: response.status,
        elapsedMs: Date.now() - startedAt,
        rawErrors: errors,
      });
      throw new Error(JSON.stringify(errors));
    }
    return json.data;
  }

  async accessDiagnostics(orderRef = "") {
    const diagnostics = {
      shop: this.shop,
      apiVersion: this.version,
      clientId: process.env.SHOPIFY_CLIENT_ID || "",
      token: this.tokenFingerprint(),
      scopes: [],
      hasReadOrdersScope: false,
      orderObject: { ok: false, error: "" },
    };

    const appData = await this.graphql(`query CurrentAppAccess {
      currentAppInstallation {
        accessScopes {
          handle
        }
      }
    }`);
    diagnostics.scopes = (appData.currentAppInstallation?.accessScopes || []).map((scope) => scope.handle).sort();
    diagnostics.hasReadOrdersScope = diagnostics.scopes.includes("read_orders");

    try {
      if (orderRef) {
        const normalized = this.normalizeOrderRef(orderRef);
        if (normalized.gid) {
          await this.graphql(`query OrderAccessCheck($id: ID!) {
            order(id: $id) {
              id
              name
            }
          }`, { id: normalized.gid });
        } else {
          await this.graphql(`query OrdersAccessCheck($query: String!) {
            orders(first: 1, query: $query) {
              nodes {
                id
                name
              }
            }
          }`, { query: `name:${normalized.searchName}` });
        }
      } else {
        await this.graphql(`query OrdersAccessCheck {
          orders(first: 1) {
            nodes {
              id
              name
            }
          }
        }`);
      }
      diagnostics.orderObject = { ok: true, error: "" };
    } catch (error) {
      diagnostics.orderObject = { ok: false, error: error.message };
    }

    console.log("[ShopifyAdmin] Access diagnostics", {
      ...diagnostics,
      scopes: {
        count: diagnostics.scopes.length,
        hasReadOrders: diagnostics.hasReadOrdersScope,
        hasWriteOrders: diagnostics.scopes.includes("write_orders"),
        hasCustomerReadOrders: diagnostics.scopes.includes("customer_read_orders"),
      },
    });

    return diagnostics;
  }

  async product(id) {
    const gid = String(id).startsWith("gid://") ? String(id) : `gid://shopify/Product/${id}`;
    const data = await this.graphql(`query Product($id: ID!) {
      product(id: $id) {
        id
        title
        handle
        status
        options {
          name
          optionValues {
            name
          }
        }
        variants(first: 250) {
          nodes {
            id
            title
            price
            sku
            selectedOptions {
              name
              value
            }
          }
        }
        metafield(namespace: "custom", key: "amazon_customizer") { id value type compareDigest }
      }
    }`, { id: gid });
    if (!data.product) throw new Error(`Shopify product not found: ${id}`);
    return data.product;
  }

  async productCustomizeVariantState(id) {
    const gid = String(id).startsWith("gid://") ? String(id) : `gid://shopify/Product/${id}`;
    const query = `query CustomizeVariantProduct($id: ID!, $after: String) {
      product(id: $id) {
        id
        title
        updatedAt
        options {
          id
          name
          position
          optionValues { id name }
        }
        variants(first: 250, after: $after) {
          nodes {
            id
            title
            price
            compareAtPrice
            sku
            taxable
            inventoryPolicy
            selectedOptions { name value }
            inventoryItem { tracked }
            media(first: 50) { nodes { id } }
          }
          pageInfo { hasNextPage endCursor }
        }
        customizeVariantMarker: metafield(namespace: "custom", key: "amazon_customize_variant_sync") {
          id
          type
          value
        }
      }
    }`;
    let after = null;
    let product = null;
    const variants = [];
    do {
      const data = await this.graphql(query, { id: gid, after });
      if (!data.product) throw new Error(`Shopify product not found: ${id}`);
      if (!product) product = data.product;
      const connection = data.product.variants || {};
      variants.push(...(connection.nodes || []).map((variant) => ({
        ...variant,
        mediaIds: ((variant.media || {}).nodes || []).map((item) => item.id).filter(Boolean),
      })));
      after = connection.pageInfo && connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (after);
    product.variants = variants;
    return product;
  }

  async syncCustomizeVariantProduct(productId, input, synchronous = true) {
    const gid = String(productId).startsWith("gid://") ? String(productId) : `gid://shopify/Product/${productId}`;
    const data = await this.graphql(`mutation SyncCustomizeVariants($identifier: ProductSetIdentifiers!, $input: ProductSetInput!, $synchronous: Boolean!) {
      productSet(identifier: $identifier, input: $input, synchronous: $synchronous) {
        product { id title }
        productSetOperation { id status userErrors { field message code } }
        userErrors { field message code }
      }
    }`, { identifier: { id: gid }, input, synchronous });
    const payload = data.productSet;
    throwUserErrors(payload.userErrors);
    if (synchronous) return { product: payload.product, operation: null };
    const operation = await this.waitForProductSetOperation(payload.productSetOperation && payload.productSetOperation.id);
    return { product: operation.product || { id: gid }, operation };
  }

  async waitForProductSetOperation(id, attempts = 120) {
    if (!id) throw new Error("Shopify did not return a productSet operation ID.");
    for (let index = 0; index < attempts; index += 1) {
      const data = await this.graphql(`query ProductSetOperationStatus($id: ID!) {
        productOperation(id: $id) {
          ... on ProductSetOperation {
            id
            status
            product { id title }
            userErrors { field message code }
          }
        }
      }`, { id });
      const operation = data.productOperation;
      if (!operation) throw new Error(`Shopify productSet operation not found: ${id}`);
      throwUserErrors(operation.userErrors);
      if (["COMPLETE", "COMPLETED"].includes(operation.status)) return operation;
      if (["FAILED", "CANCELED", "CANCELLED"].includes(operation.status)) {
        throw new Error(`Shopify productSet operation ${operation.status.toLowerCase()}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("Timed out while waiting for Shopify productSet operation.");
  }

  async setCustomizeVariantMarker(productId, marker) {
    const gid = String(productId).startsWith("gid://") ? String(productId) : `gid://shopify/Product/${productId}`;
    const input = {
      ownerId: gid,
      namespace: "custom",
      key: "amazon_customize_variant_sync",
      type: "json",
      value: JSON.stringify(marker),
    };
    const data = await this.graphql(`mutation SetCustomizeVariantMarker($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key type updatedAt }
        userErrors { field message code }
      }
    }`, { metafields: [input] });
    const payload = data.metafieldsSet;
    throwUserErrors(payload.userErrors);
    return payload.metafields[0];
  }

  async appendVariantMedia(productId, variantMedia = []) {
    const gid = String(productId).startsWith("gid://") ? String(productId) : `gid://shopify/Product/${productId}`;
    const items = (variantMedia || []).filter((item) => item.variantId && item.mediaIds && item.mediaIds.length);
    if (!items.length) return { action: "none", count: 0 };
    const data = await this.graphql(`mutation AppendCustomizeVariantMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
      productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
        productVariants { id }
        userErrors { field message }
      }
    }`, { productId: gid, variantMedia: items });
    const payload = data.productVariantAppendMedia;
    const errors = (payload.userErrors || []).filter((item) => !/already has attached media/i.test(item.message || ""));
    throwUserErrors(errors);
    return { action: "appended", count: items.length };
  }

  buildManagedVariantCombos(paidGroups = [], basePrice = 0) {
    const combos = [];
    const sourceGroups = paidGroups.map((group) => ({
      name: String(group.label || group.name || "Option"),
      options: (group.variantOptions || group.options || []).map((option) => ({
        label: String(option.label || option.name || "Option"),
        cost: Number(option.cost || 0),
      })),
    })).filter((group) => group.options.length);
    if (!sourceGroups.length) return combos;
    const walk = (index, selections, surcharge) => {
      if (index >= sourceGroups.length) {
        combos.push({
          optionValues: selections.map((selection) => ({ optionName: selection.groupName, name: selection.label })),
          price: (Math.round((basePrice + surcharge) * 100) / 100).toFixed(2),
          surcharge,
        });
        return;
      }
      const group = sourceGroups[index];
      for (const option of group.options) {
        walk(index + 1, [...selections, { groupName: group.name, label: option.label }], surcharge + Number(option.cost || 0));
      }
    };
    walk(0, [], 0);
    return combos;
  }

  existingCustomizerConfig(product) {
    const value = product?.metafield?.value || "";
    if (!value) return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  customizerVariantMigrationState(product, paidGroups = []) {
    const config = this.existingCustomizerConfig(product);
    if (!config || config?.pricing?.mode !== "product_variants") return null;
    const expectedNames = new Set(
      (paidGroups || [])
        .map((group) => String(group.label || group.name || "").trim())
        .filter(Boolean)
    );
    const optionNames = (product.options || [])
      .map((option) => String(option.name || "").trim())
      .filter((name) => name && name.toLowerCase() !== "title");
    const hasExpectedOptions = !expectedNames.size || optionNames.some((name) => expectedNames.has(name));
    return hasExpectedOptions ? { config, optionNames } : null;
  }

  async syncPaidOptionsIntoProductVariants(productId, paidGroups, apply = false) {
    const product = await this.product(productId);
    const variants = product.variants?.nodes || [];
    const existingOptions = product.options || [];
    const hasOnlyDefaultVariant = variants.length <= 1 && (
      !existingOptions.length ||
      (existingOptions.length === 1 && String(existingOptions[0].name || "").toLowerCase() === "title")
    );
    if (!hasOnlyDefaultVariant) {
      const migrated = this.customizerVariantMigrationState(product, paidGroups);
      if (migrated) {
        return {
          action: "already_migrated",
          productId: product.id,
          variantCount: variants.length,
          optionCount: migrated.optionNames.length,
          options: migrated.optionNames,
          reason: "Product already has amazon_customizer product_variants config.",
        };
      }
      throw new Error("Product already has native variants. Automatic migration only supports products that still use the default single variant.");
    }
    const baseVariant = variants[0];
    const basePrice = Number(baseVariant?.price || 0);
    if (!Number.isFinite(basePrice)) throw new Error("Could not determine the base product price for variant migration.");
    const normalizedGroups = (paidGroups || []).map((group) => ({
      ...group,
      label: String(group.label || group.name || "Option"),
      variantOptions: (group.variantOptions || group.options || []).map((option) => ({
        ...option,
        label: String(option.label || option.name || "Option"),
        cost: Number(option.cost || 0),
      })),
    })).filter((group) => (group.variantOptions || []).length);
    if (!normalizedGroups.length) {
      return { action: "none", productId: product.id, variants: {}, options: [] };
    }
    const combos = this.buildManagedVariantCombos(normalizedGroups, basePrice);
    const input = {
      productOptions: normalizedGroups.map((group, index) => ({
        name: group.label,
        position: index + 1,
        values: group.variantOptions.map((option) => ({ name: option.label })),
      })),
      variants: combos.map((combo, index) => ({
        optionValues: combo.optionValues,
        price: combo.price,
        taxable: false,
        inventoryItem: { tracked: false },
        sku: `${(baseVariant?.sku || `AMZCUSTOM-${String(product.id).split("/").pop()}`)}-${index + 1}`,
      })),
    };
    if (!apply) {
      return {
        action: "upsert",
        dryRun: true,
        productId: product.id,
        basePrice,
        optionCount: input.productOptions.length,
        variantCount: input.variants.length,
        input,
      };
    }
    const data = await this.graphql(`mutation ProductVariantMigration($identifier: ProductSetIdentifiers!, $input: ProductSetInput!) {
      productSet(identifier: $identifier, input: $input, synchronous: true) {
        product {
          id
          variants(first: 250) {
            nodes {
              id
              price
              selectedOptions {
                name
                value
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }`, {
      identifier: { id: product.id },
      input,
    });
    const payload = data.productSet;
    if (payload.userErrors.length) throw new Error(payload.userErrors.map((item) => item.message).join("; "));
    const variantMap = {};
    for (const variant of payload.product.variants.nodes || []) {
      const key = JSON.stringify((variant.selectedOptions || []).map((item) => [item.name, item.value]));
      variantMap[key] = variant.id;
    }
    return {
      action: "upserted",
      productId: payload.product.id,
      basePrice,
      optionCount: input.productOptions.length,
      variantCount: input.variants.length,
      variants: variantMap,
    };
  }

  async ensureCustomizerDefinition(apply = false) {
    const query = `query Definition { metafieldDefinitions(first: 1, ownerType: PRODUCT, namespace: "custom", key: "amazon_customizer") { nodes { id name namespace key type { name } } } }`;
    const existing = (await this.graphql(query)).metafieldDefinitions.nodes[0];
    if (existing) return { action: "exists", definition: existing };
    const input = { name: "Amazon Customizer", namespace: "custom", key: "amazon_customizer", ownerType: "PRODUCT", type: "json", description: "Normalized Amazon personalization configuration used by the storefront customizer." };
    if (!apply) return { action: "create", dryRun: true, input };
    const data = await this.graphql(`mutation CreateDefinition($definition: MetafieldDefinitionInput!) { metafieldDefinitionCreate(definition: $definition) { createdDefinition { id name namespace key } userErrors { field message } } }`, { definition: input });
    const payload = data.metafieldDefinitionCreate;
    if (payload.userErrors.length) throw new Error(payload.userErrors.map((item) => item.message).join("; "));
    return { action: "created", definition: payload.createdDefinition };
  }

  async setCustomizer(productId, config, apply = false) {
    const product = await this.product(productId);
    const value = JSON.stringify(config);
    const input = { ownerId: product.id, namespace: "custom", key: "amazon_customizer", type: "json", value };
    const previous = product.metafield && product.metafield.value || "";
    const digest = crypto.createHash("sha256").update(value).digest("hex");
    const result = { product: { id: product.id, title: product.title }, changed: previous !== value, bytes: Buffer.byteLength(value), digest };
    if (!apply) return { ...result, dryRun: true, input: { ...input, value: `<${result.bytes} bytes>` } };
    await this.ensureCustomizerDefinition(true);
    const data = await this.graphql(`mutation SetCustomizer($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { id namespace key type updatedAt } userErrors { field message } } }`, { metafields: [input] });
    const payload = data.metafieldsSet;
    if (payload.userErrors.length) throw new Error(payload.userErrors.map((item) => item.message).join("; "));
    return { ...result, dryRun: false, metafield: payload.metafields[0] };
  }

  async uploadBuffer(buffer, { filename, mimeType = "application/octet-stream", alt = "", contentType = "FILE" } = {}, apply = false) {
    if (!apply) return { dryRun: true, filename, mimeType, bytes: buffer.length, contentType };
    const startedAt = Date.now();
    const staged = await this.graphql(`mutation Stage($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }`, {
      input: [{ filename, mimeType, resource: contentType === "IMAGE" ? "IMAGE" : "FILE", httpMethod: "POST", fileSize: String(buffer.length) }],
    });
    const stagePayload = staged.stagedUploadsCreate;
    if (stagePayload.userErrors.length) throw new Error(stagePayload.userErrors.map((item) => item.message).join("; "));
    const target = stagePayload.stagedTargets[0];
    const form = new FormData();
    for (const parameter of target.parameters) form.append(parameter.name, parameter.value);
    form.append("file", new Blob([buffer], { type: mimeType }), filename);
    const stagedCreatedAt = Date.now();
    const upload = await fetch(target.url, { method: "POST", body: form });
    if (!upload.ok) throw new Error(`Staged upload failed: HTTP ${upload.status}`);
    const stagedUploadedAt = Date.now();
    const created = await this.createFileFromUrl(target.resourceUrl, filename, alt, true, contentType);
    const file = await this.waitForFile(created.id);
    console.log("[Amazon Customizer][ShopifyAdmin] uploadBuffer", {
      filename,
      mimeType,
      bytes: buffer.length,
      stagedCreateMs: stagedCreatedAt - startedAt,
      uploadPostMs: stagedUploadedAt - stagedCreatedAt,
      waitReadyMs: Date.now() - stagedUploadedAt,
      totalMs: Date.now() - startedAt,
      fileId: file.id
    });
    return file;
  }

  async createStagedUploadTarget({ filename, mimeType = "application/octet-stream", contentType = "FILE", fileSize } = {}) {
    const staged = await this.graphql(`mutation Stage($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }`, {
      input: [{ filename, mimeType, resource: contentType === "IMAGE" ? "IMAGE" : "FILE", httpMethod: "POST", fileSize: String(fileSize || 0) }],
    });
    const payload = staged.stagedUploadsCreate;
    if (payload.userErrors.length) throw new Error(payload.userErrors.map((item) => item.message).join("; "));
    return payload.stagedTargets[0];
  }

  async completeStagedUpload(resourceUrl, { filename, alt = "", contentType = "IMAGE" } = {}, waitUntilReady = true) {
    const created = await this.createFileFromUrl(resourceUrl, filename, alt, true, contentType);
    return waitUntilReady ? this.waitForFile(created.id) : created;
  }

  async createFileFromUrl(url, filename, alt, apply = false, contentType = "IMAGE") {
    const input = { originalSource: url, contentType, filename, alt };
    if (!apply) return { dryRun: true, input };
    const data = await this.graphql(`mutation FileCreate($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id fileStatus alt ... on MediaImage { image { url } } ... on GenericFile { url } } userErrors { field message } } }`, { files: [input] });
    const payload = data.fileCreate;
    if (payload.userErrors.length) throw new Error(payload.userErrors.map((item) => item.message).join("; "));
    return payload.files[0];
  }

  async findFileByFilename(filename) {
    const escaped = String(filename).replace(/["\\]/g, "");
    const data = await this.graphql(`query ExistingFile($query: String!) { files(first: 1, query: $query) { nodes { id fileStatus alt ... on MediaImage { image { url } } ... on GenericFile { url } } } }`, { query: `filename:${escaped}` });
    return data.files.nodes[0] || null;
  }

  async ensureFileFromUrl(url, filename, alt, apply = false, contentType = "IMAGE") {
    if (!apply) return { dryRun: true, input: { originalSource: url, contentType, filename, alt } };
    const existing = await this.findFileByFilename(filename);
    if (existing && existing.fileStatus === "READY") return { ...existing, reused: true };
    const created = await this.createFileFromUrl(url, filename, alt, true, contentType);
    return this.waitForFile(created.id);
  }

  async waitForFile(id, attempts = 15) {
    const startedAt = Date.now();
    for (let index = 0; index < attempts; index += 1) {
      const data = await this.graphql(`query File($id: ID!) { node(id: $id) { ... on File { id fileStatus alt } ... on MediaImage { image { url } } ... on GenericFile { url } } }`, { id });
      if (data.node && data.node.fileStatus === "READY") {
        console.log("[Amazon Customizer][ShopifyAdmin] waitForFile ready", {
          id,
          attemptsUsed: index + 1,
          elapsedMs: Date.now() - startedAt
        });
        return data.node;
      }
      if (data.node && data.node.fileStatus === "FAILED") throw new Error(`Shopify failed to process file ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for Shopify file ${id}`);
  }

  async cleanupOrderFiles({ olderThanDays = 30, apply = false } = {}) {
    const cutoff = Date.now() - olderThanDays * 86400000;
    const data = await this.graphql(`query OrderAssets($query: String!) { files(first: 250, query: $query) { nodes { id createdAt alt ... on MediaImage { image { url } } ... on GenericFile { url } } } }`, { query: "filename:amzcustom-order-*" });
    const candidates = data.files.nodes.filter((file) => new Date(file.createdAt).getTime() < cutoff);
    if (!apply || !candidates.length) return { dryRun: !apply, cutoff: new Date(cutoff).toISOString(), candidates: candidates.map((file) => ({ id: file.id, createdAt: file.createdAt, url: (file.image && file.image.url) || file.url })) };
    const deleted = [];
    for (let index = 0; index < candidates.length; index += 25) {
      const ids = candidates.slice(index, index + 25).map((file) => file.id);
      const result = await this.graphql(`mutation DeleteFiles($ids: [ID!]!) { fileDelete(fileIds: $ids) { deletedFileIds userErrors { field message } } }`, { ids });
      if (result.fileDelete.userErrors.length) throw new Error(result.fileDelete.userErrors.map((item) => item.message).join("; "));
      deleted.push(...result.fileDelete.deletedFileIds);
    }
    return { dryRun: false, cutoff: new Date(cutoff).toISOString(), deleted };
  }

  decodeCustomizationPayload(attributes = {}) {
    const count = Number(attributes._customization_payload_count || 0);
    if (!count) return null;
    let joined = "";
    for (let index = 1; index <= count; index += 1) {
      joined += String(attributes[`_customization_payload_${index}`] || "");
    }
    if (!joined) return null;
    return JSON.parse(Buffer.from(joined, "base64").toString("utf8"));
  }

  visibleCustomizationProperties(attributes = {}) {
    return Object.entries(attributes)
      .filter(([key, value]) => {
        if (!value) return false;
        if (String(key || "").startsWith("_")) return false;
        return key !== "Production preview" && key !== "Original upload";
      })
      .map(([key, value]) => ({ key, value }));
  }

  customizationUploads(payload) {
    const images = payload?.selections?.images || {};
    return Object.entries(images).map(([id, image]) => ({
      id,
      url: image?.url || "",
      filename: image?.filename || ""
    })).filter((image) => image.url || image.filename);
  }

  compactCustomizationPayload(payload) {
    if (!payload || typeof payload !== "object") return null;
    return {
      customizationId: payload.customizationId || "",
      schemaVersion: payload.schemaVersion || 1,
      productId: payload.productId || "",
      variantId: payload.variantId || "",
      createdAt: payload.createdAt || "",
      previewModel: payload.previewModel || null,
      selections: {
        options: payload.selections?.options || {},
        texts: payload.selections?.texts || {},
        fonts: payload.selections?.fonts || {},
        colors: payload.selections?.colors || {},
        images: payload.selections?.images || {},
        imageTransforms: payload.selections?.imageTransforms || {},
        textTransforms: payload.selections?.textTransforms || {},
        placementOffsets: payload.selections?.placementOffsets || {}
      }
    };
  }

  presentationCustomization(attributes = {}, payload = null) {
    return {
      id: String(attributes._customization_id || ""),
      schemaVersion: Number(attributes._customization_schema || 1),
      payloadEncoding: String(attributes._customization_payload_encoding || ""),
      visibleProperties: this.visibleCustomizationProperties(attributes),
      uploads: this.customizationUploads(payload),
      decodedPayload: this.compactCustomizationPayload(payload)
    };
  }

  normalizeOrderRef(orderRef) {
    const raw = String(orderRef || "").trim();
    if (!raw) throw new Error("Missing order ID.");
    if (raw.startsWith("gid://")) return { gid: raw, searchName: null };
    if (/^\d+$/.test(raw)) return { gid: `gid://shopify/Order/${raw}`, searchName: null };
    const normalizedName = raw.startsWith("#") ? raw : `#${raw}`;
    return { gid: null, searchName: normalizedName };
  }

  async orderCustomizations(orderRef) {
    const normalized = this.normalizeOrderRef(orderRef);
    let orderNode = null;
    if (normalized.gid) {
      const data = await this.graphql(`query CustomizationOrder($id: ID!) {
        order(id: $id) {
          id
          name
          createdAt
          lineItems(first: 100) {
            nodes {
              id
              title
              variantTitle
              sku
              quantity
              customAttributes {
                key
                value
              }
            }
          }
        }
      }`, { id: normalized.gid });
      orderNode = data.order || null;
    } else {
      const data = await this.graphql(`query CustomizationOrderByName($query: String!) {
        orders(first: 1, query: $query, reverse: true, sortKey: CREATED_AT) {
          nodes {
            id
            name
            createdAt
            lineItems(first: 100) {
              nodes {
                id
                title
                variantTitle
                sku
                quantity
                customAttributes {
                  key
                  value
                }
              }
            }
          }
        }
      }`, { query: `name:${normalized.searchName}` });
      orderNode = data.orders?.nodes?.[0] || null;
    }
    if (!orderNode) return null;

    const items = [];
    for (const lineItem of orderNode.lineItems?.nodes || []) {
      const attributes = Object.fromEntries((lineItem.customAttributes || []).map((item) => [item.key, item.value]));
      const customizationId = String(attributes._customization_id || "");
      if (!customizationId) continue;
      const payload = this.decodeCustomizationPayload(attributes);
      if (!payload?.previewModel?.layers?.length) continue;
      items.push({
        order: {
          id: orderNode.id,
          name: orderNode.name,
          createdAt: orderNode.createdAt
        },
        lineItem: {
          id: lineItem.id,
          title: lineItem.title,
          variantTitle: lineItem.variantTitle || "",
          sku: lineItem.sku || "",
          quantity: lineItem.quantity
        },
        attributes,
        customizationId,
        payload,
        properties: this.visibleCustomizationProperties(attributes),
        uploads: this.customizationUploads(payload),
        presentation: this.presentationCustomization(attributes, payload)
      });
    }

    return {
      order: {
        id: orderNode.id,
        name: orderNode.name,
        createdAt: orderNode.createdAt
      },
      items
    };
  }

  async findCustomizationById(customizationId, { maxOrders = 250, pageSize = 50 } = {}) {
    const targetId = String(customizationId || "").trim();
    if (!targetId) throw new Error("Missing customization ID.");
    let after = null;
    let scanned = 0;
    while (scanned < maxOrders) {
      const first = Math.min(pageSize, maxOrders - scanned);
      const data = await this.graphql(`query CustomizationOrders($first: Int!, $after: String) {
        orders(first: $first, after: $after, reverse: true, sortKey: CREATED_AT) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            name
            createdAt
            lineItems(first: 100) {
              nodes {
                id
                title
                variantTitle
                sku
                quantity
                customAttributes {
                  key
                  value
                }
              }
            }
          }
        }
      }`, { first, after });
      const orders = data.orders?.nodes || [];
      scanned += orders.length;
      for (const order of orders) {
        for (const lineItem of order.lineItems?.nodes || []) {
          const attributes = Object.fromEntries((lineItem.customAttributes || []).map((item) => [item.key, item.value]));
          if (String(attributes._customization_id || "") !== targetId) continue;
          return {
            order: {
              id: order.id,
              name: order.name,
              createdAt: order.createdAt
            },
            lineItem: {
              id: lineItem.id,
              title: lineItem.title,
              variantTitle: lineItem.variantTitle || "",
              sku: lineItem.sku || "",
              quantity: lineItem.quantity
            },
            attributes,
            payload: this.decodeCustomizationPayload(attributes),
            properties: this.visibleCustomizationProperties(attributes),
            presentation: this.presentationCustomization(attributes, this.decodeCustomizationPayload(attributes))
          };
        }
      }
      if (!data.orders?.pageInfo?.hasNextPage || !data.orders?.pageInfo?.endCursor) break;
      after = data.orders.pageInfo.endCursor;
    }
    return null;
  }
}

module.exports = { ShopifyAdmin };
