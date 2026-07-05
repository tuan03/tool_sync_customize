# Shopify Codex Tool — README for AI/Codex Agents

## 1. Why this tool exists

This repository contains `shopify_codex_tool.py`, a **safe Shopify Admin GraphQL CLI helper** designed for AI-assisted Shopify theme development.

The main use case is:

> A human gives Codex or another AI agent a Shopify theme source and a business/product idea. The AI needs to inspect the real Shopify store data, understand product/content/metadata structures, propose changes, and optionally apply safe Shopify Admin API changes during theme development.

A Shopify theme is not only local Liquid/CSS/JS files. A real Shopify storefront also depends on store-side data and configuration, including:

- Products and product variants
- Collections
- Product metafields
- Collection metafields
- Metaobjects and metaobject definitions
- Shopify Files/media
- Pages and navigation menus
- Theme settings and theme files
- App blocks/app embeds, when present

Without this context, Codex may write Liquid code that references fields that do not exist, such as:

```liquid
{{ product.metafields.custom.warmth_level.value }}
```

If `custom.warmth_level` does not exist in Shopify Admin, the UI will render blank. This tool exists to help Codex avoid guessing.

---

## 2. What this tool is

This tool is a **CLI adapter for Shopify Admin GraphQL API**.

It is intentionally designed to be:

- Easy for Codex to call through terminal commands
- JSON-oriented, so outputs can be read by AI agents
- Safe by default, because write operations run as dry-run unless `--apply` is explicitly passed
- Useful during local Shopify theme development
- MCP-like, because it exposes a machine-readable tool manifest through `mcp-tools`

Run:

```bash
python shopify_codex_tool.py mcp-tools
```

This prints a JSON manifest that tells Codex what this CLI can do.

Important: this is **not a full MCP JSON-RPC stdio server** yet. It is an MCP-like command-line bridge. A real MCP server can wrap these commands later.

---

## 3. What this tool is not

This tool is **not** a full Shopify SDK.

It does not currently wrap every Shopify API domain such as orders, customers, inventory, discounts, markets, fulfillment, webhooks, Shopify Functions, Payments Apps API, Storefront API, or Customer Account API.

It focuses on the APIs most useful for **AI-assisted Shopify theme development**:

- Auth and token setup
- Store scanning
- Products
- Collections
- Metafields
- Metaobjects
- Files/media
- Themes/theme files
- Pages/menus at a basic level
- JSON migration plans
- Raw GraphQL fallback

For unsupported Shopify Admin GraphQL operations, use:

```bash
python shopify_codex_tool.py graphql --query-file query.graphql --variables-file variables.json
```

---

## 4. Golden rule for Codex

Codex must follow this rule:

> Never assume Shopify Admin data exists. Inspect first, then modify local theme code, then propose data/schema migrations when needed.

Correct workflow:

```text
Inspect store context
→ inspect local theme source
→ identify required data/metafields/metaobjects/files
→ create migration plan if needed
→ dry-run migration
→ only apply to dev/unpublished store when the human approves
→ update local theme code
→ test through Shopify CLI preview
```

Wrong workflow:

```text
Guess a metafield key
→ write Liquid using it
→ assume Shopify Admin has that data
```

---

## 5. Required files

Minimum files expected in the project:

```text
shopify_codex_tool.py
.env.shopify
```

Optional but recommended:

```text
shopify-context.json
shopify_migration.example.json
shopify-migrations/
```

Never commit `.env.shopify` to git.

---

## 6. `.env.shopify` format

Generate an example file:

```bash
python shopify_codex_tool.py env-example > .env.shopify
```

Example:

```env
SHOPIFY_SHOP="your-dev-store.myshopify.com"
SHOPIFY_CLIENT_ID="your_client_id"
SHOPIFY_CLIENT_SECRET="your_client_secret"
SHOPIFY_API_VERSION="2026-04"
SHOPIFY_SCOPES="read_products,write_products,read_files,write_files,read_metaobjects,write_metaobjects,read_metaobject_definitions,write_metaobject_definitions,read_themes,write_themes,read_content,write_content"
SHOPIFY_REDIRECT_URI="http://127.0.0.1:3456/callback"

# Filled by token commands when using --save
# SHOPIFY_ACCESS_TOKEN="shpat_or_token_value"
```

Codex must never print real secrets into chat logs, documentation, commits, or screenshots.

---

## 7. Getting an access token

This tool supports two token flows.

### 7.1 Client credentials flow

Use this when the app is an internal/custom app for a store owned by the same organization and the app is already installed/allowed.

```bash
python shopify_codex_tool.py token-client-credentials --save
```

This saves `SHOPIFY_ACCESS_TOKEN` into `.env.shopify`.

Avoid:

```bash
python shopify_codex_tool.py token-client-credentials --show-token
```

Only use `--show-token` for local debugging, never in shared logs.

### 7.2 OAuth authorization-code flow

Generate an install URL:

```bash
python shopify_codex_tool.py auth-url
```

Open the generated URL in a browser, approve the app, copy the `code` from the callback URL, then run:

```bash
python shopify_codex_tool.py exchange-code --code <code-from-callback> --save
```

### 7.3 Verify callback HMAC

For debugging OAuth callback verification:

```bash
python shopify_codex_tool.py verify-hmac --query-string "shop=...&code=...&hmac=..."
```

---

## 8. First connection test

After token setup, run:

```bash
python shopify_codex_tool.py shop-info
```

Expected result:

```json
{
  "ok": true,
  "data": {
    "shop": {
      "id": "...",
      "name": "...",
      "myshopifyDomain": "..."
    }
  }
}
```

If this fails, Codex should not continue theme/data automation. Fix auth, store domain, app scopes, or token first.

---

## 9. Standard Codex workflow for Shopify theme development

### Step 1 — Export Shopify store context

```bash
python shopify_codex_tool.py scan-context --include-content --out shopify-context.json
```

This gives Codex a JSON snapshot of:

- Shop info
- Products
- Collections
- Product metafield definitions
- Collection metafield definitions
- Metaobject definitions
- Files
- Themes
- Optional pages and menus

If some sections fail because scopes are missing, the tool keeps scanning and records errors per section.

### Step 2 — Read local theme source

Codex should inspect these local theme directories:

```text
layout/
templates/
sections/
snippets/
assets/
config/
locales/
blocks/        # if present
```

### Step 3 — Map page to files

Before coding, Codex should answer:

```text
Which template renders this page?
Which sections does that template use?
Which snippets do those sections call?
Which CSS/JS assets affect those sections?
Which Shopify Admin data does the Liquid code depend on?
```

### Step 4 — Propose changes

Codex should separate changes into two groups:

```text
A. Local theme code changes
B. Shopify Admin data/schema changes
```

Examples of Shopify Admin data/schema changes:

- Create a product metafield definition
- Set sample metafield values on dev products
- Create a metaobject definition
- Create metaobject entries
- Upload files/media
- Create/update product mock data

### Step 5 — Create a migration plan if Admin data must change

Create a JSON migration file such as:

```text
shopify-migrations/001_add_blanket_product_metadata.json
```

Then dry-run it:

```bash
python shopify_codex_tool.py migration-apply --file shopify-migrations/001_add_blanket_product_metadata.json
```

Only apply after human approval:

```bash
python shopify_codex_tool.py migration-apply --file shopify-migrations/001_add_blanket_product_metadata.json --apply
```

---

## 10. Safety model

All write commands are dry-run by default.

Examples:

```bash
python shopify_codex_tool.py product-create --json-file product.json
python shopify_codex_tool.py metafield-definition-create --json-file metafield.json
python shopify_codex_tool.py metafields-set --json-file values.json
python shopify_codex_tool.py metaobject-create --json-file entry.json
python shopify_codex_tool.py theme-publish --theme-id gid://shopify/OnlineStoreTheme/123
```

These commands do **not** execute unless `--apply` is added.

To execute:

```bash
python shopify_codex_tool.py product-create --json-file product.json --apply
```

Codex should only use `--apply` when:

1. The human explicitly asked to apply the change, and
2. The target is a dev store or unpublished/development theme, and
3. The dry-run output was reviewed, and
4. The migration/data change is minimal and reversible.

Codex should avoid applying changes to production/live stores unless the human explicitly confirms that the target is production and accepts the risk.

---

## 11. Supported command groups

### 11.1 Help and manifest

```bash
python shopify_codex_tool.py --help
python shopify_codex_tool.py <command> --help
python shopify_codex_tool.py mcp-tools
python shopify_codex_tool.py env-example
```

Codex should call `--help` whenever unsure about command arguments.

### 11.2 Auth commands

```bash
python shopify_codex_tool.py auth-url
python shopify_codex_tool.py token-client-credentials --save
python shopify_codex_tool.py exchange-code --code <code> --save
python shopify_codex_tool.py verify-hmac --query-string "..."
```

### 11.3 Generic GraphQL

```bash
python shopify_codex_tool.py graphql --query-file query.graphql --variables-file variables.json
```

This is the escape hatch for APIs not wrapped by a dedicated command.

### 11.4 Store context

```bash
python shopify_codex_tool.py shop-info
python shopify_codex_tool.py scan-context --include-content --out shopify-context.json
```

### 11.5 Products

```bash
python shopify_codex_tool.py products-list --first 20
python shopify_codex_tool.py products-list --query "blanket"
python shopify_codex_tool.py product-get --handle cloudsoft-blanket
python shopify_codex_tool.py product-create --json-file product.json
python shopify_codex_tool.py product-create --json-file product.json --apply
python shopify_codex_tool.py product-update --json-file product-update.json --apply
```

### 11.6 Collections

```bash
python shopify_codex_tool.py collections-list --first 20
python shopify_codex_tool.py collections-list --query "blanket"
```

### 11.7 Metafields

```bash
python shopify_codex_tool.py metafield-definitions-list --owner-type PRODUCT
python shopify_codex_tool.py metafield-definitions-list --owner-type COLLECTION
python shopify_codex_tool.py metafield-definition-create --json-file metafield-definition.json
python shopify_codex_tool.py metafield-definition-create --json-file metafield-definition.json --apply
python shopify_codex_tool.py metafields-set --json-file metafield-values.json
python shopify_codex_tool.py metafields-set --json-file metafield-values.json --apply
```

### 11.8 Metaobjects

```bash
python shopify_codex_tool.py metaobject-definitions-list
python shopify_codex_tool.py metaobject-definition-create --json-file metaobject-definition.json
python shopify_codex_tool.py metaobject-definition-create --json-file metaobject-definition.json --apply
python shopify_codex_tool.py metaobjects-list --type product_benefit
python shopify_codex_tool.py metaobject-create --json-file metaobject.json
python shopify_codex_tool.py metaobject-create --json-file metaobject.json --apply
```

### 11.9 Files and media

```bash
python shopify_codex_tool.py files-list
python shopify_codex_tool.py files-list --query "blanket"
python shopify_codex_tool.py file-create-url --url "https://example.com/banner.jpg" --content-type IMAGE --alt "Blanket hero"
python shopify_codex_tool.py file-create-url --url "https://example.com/banner.jpg" --content-type IMAGE --alt "Blanket hero" --apply
python shopify_codex_tool.py staged-upload-target --filename hero.jpg --resource IMAGE
python shopify_codex_tool.py staged-upload-file --target-json staged-target.json --path ./hero.jpg
```

### 11.10 Themes

```bash
python shopify_codex_tool.py themes-list
python shopify_codex_tool.py theme-file-get --theme-id gid://shopify/OnlineStoreTheme/123 --filename templates/index.json
python shopify_codex_tool.py theme-files-upsert --theme-id gid://shopify/OnlineStoreTheme/123 --file templates/index.json=./templates/index.json
python shopify_codex_tool.py theme-files-upsert --theme-id gid://shopify/OnlineStoreTheme/123 --file templates/index.json=./templates/index.json --apply
python shopify_codex_tool.py theme-files-delete --theme-id gid://shopify/OnlineStoreTheme/123 --filename sections/old-section.liquid
python shopify_codex_tool.py theme-create --name "AI Dev Theme" --source "https://example.com/theme.zip"
python shopify_codex_tool.py theme-create --name "AI Dev Theme" --source "https://example.com/theme.zip" --apply
python shopify_codex_tool.py theme-publish --theme-id gid://shopify/OnlineStoreTheme/123
python shopify_codex_tool.py theme-publish --theme-id gid://shopify/OnlineStoreTheme/123 --apply
```

Theme write commands may require `write_themes` and Shopify theme API exemption. If they fail, Codex should report the failure and avoid guessing.

### 11.11 Pages and menus

```bash
python shopify_codex_tool.py pages-list
python shopify_codex_tool.py pages-list --query "about"
python shopify_codex_tool.py menus-list
```

These commands may require the right API version and scopes. If they fail, use `graphql` with the current Shopify docs as ground truth.

### 11.12 Migrations

```bash
python shopify_codex_tool.py migration-apply --file migration.json
python shopify_codex_tool.py migration-apply --file migration.json --apply
```

Migration files are the preferred way for Codex to propose Shopify Admin changes.

---

## 12. Migration file format

A migration file is a JSON plan. It may contain these top-level arrays:

```json
{
  "metafield_definitions": [],
  "metaobject_definitions": [],
  "products": [],
  "metafields": [],
  "metaobjects": [],
  "files": []
}
```

### 12.1 Example: product metafield definition

```json
{
  "metafield_definitions": [
    {
      "name": "Warmth level",
      "namespace": "custom",
      "key": "warmth_level",
      "description": "Warmth level of the blanket.",
      "type": "single_line_text_field",
      "ownerType": "PRODUCT"
    }
  ]
}
```

### 12.2 Example: set product metafield value

```json
{
  "metafields": [
    {
      "ownerId": "gid://shopify/Product/1234567890",
      "namespace": "custom",
      "key": "warmth_level",
      "type": "single_line_text_field",
      "value": "Medium Warm"
    }
  ]
}
```

### 12.3 Example: metaobject definition

```json
{
  "metaobject_definitions": [
    {
      "name": "Product benefit",
      "type": "product_benefit",
      "access": {
        "admin": "MERCHANT_READ_WRITE",
        "storefront": "PUBLIC_READ"
      },
      "fieldDefinitions": [
        {
          "name": "Title",
          "key": "title",
          "type": "single_line_text_field",
          "required": true
        },
        {
          "name": "Description",
          "key": "description",
          "type": "multi_line_text_field",
          "required": false
        },
        {
          "name": "Icon",
          "key": "icon",
          "type": "file_reference",
          "required": false
        }
      ]
    }
  ]
}
```

---

## 13. Decision guide: metafield or metaobject?

Use a **metafield** when the data is a simple attribute on one Shopify resource.

Good product metafield examples:

```text
custom.material
custom.care_instruction
custom.warmth_level
custom.size_guide
custom.short_description
```

Use a **metaobject** when the data is structured, repeatable, or has multiple fields.

Good metaobject examples:

```text
product_benefit:
- icon
- title
- description

size_guide_row:
- size
- width
- length
- recommended_use

faq_item:
- question
- answer
```

Codex should not create one giant JSON/string metafield when a metaobject would be clearer and easier for a merchant to manage.

---

## 14. How Codex should handle a new metadata requirement

If Codex wants to render a new product field, it must do this:

```text
1. Search existing product metafield definitions.
2. Search existing product data/metafields.
3. If an appropriate field exists, reuse it.
4. If no field exists, propose a new metafield definition in a migration JSON file.
5. Add sample values only on dev/sample products.
6. Update Liquid with safe fallback logic.
7. Dry-run migration.
8. Ask/apply only after human approval.
```

Liquid must use fallback checks:

```liquid
{% assign warmth_level = product.metafields.custom.warmth_level.value %}

{% if warmth_level != blank %}
  <div class="product-spec">
    <span class="product-spec__label">Warmth level</span>
    <span class="product-spec__value">{{ warmth_level }}</span>
  </div>
{% endif %}
```

Avoid:

```liquid
<div>{{ product.metafields.custom.warmth_level.value }}</div>
```

The unsafe version may render empty UI when the metafield is missing.

---

## 15. How Codex should use this with local Shopify theme code

Codex should treat local theme code and Shopify Admin data as separate layers.

```text
Local theme code = rendering logic and UI structure
Shopify Admin data = product/content/metadata/media/config used by the theme
```

When implementing a feature, Codex should document both layers.

Example:

```text
Feature: Product benefit cards

Theme files:
- sections/product-benefits.liquid
- snippets/icon-benefit.liquid
- assets/product-benefits.css
- templates/product.json

Shopify Admin data:
- metaobject definition: product_benefit
- product metafield: custom.product_benefits, list.metaobject_reference
- sample entries for dev product
```

---

## 16. Recommended local development loop

```bash
# 1. Get store context
python shopify_codex_tool.py scan-context --include-content --out shopify-context.json

# 2. Run local Shopify theme preview through Shopify CLI
shopify theme dev

# 3. Make local theme changes
# Codex edits Liquid/CSS/JS/JSON templates locally.

# 4. If Shopify Admin schema/data is required, create a migration file
python shopify_codex_tool.py migration-apply --file shopify-migrations/001_feature.json

# 5. Apply only to dev store after approval
python shopify_codex_tool.py migration-apply --file shopify-migrations/001_feature.json --apply

# 6. Test preview again
shopify theme dev
```

---

## 17. API scopes and permission issues

Many Shopify Admin GraphQL operations require scopes.

Common scopes for this tool:

```text
read_products
write_products
read_files
write_files
read_metaobjects
write_metaobjects
read_metaobject_definitions
write_metaobject_definitions
read_themes
write_themes
read_content
write_content
```

If a command fails with an access/scope error, Codex should:

1. Report the exact error.
2. Identify the likely missing scope.
3. Avoid retrying blindly.
4. Ask the human to update app scopes/install permissions if needed.

Theme write operations may also need special Shopify approval/exemption. Codex must not assume theme write APIs are available just because a token exists.

---

## 18. Official documentation ground truth

Codex should treat Shopify official documentation as ground truth, especially for API names, input shapes, scope requirements, and API version changes.

Useful official docs:

```text
https://shopify.dev/docs/api
https://shopify.dev/docs/api/admin-graphql
https://shopify.dev/docs/api/admin-graphql/latest
https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
https://shopify.dev/docs/api/admin-graphql/latest/mutations/productCreate
https://shopify.dev/docs/api/admin-graphql/latest/mutations/metafieldDefinitionCreate
https://shopify.dev/docs/api/admin-graphql/latest/mutations/metafieldsSet
https://shopify.dev/docs/api/admin-graphql/latest/mutations/metaobjectDefinitionCreate
https://shopify.dev/docs/api/admin-graphql/latest/mutations/metaobjectCreate
https://shopify.dev/docs/api/admin-graphql/latest/mutations/fileCreate
https://shopify.dev/docs/api/admin-graphql/latest/mutations/stagedUploadsCreate
https://shopify.dev/docs/api/admin-graphql/latest/queries/themes
https://shopify.dev/docs/api/admin-graphql/latest/mutations/themeCreate
https://shopify.dev/docs/api/admin-graphql/latest/mutations/themePublish
https://shopify.dev/docs/storefronts/themes
https://shopify.dev/docs/storefronts/themes/tools/cli
```

If this README or tool conflicts with current Shopify docs, follow Shopify docs and update the tool.

---

## 19. Raw GraphQL examples

### 19.1 Query current shop

`query.graphql`:

```graphql
query ShopInfo {
  shop {
    id
    name
    myshopifyDomain
  }
}
```

Run:

```bash
python shopify_codex_tool.py graphql --query-file query.graphql
```

### 19.2 Use variables

`query.graphql`:

```graphql
query ProductByHandle($handle: String!) {
  productByHandle(handle: $handle) {
    id
    title
    handle
  }
}
```

`variables.json`:

```json
{
  "handle": "cloudsoft-blanket"
}
```

Run:

```bash
python shopify_codex_tool.py graphql --query-file query.graphql --variables-file variables.json
```

---

## 20. How to extend this tool

When Codex needs an API domain that is not wrapped by a command:

1. First use `graphql` with a query/mutation from official Shopify docs.
2. Confirm the query works against the dev store.
3. Add a named command to `shopify_codex_tool.py` only if the operation is used repeatedly.
4. Keep output JSON-friendly.
5. Keep write operations dry-run by default.
6. Add the new command to `mcp-tools` manifest.
7. Update this README.

Good candidates for future modules:

```text
orders
customers
inventory
locations
discounts
markets
translations
webhooks
bulk-operations
publications
selling-plans
delivery-profiles
store-policies
storefront-access-token
```

Do not add broad write permissions casually. Every write command should have a clear development use case and dry-run behavior.

---

## 21. Human approval rules

Codex should ask for explicit human approval before:

- Creating products in a real store
- Updating existing products
- Creating or changing metafield definitions
- Creating metaobject definitions
- Uploading many files
- Writing theme files through the API
- Publishing a theme
- Running `--apply` against any production store

Codex may run read-only commands without asking, if the task clearly requires Shopify context.

---

## 22. Common task recipes

### 22.1 Build a blanket product page section

```bash
python shopify_codex_tool.py scan-context --include-content --out shopify-context.json
python shopify_codex_tool.py product-get --handle cloudsoft-blanket
python shopify_codex_tool.py metafield-definitions-list --owner-type PRODUCT
```

Then Codex should inspect:

```text
templates/product.json
sections/main-product.liquid
snippets/price.liquid
snippets/product-card.liquid
assets/*.css
```

If a missing field is needed, create a migration.

### 22.2 Add a new product metafield

```bash
python shopify_codex_tool.py metafield-definitions-list --owner-type PRODUCT
python shopify_codex_tool.py metafield-definition-create --json-file warmth-level-definition.json
python shopify_codex_tool.py metafield-definition-create --json-file warmth-level-definition.json --apply
python shopify_codex_tool.py metafields-set --json-file warmth-level-values.json
python shopify_codex_tool.py metafields-set --json-file warmth-level-values.json --apply
```

### 22.3 Upload a local image to Shopify Files

```bash
python shopify_codex_tool.py staged-upload-target --filename blanket-hero.jpg --resource IMAGE > staged-target.json
python shopify_codex_tool.py staged-upload-file --target-json staged-target.json --path ./blanket-hero.jpg
```

Then use the returned `resourceUrl` with `fileCreate` through `graphql` or adapt the tool workflow as needed.

### 22.4 Create an unpublished theme from ZIP

```bash
python shopify_codex_tool.py theme-create --name "AI Dev Theme" --source "https://example.com/theme.zip"
python shopify_codex_tool.py theme-create --name "AI Dev Theme" --source "https://example.com/theme.zip" --apply
```

### 22.5 Publish a theme

Publishing is dangerous. Dry-run first:

```bash
python shopify_codex_tool.py theme-publish --theme-id gid://shopify/OnlineStoreTheme/123
```

Apply only after explicit human confirmation:

```bash
python shopify_codex_tool.py theme-publish --theme-id gid://shopify/OnlineStoreTheme/123 --apply
```

---

## 23. Error handling expectations for Codex

When a command fails, Codex should not hide the error.

Codex should report:

```text
- Command run
- Whether it was read-only or write/dry-run/apply
- Error message
- Likely cause
- Next safe step
```

Example:

```text
Command failed: themes-list
Likely cause: app token missing read_themes scope or store does not allow this API.
Next step: update app scopes and reinstall/regenerate token, or inspect theme through Shopify CLI.
```

---

## 24. Final mental model

Use this tool as the bridge between:

```text
Codex/local files
↔ Shopify Admin GraphQL API
↔ real store product/content/metadata/theme data
```

Codex should use it to answer these questions before coding:

```text
What data exists?
What metadata schema exists?
What content/files exist?
What theme exists?
What needs to be created?
What can be reused?
What must be dry-run first?
```

This tool exists so Codex can build Shopify themes with real store context instead of guessing.

---

## 25. API payload reference for agents

This section exists so an AI agent can build correct Shopify Admin GraphQL payloads from this README plus the tool. It is still bound to the configured `SHOPIFY_API_VERSION`. The current default in this repository is:

```text
SHOPIFY_API_VERSION=2026-04
```

Important rule:

```text
Never invent an input field. Use the field lists below, GraphQL introspection, or the official Shopify docs for the configured API version.
```

Official reference root:

```text
https://shopify.dev/docs/api/admin-graphql/latest
https://shopify.dev/docs/api/admin-graphql/latest/input-objects
https://shopify.dev/docs/api/admin-graphql/latest/mutations
https://shopify.dev/docs/api/admin-graphql/latest/queries
```

When the tool does not have a named command, use:

```bash
python shopify_codex_tool.py graphql --query-file query.graphql --variables-file variables.json
```

Before applying any write mutation:

```text
1. Read existing store data first.
2. Build the smallest payload.
3. Dry-run if using a wrapped command.
4. If using raw graphql, show the mutation and variables to the human before execution.
5. Execute only after explicit approval for writes.
```

---

## 26. GraphQL wrapper shapes used by this tool

The tool accepts these JSON wrapper shapes for existing write commands.

### 26.1 product-create

Command:

```bash
python shopify_codex_tool.py product-create --json-file product.json
python shopify_codex_tool.py product-create --json-file product.json --apply
```

Accepted file shapes:

```json
{
  "title": "Example product",
  "status": "DRAFT"
}
```

or:

```json
{
  "product": {
    "title": "Example product",
    "status": "DRAFT"
  },
  "media": [
    {
      "originalSource": "https://example.com/image.jpg",
      "mediaContentType": "IMAGE",
      "alt": "Example product"
    }
  ]
}
```

The tool sends:

```graphql
mutation ProductCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
  productCreate(product: $product, media: $media) {
    product { id title handle status }
    userErrors { field message code }
  }
}
```

### 26.2 product-update

Command:

```bash
python shopify_codex_tool.py product-update --json-file product-update.json
python shopify_codex_tool.py product-update --json-file product-update.json --apply
```

Accepted file shape:

```json
{
  "product": {
    "id": "gid://shopify/Product/1234567890",
    "title": "Updated title",
    "status": "ACTIVE"
  }
}
```

The `id` field is required for updates.

### 26.3 metafield-definition-create

```json
{
  "definition": {
    "name": "Short description",
    "namespace": "custom",
    "key": "short_description",
    "type": "multi_line_text_field",
    "ownerType": "PRODUCT"
  }
}
```

### 26.4 metafields-set

```json
{
  "metafields": [
    {
      "ownerId": "gid://shopify/Product/1234567890",
      "namespace": "custom",
      "key": "short_description",
      "type": "multi_line_text_field",
      "value": "Lightweight, breathable, and easy to care for."
    }
  ]
}
```

### 26.5 metaobject-definition-create

```json
{
  "definition": {
    "name": "Product benefit",
    "type": "product_benefit",
    "access": {
      "admin": "MERCHANT_READ_WRITE",
      "storefront": "PUBLIC_READ"
    },
    "fieldDefinitions": [
      {
        "name": "Title",
        "key": "title",
        "type": "single_line_text_field",
        "required": true
      },
      {
        "name": "Description",
        "key": "description",
        "type": "multi_line_text_field",
        "required": false
      }
    ]
  }
}
```

### 26.6 metaobject-create

```json
{
  "metaobject": {
    "type": "product_benefit",
    "handle": "soft-touch",
    "fields": [
      {
        "key": "title",
        "value": "Soft touch"
      },
      {
        "key": "description",
        "value": "Smooth fabric designed for everyday comfort."
      }
    ]
  }
}
```

---

## 27. Product APIs

Use product APIs for title, handle, status, description, vendor, product type, tags, SEO, theme template, category, collections, options, media, and product-level metafields.

### 27.1 ProductCreateInput fields

Valid top-level fields for `ProductCreateInput`:

```text
category
claimOwnership
collectionsToJoin
combinedListingRole
descriptionHtml
giftCard
giftCardTemplateSuffix
handle
metafields
productOptions
productType
requiresSellingPlan
seo
status
tags
templateSuffix
title
vendor
```

Practical meaning:

```text
category: Shopify product category taxonomy ID.
collectionsToJoin: collection GIDs to attach the product to.
descriptionHtml: product description as HTML.
handle: URL handle. Use lowercase words and hyphens.
metafields: product metafields created/updated with the product.
productOptions: product options such as Color, Size, Material. Maximum 3 product options.
productType: merchant-defined type.
seo: SEO title and description.
status: ACTIVE, ARCHIVED, or DRAFT.
tags: full tag list. Setting tags overwrites existing tags.
templateSuffix: product template suffix.
title: product title.
vendor: product vendor/brand.
```

Minimal create payload:

```json
{
  "product": {
    "title": "CloudSoft Blanket",
    "descriptionHtml": "<p>Soft everyday blanket.</p>",
    "vendor": "CloudSoft",
    "productType": "Blanket",
    "status": "DRAFT",
    "tags": ["blanket", "home"],
    "seo": {
      "title": "CloudSoft Blanket",
      "description": "A soft everyday blanket for home comfort."
    }
  }
}
```

Create with product options:

```json
{
  "product": {
    "title": "CloudSoft Blanket",
    "status": "DRAFT",
    "productOptions": [
      {
        "name": "Color",
        "values": [
          { "name": "Blue" },
          { "name": "Gray" }
        ]
      },
      {
        "name": "Size",
        "values": [
          { "name": "Twin" },
          { "name": "Queen" }
        ]
      }
    ]
  }
}
```

Product creation creates a product and its initial/default variant. For multiple variants, use `productSet` or `productVariantsBulkCreate` through raw GraphQL.

### 27.2 ProductUpdateInput fields

Valid top-level fields for `ProductUpdateInput`:

```text
category
collectionsToJoin
collectionsToLeave
deleteConflictingConstrainedMetafields
descriptionHtml
giftCardTemplateSuffix
handle
id
metafields
productType
redirectNewHandle
requiresSellingPlan
seo
status
tags
templateSuffix
title
vendor
```

Required for update:

```text
id
```

Example:

```json
{
  "product": {
    "id": "gid://shopify/Product/1234567890",
    "title": "CloudSoft Blanket - Updated",
    "handle": "cloudsoft-blanket",
    "redirectNewHandle": true,
    "status": "ACTIVE",
    "collectionsToJoin": [
      "gid://shopify/Collection/1111111111"
    ],
    "collectionsToLeave": [
      "gid://shopify/Collection/2222222222"
    ],
    "seo": {
      "title": "CloudSoft Blanket",
      "description": "Soft blanket for everyday home comfort."
    }
  }
}
```

### 27.3 Product category

`category` is a Shopify taxonomy category ID. Do not put a text label like `"Blankets"` into `category`.

Correct pattern:

```json
{
  "product": {
    "id": "gid://shopify/Product/1234567890",
    "category": "gid://shopify/TaxonomyCategory/hg-3-2-1"
  }
}
```

If the category ID is unknown, do not guess. Search Shopify taxonomy/docs or use Admin UI/category data available from the API.

### 27.4 Product status

Common values:

```text
ACTIVE
ARCHIVED
DRAFT
```

Use `DRAFT` for generated/test products unless the human explicitly asks to publish.

---

## 28. Variant APIs

Variants are not fully wrapped by a named command in this tool yet. Use raw GraphQL for:

```text
productSet
productVariantsBulkCreate
productVariantsBulkUpdate
productVariantsBulkDelete
```

Preferred practical choices:

```text
Use productSet when creating or replacing a product with options and variants as one synchronized structure.
Use productVariantsBulkCreate when adding many variants to an existing product.
Use productVariantsBulkUpdate when changing prices, SKU, barcode, option values, media, inventory, or metafields for existing variants.
```

### 28.1 ProductVariantSetInput fields

Valid fields used by `productSet` variants:

```text
barcode
compareAtPrice
file
id
inventoryItem
inventoryPolicy
inventoryQuantities
metafields
optionValues
position
price
requiresComponents
showUnitPrice
sku
taxable
taxCode
unitPriceMeasurement
```

Practical meaning:

```text
barcode: UPC/EAN/ISBN or other barcode.
compareAtPrice: crossed-out/list price.
file: file/media input associated with the variant.
id: required when updating an existing variant.
inventoryItem: SKU, cost, tracked inventory details.
inventoryPolicy: DENY or CONTINUE when out of stock.
inventoryQuantities: starting or updated inventory quantities by location where supported.
metafields: variant-level custom fields.
optionValues: selected values for product options, such as Color=Blue and Size=Queen.
position: variant ordering.
price: variant sale price.
requiresComponents: bundle parent behavior.
showUnitPrice: show unit price.
sku: variant SKU.
taxable: whether the variant is taxable.
taxCode: tax code.
unitPriceMeasurement: unit price measurement.
```

### 28.2 ProductVariantsBulkInput fields

Valid fields used by `productVariantsBulkCreate` and `productVariantsBulkUpdate`:

```text
barcode
compareAtPrice
id
inventoryItem
inventoryPolicy
inventoryQuantities
mediaId
mediaSrc
metafields
optionValues
price
quantityAdjustments
requiresComponents
showUnitPrice
taxable
taxCode
unitPriceMeasurement
```

For create, `id` is not used. For update, `id` identifies the variant.

### 28.3 Raw GraphQL: productVariantsBulkCreate

`query.graphql`:

```graphql
mutation ProductVariantsBulkCreate(
  $productId: ID!
  $variants: [ProductVariantsBulkInput!]!
) {
  productVariantsBulkCreate(productId: $productId, variants: $variants) {
    product {
      id
      title
    }
    productVariants {
      id
      title
      sku
      price
      selectedOptions {
        name
        value
      }
    }
    userErrors {
      field
      message
    }
  }
}
```

`variables.json`:

```json
{
  "productId": "gid://shopify/Product/1234567890",
  "variants": [
    {
      "price": "39.99",
      "compareAtPrice": "59.99",
      "barcode": "012345678905",
      "inventoryPolicy": "DENY",
      "taxable": true,
      "optionValues": [
        {
          "optionName": "Color",
          "name": "Blue"
        },
        {
          "optionName": "Size",
          "name": "Queen"
        }
      ],
      "inventoryItem": {
        "sku": "CS-BLUE-QUEEN",
        "tracked": true
      },
      "metafields": [
        {
          "namespace": "custom",
          "key": "material",
          "type": "single_line_text_field",
          "value": "Polyester"
        }
      ]
    }
  ]
}
```

Run:

```bash
python shopify_codex_tool.py graphql --query-file query.graphql --variables-file variables.json
```

### 28.4 Raw GraphQL: productVariantsBulkUpdate

`query.graphql`:

```graphql
mutation ProductVariantsBulkUpdate(
  $productId: ID!
  $variants: [ProductVariantsBulkInput!]!
) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    product {
      id
      title
    }
    productVariants {
      id
      title
      sku
      price
    }
    userErrors {
      field
      message
    }
  }
}
```

`variables.json`:

```json
{
  "productId": "gid://shopify/Product/1234567890",
  "variants": [
    {
      "id": "gid://shopify/ProductVariant/9876543210",
      "price": "34.99",
      "compareAtPrice": "49.99",
      "inventoryItem": {
        "sku": "CS-BLUE-QUEEN-V2",
        "tracked": true
      },
      "taxable": true
    }
  ]
}
```

---

## 29. Collection APIs

Collections are partially wrapped by `collections-list`. Create/update currently require raw GraphQL.

### 29.1 CollectionInput fields

Valid fields:

```text
descriptionHtml
handle
id
image
metafields
products
redirectNewHandle
ruleSet
seo
sortOrder
templateSuffix
title
publications
```

Practical meaning:

```text
descriptionHtml: collection description as HTML.
handle: URL handle.
id: required when updating an existing collection.
image: collection image.
metafields: collection-level custom fields.
products: initial list of product IDs. Only valid with collectionCreate.
redirectNewHandle: create redirect after changing handle.
ruleSet: legacy smart collection rules. Prefer newer source/condition models when applicable.
seo: SEO title and description.
sortOrder: product sorting inside collection.
templateSuffix: collection template suffix.
title: collection title. Required for create.
publications: deprecated. Avoid unless official docs for the configured version require it.
```

### 29.2 Raw GraphQL: collectionCreate

`query.graphql`:

```graphql
mutation CollectionCreate($input: CollectionInput!) {
  collectionCreate(input: $input) {
    collection {
      id
      title
      handle
    }
    userErrors {
      field
      message
    }
  }
}
```

`variables.json`:

```json
{
  "input": {
    "title": "Blankets",
    "handle": "blankets",
    "descriptionHtml": "<p>Soft blankets for every room.</p>",
    "products": [
      "gid://shopify/Product/1234567890"
    ],
    "seo": {
      "title": "Blankets",
      "description": "Shop soft blankets for home comfort."
    },
    "sortOrder": "BEST_SELLING"
  }
}
```

### 29.3 Raw GraphQL: collectionUpdate

`query.graphql`:

```graphql
mutation CollectionUpdate($input: CollectionInput!) {
  collectionUpdate(input: $input) {
    collection {
      id
      title
      handle
    }
    userErrors {
      field
      message
    }
  }
}
```

`variables.json`:

```json
{
  "input": {
    "id": "gid://shopify/Collection/1111111111",
    "title": "Premium Blankets",
    "handle": "premium-blankets",
    "redirectNewHandle": true,
    "descriptionHtml": "<p>Premium blankets for better rest.</p>"
  }
}
```

---

## 30. Product options and option values

Product options define variant dimensions. Examples:

```text
Color
Size
Material
```

Shopify product options limit:

```text
Maximum product options per product: 3
```

Do not create variants with option names that do not exist on the product. First create or update the product options, then create variants with matching `optionValues`.

Common `optionValues` pattern:

```json
[
  {
    "optionName": "Color",
    "name": "Blue"
  },
  {
    "optionName": "Size",
    "name": "Queen"
  }
]
```

If Shopify rejects the shape, inspect `VariantOptionValueInput` for the configured API version with introspection or official docs.

---

## 31. Metafields for product, variant, collection, page, and shop

Use metafields for simple custom data on an owner resource.

Common owner types:

```text
PRODUCT
PRODUCTVARIANT
COLLECTION
PAGE
SHOP
```

Common metafield value types:

```text
single_line_text_field
multi_line_text_field
rich_text_field
number_integer
number_decimal
boolean
date
date_time
url
json
color
money
file_reference
product_reference
collection_reference
variant_reference
metaobject_reference
list.single_line_text_field
list.product_reference
list.collection_reference
list.variant_reference
list.metaobject_reference
```

Definition example:

```json
{
  "definition": {
    "name": "Care instructions",
    "namespace": "custom",
    "key": "care_instructions",
    "type": "multi_line_text_field",
    "ownerType": "PRODUCT"
  }
}
```

Set value example:

```json
{
  "metafields": [
    {
      "ownerId": "gid://shopify/Product/1234567890",
      "namespace": "custom",
      "key": "care_instructions",
      "type": "multi_line_text_field",
      "value": "Machine wash cold. Tumble dry low."
    }
  ]
}
```

Rules:

```text
Create or confirm the metafield definition before writing values.
Use the exact same namespace, key, and type for values.
For reference/list/json/rich text types, value must be serialized exactly as Shopify expects.
Do not use one giant JSON metafield when merchant-editable metaobjects are more appropriate.
```

---

## 32. Metaobjects for structured content

Use metaobjects for reusable structured content:

```text
product benefits
FAQ items
size guide rows
ingredient rows
care instruction blocks
landing page sections
brand trust badges
```

Definition fields are declared in `metaobject-definition-create`; entries are created with `metaobject-create`.

Metaobject definition example:

```json
{
  "definition": {
    "name": "FAQ item",
    "type": "faq_item",
    "access": {
      "admin": "MERCHANT_READ_WRITE",
      "storefront": "PUBLIC_READ"
    },
    "fieldDefinitions": [
      {
        "name": "Question",
        "key": "question",
        "type": "single_line_text_field",
        "required": true
      },
      {
        "name": "Answer",
        "key": "answer",
        "type": "multi_line_text_field",
        "required": true
      }
    ]
  }
}
```

Entry example:

```json
{
  "metaobject": {
    "type": "faq_item",
    "handle": "shipping-time",
    "fields": [
      {
        "key": "question",
        "value": "How long does shipping take?"
      },
      {
        "key": "answer",
        "value": "Most orders ship within 2 business days."
      }
    ]
  }
}
```

To connect metaobjects to products, usually create a product metafield with type:

```text
metaobject_reference
list.metaobject_reference
```

Then set the product metafield value to the metaobject GID or a serialized list of GIDs according to Shopify's expected value format for that API version.

---

## 33. Online Store content APIs

The tool currently wraps read commands:

```text
pages-list
menus-list
```

For creating/updating content, use raw GraphQL and official docs for the configured API version.

### 33.1 Pages

Common page create fields:

```text
body
handle
isPublished
metafields
publishDate
templateSuffix
title
```

Create page example:

`query.graphql`:

```graphql
mutation PageCreate($page: PageCreateInput!) {
  pageCreate(page: $page) {
    page {
      id
      title
      handle
    }
    userErrors {
      field
      message
    }
  }
}
```

`variables.json`:

```json
{
  "page": {
    "title": "Size Guide",
    "handle": "size-guide",
    "body": "<p>Use this guide to choose the right size.</p>",
    "isPublished": false,
    "templateSuffix": "size-guide"
  }
}
```

### 33.2 Menus/navigation

Use `menus-list` to inspect existing menus. Menu write mutations and input shapes can change; use raw GraphQL only after verifying the current docs/schema.

Read:

```bash
python shopify_codex_tool.py menus-list
```

If adding a menu item is required, first inspect existing menu IDs and then use the official Admin GraphQL mutation for the configured API version.

### 33.3 Blogs/articles

This tool does not currently wrap blog/article commands. Use raw GraphQL and inspect the official docs/schema before creating:

```text
blogs
articles
blogCreate
articleCreate
articleUpdate
```

Common article fields usually include title, author, body HTML, handle, tags, image, publication fields, and SEO fields, but the exact input object must be verified for `SHOPIFY_API_VERSION`.

---

## 34. Files and media

Use files/media for product images, collection images, downloadable files, and theme/content assets.

Wrapped commands:

```text
files-list
file-create-url
staged-upload-target
staged-upload-file
```

Create file from URL:

```bash
python shopify_codex_tool.py file-create-url --url "https://example.com/hero.jpg" --content-type IMAGE --alt "Hero image"
python shopify_codex_tool.py file-create-url --url "https://example.com/hero.jpg" --content-type IMAGE --alt "Hero image" --apply
```

Local upload flow:

```bash
python shopify_codex_tool.py staged-upload-target --filename hero.jpg --resource IMAGE > staged-target.json
python shopify_codex_tool.py staged-upload-file --target-json staged-target.json --path ./hero.jpg
```

After staged upload, use the returned `resourceUrl` with `fileCreate` or the relevant media mutation according to current docs.

Product media at creation can be passed through the `media` array in `product-create`:

```json
{
  "product": {
    "title": "CloudSoft Blanket",
    "status": "DRAFT"
  },
  "media": [
    {
      "originalSource": "https://example.com/cloudsoft.jpg",
      "mediaContentType": "IMAGE",
      "alt": "CloudSoft Blanket"
    }
  ]
}
```

---

## 35. Migration plans for product and content work

Prefer migration files for repeatable Admin changes. This tool supports these top-level arrays:

```json
{
  "metafield_definitions": [],
  "metaobject_definitions": [],
  "products": [],
  "metafields": [],
  "metaobjects": [],
  "files_from_url": []
}
```

Example migration:

```json
{
  "metafield_definitions": [
    {
      "name": "Product benefits",
      "namespace": "custom",
      "key": "product_benefits",
      "type": "list.metaobject_reference",
      "ownerType": "PRODUCT"
    }
  ],
  "metaobject_definitions": [
    {
      "name": "Product benefit",
      "type": "product_benefit",
      "access": {
        "admin": "MERCHANT_READ_WRITE",
        "storefront": "PUBLIC_READ"
      },
      "fieldDefinitions": [
        {
          "name": "Title",
          "key": "title",
          "type": "single_line_text_field",
          "required": true
        },
        {
          "name": "Description",
          "key": "description",
          "type": "multi_line_text_field",
          "required": false
        }
      ]
    }
  ],
  "products": [
    {
      "product": {
        "title": "CloudSoft Blanket",
        "status": "DRAFT",
        "vendor": "CloudSoft",
        "productType": "Blanket"
      },
      "media": [
        {
          "originalSource": "https://example.com/cloudsoft.jpg",
          "mediaContentType": "IMAGE",
          "alt": "CloudSoft Blanket"
        }
      ]
    }
  ],
  "files_from_url": [
    {
      "originalSource": "https://example.com/benefit-icon.png",
      "contentType": "IMAGE",
      "alt": "Benefit icon"
    }
  ]
}
```

Dry-run:

```bash
python shopify_codex_tool.py migration-apply --file shopify-migrations/001_product_content.json
```

Apply only after approval:

```bash
python shopify_codex_tool.py migration-apply --file shopify-migrations/001_product_content.json --apply
```

---

## 36. Schema introspection when exact fields are needed

If this README is missing a field, or Shopify returns `Unknown argument`, `Field is not defined`, or an enum/type error, inspect the schema for the configured API version.

### 36.1 Inspect an input object

`query.graphql`:

```graphql
query InputObjectFields($name: String!) {
  __type(name: $name) {
    kind
    name
    inputFields {
      name
      defaultValue
      type {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
            }
          }
        }
      }
    }
  }
}
```

`variables.json`:

```json
{
  "name": "ProductCreateInput"
}
```

Run:

```bash
python shopify_codex_tool.py graphql --query-file query.graphql --variables-file variables.json
```

Useful input object names:

```text
ProductCreateInput
ProductUpdateInput
ProductSetInput
ProductVariantSetInput
ProductVariantsBulkInput
VariantOptionValueInput
OptionCreateInput
CollectionInput
MetafieldDefinitionInput
MetafieldsSetInput
MetafieldInput
MetaobjectDefinitionCreateInput
MetaobjectCreateInput
FileCreateInput
CreateMediaInput
PageCreateInput
PageUpdateInput
```

### 36.2 Inspect mutation arguments

`query.graphql`:

```graphql
query MutationFields {
  __schema {
    mutationType {
      fields {
        name
        args {
          name
          type {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
              }
            }
          }
        }
      }
    }
  }
}
```

Run:

```bash
python shopify_codex_tool.py graphql --query-file query.graphql
```

Search the output for the mutation name, then build variables matching its argument names and input object types.

### 36.3 Inspect enum values

`query.graphql`:

```graphql
query EnumValues($name: String!) {
  __type(name: $name) {
    kind
    name
    enumValues {
      name
      description
      isDeprecated
      deprecationReason
    }
  }
}
```

`variables.json`:

```json
{
  "name": "ProductStatus"
}
```

Useful enum names:

```text
ProductStatus
ProductVariantInventoryPolicy
CollectionSortOrder
MediaContentType
FileContentType
MetafieldOwnerType
```

---

## 37. Product/content task checklist for agents

For any product, variant, category, collection, or content task:

```text
1. Run shop-info to verify auth.
2. Run scan-context or the narrow read command first.
3. Identify exact resource IDs: product ID, variant ID, collection ID, file ID, metaobject ID.
4. Identify exact input object and mutation.
5. Use a wrapped dry-run command when available.
6. Use raw graphql only when no wrapped command exists.
7. Include userErrors in every mutation response selection.
8. Never ignore userErrors even when ok=true.
9. Keep generated products DRAFT unless asked otherwise.
10. Never publish themes or content without explicit approval.
```

Recommended read commands before writes:

```bash
python shopify_codex_tool.py shop-info
python shopify_codex_tool.py products-list --first 20
python shopify_codex_tool.py product-get --handle HANDLE
python shopify_codex_tool.py collections-list --first 20
python shopify_codex_tool.py metafield-definitions-list --owner-type PRODUCT
python shopify_codex_tool.py metafield-definitions-list --owner-type PRODUCTVARIANT
python shopify_codex_tool.py metafield-definitions-list --owner-type COLLECTION
python shopify_codex_tool.py metaobject-definitions-list
python shopify_codex_tool.py files-list --first 20
python shopify_codex_tool.py pages-list --first 20
python shopify_codex_tool.py menus-list
```
