"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright");

async function mount(page, config, capture) {
  page.on("pageerror", (error) => console.error("browser page error:", error.message));
  await page.exposeFunction("capturePersonalizerCart", capture);
  await page.setContent(`<!doctype html><html><body><form action="/cart/add"><input name="id" value="111"><input name="quantity" value="2"><button class="native-add" type="submit" name="add">Add to cart</button><div class="amzcustom-root" data-product-personalizer-root data-product-id="1" data-product-title="Test product" data-product-image="https://cdn.example.com/product.jpg" data-product-variants='[{"id":111,"price":2000,"featured_image":{"src":"https://cdn.example.com/variant.jpg"}}]' data-variant-id="111" data-base-price="20" data-currency-code="USD" data-upload-url="/apps/product-personalizer/upload"><button class="amzcustom-open" type="button">Customize</button></div><script>window.Shopify={routes:{root:"/"}};window.fetch=async(url,options)=>{if(String(url).endsWith("cart/add.js")){const payload=JSON.parse(options.body);await window.capturePersonalizerCart(payload);return new Response(JSON.stringify({ok:true}),{status:200,headers:{"content-type":"application/json"}})}throw new Error("Unexpected fetch "+url)}</script></form></body></html>`);
  await page.locator("[data-product-personalizer-root]").evaluate((root, value) => { root.dataset.config = JSON.stringify(value); }, config);
  await page.addStyleTag({ path: path.join(__dirname, "../extensions/amazon-customizer/assets/amazon-customizer.css") });
  await page.addScriptTag({ path: path.join(__dirname, "../extensions/amazon-customizer/assets/etsy-personalizer.js") });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    let cartPayload = null;
    const page = await browser.newPage();
    await mount(page, {
      schemaVersion: 2,
      mode: "personalization_form",
      source: { platform: "etsy", listingId: "4561631461" },
      questions: [{ id: "name", type: "text_input", label: "Name", required: true, maxCharacters: 20, options: [], addOnPrice: null }],
      pricing: { mode: "addon_product", currencyCode: "USD", amounts: [], addonProduct: null },
    }, (payload) => { cartPayload = payload; });
    assert.equal(await page.locator("form").evaluate((form) => form.classList.contains("etsy-personalizer-required-form")), true);
    assert.equal(await page.locator(".native-add").isHidden(), true);
    await page.locator("form").evaluate((form) => form.requestSubmit());
    assert.equal(await page.locator(".etsy-personalizer-modal").isVisible(), true);
    await page.click(".etsy-personalizer-close");
    await page.click(".amzcustom-open");
    assert.equal(await page.locator(".etsy-personalizer-product-image").getAttribute("src"), "https://cdn.example.com/variant.jpg");
    assert.match(await page.locator(".etsy-personalizer-total-price").textContent(), /20\.00/);
    const desktopLayout = await page.locator(".etsy-personalizer-body").evaluate((body) => {
      const preview = body.querySelector(".etsy-personalizer-preview").getBoundingClientRect();
      const questions = body.querySelector(".etsy-personalizer-questions").getBoundingClientRect();
      return { previewRight: preview.right, questionsLeft: questions.left, fitsViewport: body.scrollWidth <= body.clientWidth };
    });
    assert(desktopLayout.previewRight <= desktopLayout.questionsLeft);
    assert.equal(desktopLayout.fitsViewport, true);
    await page.click(".etsy-personalizer-add");
    await assert.rejects(() => page.waitForFunction(() => false, null, { timeout: 100 }), /Timeout/);
    assert.equal(cartPayload, null);
    assert.equal(await page.locator("[data-question-error=name]").isVisible(), true);
    await page.fill("[data-personalizer-text=name]", "Smith Family");
    await page.click(".etsy-personalizer-add");
    for (let index = 0; index < 20 && !cartPayload; index += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(cartPayload.items.length, 1);
    assert.equal(cartPayload.items[0].quantity, 2);
    assert.equal(cartPayload.items[0].properties.Name, "Smith Family");
    await page.locator("form").evaluate((form) => { form.outerHTML = form.outerHTML; });
    await page.waitForFunction(() => document.querySelectorAll(".etsy-personalizer-modal").length === 1 && document.querySelector("form")?.classList.contains("etsy-personalizer-required-form"));
    await page.close();

    let feePayload = null;
    const feePage = await browser.newPage();
    await mount(feePage, {
      schemaVersion: 2,
      mode: "personalization_form",
      source: { platform: "etsy", listingId: "123" },
      questions: [{ id: "line", type: "text_input", label: "Custom line", required: false, maxCharacters: 20, options: [], addOnPrice: { amount: 5, currencyCode: "USD" } }],
      pricing: { mode: "addon_product", currencyCode: "USD", amounts: [5], addonProduct: { variants: { "5.00": "gid://shopify/ProductVariant/222" } } },
    }, (payload) => { feePayload = payload; });
    assert.equal(await feePage.locator("form").evaluate((form) => form.classList.contains("etsy-personalizer-required-form")), false);
    assert.equal(await feePage.locator(".native-add").isVisible(), true);
    await feePage.click(".amzcustom-open");
    await feePage.fill("[data-personalizer-text=line]", "Hello");
    assert.match(await feePage.locator(".etsy-personalizer-total-price").textContent(), /25\.00/);
    await feePage.click(".etsy-personalizer-add");
    for (let index = 0; index < 20 && !feePayload; index += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(feePayload.items.length, 2);
    assert.equal(feePayload.items[1].id, 222);
    assert.equal(feePayload.items[1].properties._personalization_fee, "true");

    const controlsPage = await browser.newPage();
    await mount(controlsPage, {
      schemaVersion: 2,
      mode: "personalization_form",
      source: { platform: "etsy", listingId: "controls" },
      questions: [
        { id: "font", type: "dropdown", label: "Font", required: true, options: [{ id: "arial", label: "Arial" }], addOnPrice: null },
        { id: "photos", type: "unlabeled_upload", label: "Photos", required: false, maxFiles: 2, options: [], addOnPrice: null },
      ],
      pricing: { mode: "addon_product", currencyCode: "USD", amounts: [], addonProduct: null },
    }, () => {});
    await controlsPage.click(".amzcustom-open");
    assert.equal(await controlsPage.locator("[data-personalizer-select=font]").count(), 1);
    assert.equal(await controlsPage.locator("[data-personalizer-file=photos]").count(), 2);
    await controlsPage.close();

    const labeledPage = await browser.newPage();
    await labeledPage.setViewportSize({ width: 390, height: 844 });
    await mount(labeledPage, {
      schemaVersion: 2,
      mode: "personalization_form",
      source: { platform: "etsy", listingId: "labeled" },
      questions: [{ id: "sides", type: "labeled_upload", label: "Photos", required: true, maxFiles: 2, options: [{ id: "front", label: "Front" }, { id: "back", label: "Back" }], addOnPrice: null }],
      pricing: { mode: "addon_product", currencyCode: "USD", amounts: [], addonProduct: null },
    }, () => {});
    await labeledPage.click(".amzcustom-open");
    assert.deepEqual(await labeledPage.locator(".etsy-personalizer-upload span").allTextContents(), ["Front", "Back"]);
    assert.equal(await labeledPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.equal(await labeledPage.locator(".etsy-personalizer-add").isVisible(), true);
    await labeledPage.close();
    console.log("Etsy personalizer storefront smoke test passed.");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
