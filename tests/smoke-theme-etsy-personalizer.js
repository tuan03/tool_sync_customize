"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const repoRoot = path.resolve(__dirname, "../..");
const extensionRoot = path.resolve(__dirname, "../extensions/amazon-customizer");
const themeRoot = path.join(repoRoot, "LeatherBag");
const personalizerSource = fs.readFileSync(path.join(extensionRoot, "assets/etsy-personalizer.js"), "utf8").replace(/<\/script/gi, "<\\/script");
const stickySource = fs.readFileSync(path.join(themeRoot, "assets/hc-sticky-atc.js"), "utf8").replace(/<\/script/gi, "<\\/script");
const productFormSource = fs.readFileSync(path.join(themeRoot, "assets/hc-product-form.js"), "utf8").replace(/<\/script/gi, "<\\/script");

const personalizerConfig = {
  schemaVersion: 2,
  mode: "personalization_form",
  source: { platform: "etsy", listingId: "4562339494" },
  questions: [{ id: "family", type: "text_input", label: "Personalization Box", required: true, maxCharacters: 256, options: [], addOnPrice: null }],
  pricing: { mode: "addon_product", currencyCode: "USD", amounts: [], addonProduct: null },
};

const productConfig = {
  productVariants: [
    { id: 111, options: ["Small"], price: 2000, compare_at_price: null, available: true, featured_image: { src: "https://cdn.example.com/small.jpg" } },
    { id: 222, options: ["Large"], price: 3000, compare_at_price: null, available: false, featured_image: { src: "https://cdn.example.com/large.jpg" } },
  ],
  moneyFormat: "${{amount}}",
  currencyCode: "USD",
  hasAmazonCustomizer: false,
  hasCustomizer: true,
  customizerProvider: "etsy",
  requiresCustomization: true,
  customizerConfigValid: true,
  inventoryByVariant: {},
  i18n: { addToCart: "Add to cart", soldOut: "Sold out", unavailable: "Unavailable" },
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    let cartPayload = null;
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    page.on("pageerror", (error) => console.error("browser page error:", error.message));
    await page.exposeFunction("captureThemeCart", (payload) => { cartPayload = payload; });
    await page.setContent(`<!doctype html><html><body>
      <form id="related-product-form" action="/cart/add"><input name="id" value="111"><button class="related-add">Related add</button></form>
      <section class="hc-product-main" data-section-id="test">
        <div data-hc-customizer-app-source hidden>
          <div class="amzcustom-root" data-product-personalizer-root data-product-id="99" data-product-form-id="HcProductForm-test" data-variant-id="111" data-quantity="2" data-available="true" data-base-price="20" data-currency-code="USD" data-product-title="Custom doormat" data-product-image="https://cdn.example.com/small.jpg" data-product-variants='${JSON.stringify(productConfig.productVariants)}' data-config='${JSON.stringify(personalizerConfig)}'>
            <button class="amzcustom-open" type="button">Customize</button>
          </div>
          <script>${personalizerSource}</script>
        </div>
        <div data-hc-option-group data-option-position="1">
          <button type="button" class="hc-option-button is-selected" value="Small" data-hc-option-button data-option-position="1">Small</button>
          <button type="button" class="hc-option-button" value="Large" data-hc-option-button data-option-position="1">Large</button>
        </div>
        <span data-hc-total-price>$20.00</span><span data-hc-compare-price hidden></span>
        <form id="HcProductForm-test" class="hc-product-form" action="/cart/add" data-hc-product-form>
          <input type="hidden" name="id" value="111">
          <button type="button" data-hc-quantity-minus>-</button>
          <input name="quantity" value="2" min="1" step="1" data-hc-quantity-input>
          <button type="button" data-hc-quantity-plus>+</button>
          <div data-hc-customizer-app-target></div>
          <p data-hc-customizer-status><span data-hc-customizer-status-text>Loading customization...</span><button type="button" data-hc-customizer-retry hidden>Reload</button></p>
          <p data-hc-product-error hidden></p>
        </form>
        <div data-hc-sticky-atc hidden><span data-hc-sticky-price>$20.00</span><input value="2" data-hc-sticky-quantity-input><button type="button" data-hc-sticky-quantity-minus>-</button><button type="button" data-hc-sticky-quantity-plus>+</button><button type="button" data-hc-sticky-btn><span>Customize</span></button></div>
        <script>${stickySource}</script>
        <script type="application/json" data-hc-main-product-config>${JSON.stringify(productConfig)}</script>
        <script>${productFormSource}</script>
      </section>
      <script>window.Shopify={routes:{root:"/"}};window.fetch=async(url,options)=>{if(String(url).endsWith("cart/add.js")){const payload=JSON.parse(options.body);await window.captureThemeCart(payload);return new Response(JSON.stringify({ok:true}),{status:200,headers:{"content-type":"application/json"}})}throw new Error("Unexpected fetch "+url)}</script>
      <script>${personalizerSource}</script>
    </body></html>`);

    const root = page.locator("[data-product-personalizer-root]");
    await page.waitForFunction(() => document.querySelector("[data-product-personalizer-root]")?.dataset.personalizerReady === "true");
    assert.equal(await root.getAttribute("data-product-form-id"), "HcProductForm-test");
    assert.equal(await page.locator("[data-hc-customizer-app-target] [data-product-personalizer-root]").count(), 1);
    assert.equal(await page.locator(".etsy-personalizer-modal").count(), 1);
    assert.equal(await page.locator("#HcProductForm-test").evaluate((form) => form.classList.contains("etsy-personalizer-required-form")), true);
    assert.equal(await page.locator("#related-product-form").evaluate((form) => form.classList.contains("etsy-personalizer-required-form")), false);
    assert.equal(await page.locator("[data-hc-customizer-status]").isHidden(), true);

    await page.click("[data-hc-quantity-plus]");
    await page.click(".hc-option-button[value=Large]");
    assert.equal(await root.getAttribute("data-variant-id"), "222");
    assert.equal(await root.getAttribute("data-quantity"), "3");
    assert.equal(await page.locator(".amzcustom-open").isDisabled(), true);
    assert.equal(await page.locator("[data-hc-sticky-btn]").isDisabled(), true);

    await page.click(".hc-option-button[value=Small]");
    assert.equal(await page.locator(".amzcustom-open").isEnabled(), true);
    await page.locator("[data-hc-sticky-atc]").evaluate((element) => { element.hidden = false; });
    await page.click("[data-hc-sticky-btn]");
    assert.equal(await page.locator(".etsy-personalizer-modal").isVisible(), true);
    assert.equal(await page.locator(".etsy-personalizer-product-image").getAttribute("src"), "https://cdn.example.com/small.jpg");
    assert.match(await page.locator(".etsy-personalizer-total-price").textContent(), /20\.00/);
    await page.fill("[data-personalizer-text=family]", "The Parker Family");
    await page.click(".etsy-personalizer-add");
    await page.waitForFunction(() => document.querySelector(".etsy-personalizer-modal")?.hidden === true);
    assert.equal(cartPayload.items[0].id, 111);
    assert.equal(cartPayload.items[0].quantity, 3);
    assert.equal(cartPayload.items[0].properties["Personalization Box"], "The Parker Family");
    assert.equal(await page.locator("#related-product-form .related-add").isVisible(), true);

    console.log("Theme + Etsy personalizer integration smoke test passed.");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
