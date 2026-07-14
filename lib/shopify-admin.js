"use strict";

const crypto = require("crypto");
const { loadEnv } = require("./env");
const { configureProxy } = require("./proxy");

loadEnv();
configureProxy();

class ShopifyAdmin {
  constructor(options = {}) {
    this.shop = String(options.shop || process.env.SHOPIFY_SHOP || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
    this.token = options.token || process.env.SHOPIFY_ACCESS_TOKEN || "";
    this.version = options.version || process.env.SHOPIFY_API_VERSION || "2026-04";
    if (!this.shop || !this.token) throw new Error("SHOPIFY_SHOP and SHOPIFY_ACCESS_TOKEN are required.");
  }

  async graphql(query, variables = {}) {
    const response = await fetch(`https://${this.shop}/admin/api/${this.version}/graphql.json`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": this.token },
      body: JSON.stringify({ query, variables }),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.errors) throw new Error(JSON.stringify(json.errors || json));
    return json.data;
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

  async syncPaidOptionsIntoProductVariants(productId, paidGroups, apply = false) {
    const product = await this.product(productId);
    const variants = product.variants?.nodes || [];
    const existingOptions = product.options || [];
    const hasOnlyDefaultVariant = variants.length <= 1 && (
      !existingOptions.length ||
      (existingOptions.length === 1 && String(existingOptions[0].name || "").toLowerCase() === "title")
    );
    if (!hasOnlyDefaultVariant) {
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

  async ensureCartTransform(apply = false) {
    const handle = "customization-cart-transform";
    const blockOnFailure = false;
    const listQuery = `query CartTransforms($first: Int!) {
      cartTransforms(first: $first) {
        nodes {
          id
          functionId
          blockOnFailure
          metafield(namespace: "custom", key: "amazon_customizer_cart_transform") { id value }
        }
      }
    }`;
    const existing = (await this.graphql(listQuery, { first: 25 })).cartTransforms.nodes;
    const ours = existing.filter((item) => item.metafield && item.metafield.value === handle);
    if (ours.length === 1) return { action: "exists", cartTransform: ours[0] };
    if (!apply) {
      return {
        action: ours.length ? "dedupe-and-create" : "create",
        dryRun: true,
        functionHandle: handle,
        blockOnFailure,
        existing: ours.map((item) => item.id),
      };
    }
    const deleted = [];
    for (const duplicate of ours) {
      const result = await this.graphql(`mutation DeleteCartTransform($id: ID!) { cartTransformDelete(id: $id) { deletedId userErrors { field message } } }`, { id: duplicate.id });
      const payload = result.cartTransformDelete;
      if (payload.userErrors.length) throw new Error(payload.userErrors.map((item) => item.message).join("; "));
      deleted.push(payload.deletedId);
    }
    const created = await this.graphql(`mutation CreateCartTransform($functionHandle: String!, $blockOnFailure: Boolean!, $metafields: [MetafieldInput!]) {
      cartTransformCreate(functionHandle: $functionHandle, blockOnFailure: $blockOnFailure, metafields: $metafields) {
        cartTransform {
          id
          functionId
          blockOnFailure
          metafield(namespace: "custom", key: "amazon_customizer_cart_transform") { id value }
        }
        userErrors { field message }
      }
    }`, {
      functionHandle: handle,
      blockOnFailure,
      metafields: [{
        namespace: "custom",
        key: "amazon_customizer_cart_transform",
        type: "single_line_text_field",
        value: handle,
      }],
    });
    const payload = created.cartTransformCreate;
    if (payload.userErrors.length) throw new Error(payload.userErrors.map((item) => item.message).join("; "));
    return { action: "created", deleted, cartTransform: payload.cartTransform };
  }

  surchargeProductKey(productId) {
    const id = String(productId || "").split("/").pop().replace(/[^A-Za-z0-9_-]/g, "") || "product";
    return {
      id,
      handle: `amazon-customization-addon-${id}`,
      title: `Customization Add-on ${id}`,
    };
  }

  async ensureSurchargeProduct(productId, amounts, apply = false) {
    const normalized = [...new Set((amounts || []).map(Number).filter((amount) => Number.isFinite(amount) && amount > 0))].sort((a, b) => a - b);
    const surchargeProduct = this.surchargeProductKey(productId);
    const input = {
      title: surchargeProduct.title, handle: surchargeProduct.handle, status: "UNLISTED",
      productType: "Customization fee", vendor: "Amazon Customizer", tags: ["amzcustom-managed", "hidden-addon"],
      descriptionHtml: "App-managed surcharge product. Do not edit or remove.",
      metafields: [{ namespace: "seo", key: "hidden", type: "number_integer", value: "1" }],
      productOptions: [{ name: "Fee", position: 1, values: normalized.map((amount) => ({ name: String(amount) })) }],
      variants: normalized.map((amount) => ({ optionValues: [{ optionName: "Fee", name: String(amount) }], price: String(amount), taxable: false, inventoryItem: { tracked: false, requiresShipping: false }, sku: `AMZCUSTOM-FEE-${amount}` })),
    };
    if (!normalized.length) return { action: "none", productId: null, handle: surchargeProduct.handle, variants: {} };
    if (!apply) return { action: "upsert", dryRun: true, input, handle: surchargeProduct.handle, variants: Object.fromEntries(normalized.map((amount) => [amount, null])) };
    const data = await this.graphql(`mutation Surcharge($identifier: ProductSetIdentifiers, $input: ProductSetInput!) { productSet(identifier: $identifier, input: $input, synchronous: true) { product { id handle variants(first: 250) { nodes { id price selectedOptions { name value } } } } userErrors { field message } } }`, { identifier: { handle: input.handle }, input });
    const payload = data.productSet;
    if (payload.userErrors.length) throw new Error(payload.userErrors.map((item) => item.message).join("; "));
    const variants = Object.fromEntries(payload.product.variants.nodes.map((variant) => [Number(variant.selectedOptions.find((item) => item.name === "Fee")?.value), variant.id]));
    let publication = null;
    try {
      const publications = await this.graphql(`query Publications { publications(first: 20) { nodes { id name } } }`);
      publication = publications.publications.nodes.find((item) => /online store/i.test(item.name));
      if (publication) {
        const publish = await this.graphql(`mutation Publish($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }`, { id: payload.product.id, input: [{ publicationId: publication.id }] });
        if (publish.publishablePublish.userErrors.length) throw new Error(publish.publishablePublish.userErrors.map((item) => item.message).join("; "));
      }
    } catch (error) {
      return { action: "upserted", productId: payload.product.id, handle: payload.product.handle, variants, publicationWarning: error.message };
    }
    return { action: "upserted", productId: payload.product.id, handle: payload.product.handle, variants, publication: publication && publication.name };
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

  async contextualVariantPrices(variantIds, countryCode) {
    const ids = [...new Set((variantIds || []).map((id) => String(id || "")).filter(Boolean))];
    if (!ids.length) return {};
    const data = await this.graphql(`query ContextualVariantPrices($ids: [ID!]!, $country: CountryCode!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          price
          contextualPricing(context: { country: $country }) {
            price {
              amount
              currencyCode
            }
          }
        }
      }
    }`, { ids, country: countryCode });
    return Object.fromEntries((data.nodes || []).filter(Boolean).map((variant) => [
      variant.id,
      {
        amount: Number(variant.contextualPricing?.price?.amount || variant.price || 0),
        currencyCode: variant.contextualPricing?.price?.currencyCode || null,
      }
    ]));
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
}

module.exports = { ShopifyAdmin };
