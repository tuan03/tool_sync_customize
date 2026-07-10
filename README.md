# Amazon → Shopify Customizer

Custom Shopify app that converts Amazon `gc:app-config` JSON into a product metafield and renders a theme-app-extension customizer.

## Local setup

1. Copy `.env.shopify.example` to `.env.shopify` and fill Shopify credentials plus two random secrets.
2. Run `npm start`, then open `http://localhost:3000/admin.html`.
3. Paste a Product ID and raw Amazon JSON, run **Convert**, then **Dry-run Sync** before applying.
   If Amazon fees need currency conversion before they are written to Shopify, enter an explicit price multiplier.
4. Link/deploy the Shopify app with Shopify CLI, add the **Amazon customizer** app block to the product template, and configure its upload endpoint/token.

## Commands

- `npm test`: converter and validation unit tests.
- `npm run test:smoke`: existing browser regression suite (requires Playwright and the local server).
- `npm run cleanup`: list customer assets older than 30 days.
- `npm run cleanup:apply`: permanently delete those assets.

The sync endpoint only writes when the request contains `apply: true`. Shopify JSON metafields are checked against the 128KB limit before every write.
