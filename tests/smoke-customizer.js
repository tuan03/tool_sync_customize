const fs = require("fs");
const path = require("path");
const os = require("os");

const UPLOAD_FIXTURE = path.join(os.tmpdir(), "amazon-customizer-smoke.png");
if (!fs.existsSync(UPLOAD_FIXTURE)) {
  fs.writeFileSync(UPLOAD_FIXTURE, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
}

function loadPlaywright() {
  const candidates = [
    "playwright",
    path.join(process.env.TEMP || "", "pw-amz-debug", "node_modules", "playwright"),
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error("Playwright is not installed. Run npm install -D playwright or keep the temp debug install available.");
}

function mainUrl(file) {
  const har = JSON.parse(fs.readFileSync(file, "utf8"));
  const entry = har.log.entries.find((item) => item.request.url.includes("/customization/form"));
  if (!entry) throw new Error(`No customization/form URL found in ${file}`);
  return entry.request.url;
}

async function loadCustomizer(page, url) {
  await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
  await page.fill("#custom-url", url);
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/custom-form") && response.request().method() === "POST"),
    page.click("#load-form button"),
  ]);
  await page.waitForSelector("#workspace:not(.is-empty)", { timeout: 15000 });
}

async function controlLabels(page) {
  return page.$$eval("#controls .control-title h3", (items) => items.map((item) => item.textContent.trim()));
}

async function selectedValue(page, title) {
  const group = page.locator(`.control-group:has(.control-title h3:text-is("${title}"))`);
  const select = group.locator("select");
  if (await select.count()) return select.inputValue();
  const card = group.locator(".option-card.is-selected .option-name");
  return (await card.count()) ? (await card.first().textContent()).trim() : "";
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const { chromium } = loadPlaywright();
  const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const launchOptions = fs.existsSync(chrome) ? { headless: true, executablePath: chrome } : { headless: true };
  const browser = await chromium.launch(launchOptions);
  const results = [];

  for (const file of ["amazon.har", "new.har", "new2.har"]) {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    const consoleProblems = [];
    const requestFailures = [];
    const pageErrors = [];

    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type())) consoleProblems.push(`${message.type()}: ${message.text()}`);
    });
    page.on("requestfailed", (request) => {
      if (!request.url().includes("/favicon.ico")) {
        requestFailures.push(`${request.method()} ${request.url()} ${request.failure() && request.failure().errorText}`);
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await loadCustomizer(page, mainUrl(file));
    const status = await page.textContent("#status");
    const warningCount = await page.$$eval("#warnings .warning", (items) => items.length);
    assert(status === "Customizer loaded.", `${file}: customizer did not load`);
    assert(warningCount === 0, `${file}: visible warnings found`);

    const data = { file, controls: await controlLabels(page), price: await page.textContent("#price-delta") };

    if (file === "amazon.har") {
      assert((await page.$$eval('.control-group:has(.control-title h3:text-is("Choose Personalized Option")) .option-card', (items) => items.length)) === 2, "amazon.har: personalized option should render as clickable cards");
      assert((await page.$$eval('.control-group:has(.control-title h3:text-is("CONFIRMATION PRODUCT")) .option-card', (items) => items.length)) === 2, "amazon.har: non-dropdown text options should render as clickable cards");
      assert((await page.$$eval('.control-group:has(.control-title h3:text-is("CONFIRMATION PRODUCT")) select', (items) => items.length)) === 0, "amazon.har: confirmation should not render as select");
      await page.locator('.control-group:has(.control-title h3:text-is("Choose Personalized Option")) .option-card').nth(1).click();
      await page.waitForTimeout(250);
      const labels = await controlLabels(page);
      assert(labels.includes("Font"), "amazon.har: Font did not appear after Custom Name");
      assert(!labels.includes("Text Color"), "amazon.har: fixed Text Color should be hidden");
      assert(labels.includes("Custom Name"), "amazon.har: Custom Name input did not appear");
      assert((await page.$$eval(".font-preview", (items) => items.length)) >= 1, "amazon.har: font preview missing");
      assert((await page.$$eval(".font-choice", (items) => items.length)) >= 12, "amazon.har: visible font choices missing");
      assert((await page.$$eval('link[href*="fonts.googleapis"]', (items) => items.length)) === 0, "amazon.har: should use HAR font assets, not Google Fonts");
      await page.locator('.control-group:has(.control-title h3:text-is("Custom Name")) input[type="text"]').fill("ABCDEFGHIJKLMNOPQRST");
      await page.waitForTimeout(150);
      const customNameFontSize = await page.$eval(".placement-layer", (item) => Number(getComputedStyle(item).fontSize.replace("px", "")));
      assert(customNameFontSize < 18, "amazon.har: long custom text did not auto-fit inside placement");
      data.afterCustomName = labels;
    }

    if (file === "new.har") {
      assert((await page.$$eval('.control-group:has(.control-title h3:text-is("Message Windows")) select', (items) => items.length)) === 1, "new.har: Message Windows should render as select");
      assert((await page.$$eval('.control-group:has(.control-title h3:text-is("Choose Item Size")) select', (items) => items.length)) === 1, "new.har: Choose Item Size should render as select");
      assert((await selectedValue(page, "Message Windows")) !== "", "new.har: required Message Windows has no default");
      assert((await selectedValue(page, "Would You Like to Purchase a Matching Tapestry?")) === "", "new.har: optional paid tapestry should not default");
      await page.selectOption('.control-group:has(.control-title h3:text-is("Message Windows")) select', { label: "YES" });
      await page.waitForTimeout(250);
      const labels = await controlLabels(page);
      assert(labels.includes("Message Sender's Name"), "new.har: sender name did not appear after YES");
      assert(labels.includes("Custom Message Text"), "new.har: custom message did not appear after YES");
      assert(!labels.includes("Colors"), "new.har: fixed single color controls should be hidden");
      assert((await page.$$eval(".font-preview", (items) => items.length)) >= 1, "new.har: font preview missing");
      assert((await page.$$eval(".font-choice", (items) => items.length)) >= 1, "new.har: visible font choice missing");
      assert((await page.$$eval('link[href*="fonts.googleapis"]', (items) => items.length)) === 0, "new.har: should use HAR font assets, not Google Fonts");
      assert((await page.textContent("#price-delta")) === "+0.00", "new.har: optional paid field changed default price");
      await page.setInputFiles("input[type=file]", UPLOAD_FIXTURE);
      await page.waitForTimeout(350);
      assert((await page.$$eval(".placement-layer img.inner-image", (items) => items.length)) >= 1, "new.har: upload preview missing");
      assert((await page.$$eval(".zoom-control", (items) => items.length)) >= 1, "new.har: upload zoom missing");
      data.afterMessageYes = labels;
    }

    if (file === "new2.har") {
      assert((await page.$$eval('.control-group:has(.control-title h3:text-is("Color")) .option-card', (items) => items.length)) === 30, "new2.har: Color should render as clickable image cards");
      assert((await selectedValue(page, "Design optimization (HD images or background removal)")) !== "", "new2.har: optional no-cost default missing");
      assert((await page.$$eval(".swatch", (items) => items.length)) >= 16, "new2.har: multi-color swatches missing");
      assert((await page.$$eval(".font-preview", (items) => items.length)) >= 1, "new2.har: font preview missing");
      assert((await page.$$eval(".font-choice", (items) => items.length)) >= 20, "new2.har: visible font choices missing");
      assert((await page.$$eval('link[href*="fonts.googleapis"]', (items) => items.length)) === 0, "new2.har: should use HAR font assets, not Google Fonts");
      const uploaders = page.locator("input[type=file]");
      await uploaders.nth(0).setInputFiles(UPLOAD_FIXTURE);
      await uploaders.nth(1).setInputFiles(UPLOAD_FIXTURE);
      await page
        .locator('.control-group:has(.control-title h3:text-is("Your Image 02")) input[type="range"]')
        .nth(1)
        .fill("15");
      await page.waitForTimeout(350);
      const rotatedStyle = await page.$$eval(".placement-layer img.inner-image", (items) => {
        const item = items[items.length - 1];
        return item ? getComputedStyle(item).transform : "none";
      });
      assert(rotatedStyle !== "none", "new2.har: rotated image preview transform missing");
      const imageLayers = page.locator(".placement-layer", { has: page.locator("img.inner-image") });
      const topImageLayer = imageLayers.last();
      const box = await topImageLayer.boundingBox();
      assert(Boolean(box), "new2.har: uploaded image layer has no bounding box");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 35, box.y + box.height / 2 - 20);
      await page.mouse.up();
      await page.waitForTimeout(150);
      await page
        .locator('.control-group:has(.control-title h3:text-is("Text 01")) textarea')
        .fill(["ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT"].join("\n"));
      await page.locator('.control-group:has(.control-title h3:text-is("Text 02")) textarea').fill("WORLD");
      assert((await page.$$eval(".placement-layer.is-active-edit", (items) => items.length)) >= 1, "new2.har: active edit layer highlight missing");
      assert((await page.$$eval(".control-group.is-active-edit", (items) => items.length)) >= 1, "new2.har: active edit control highlight missing");
      assert((await page.$$eval(".placement-layer img.inner-image", (items) => items.length)) >= 2, "new2.har: upload previews missing");
      assert((await page.$$eval(".zoom-control", (items) => items.length)) >= 4, "new2.har: image/text edit controls missing");
      const textLineHeight = await page.$eval(".placement-layer:not(:has(img))", (item) => getComputedStyle(item).lineHeight);
      assert(textLineHeight !== "normal", "new2.har: text layer line-height was not explicitly synchronized");
      const exportData = JSON.parse(await page.inputValue("#export-output"));
      assert(exportData.imageInputs.filter((item) => item.fileName).length >= 2, "new2.har: export missing uploaded images");
      assert(
        exportData.imageInputs.some((item) => item.transform && item.transform.rotation === 15),
        "new2.har: image rotation was not exported"
      );
      const text01 = exportData.textInputs.find((item) => item.label === "Text 01");
      assert(text01 && text01.value.split(/\r?\n/).length === 6, "new2.har: multiline text was not clamped to maxLines");
      const movedImage = exportData.imageInputs.find(
        (item) => item.fileName && item.transform && item.transform.x < 0 && item.transform.y < 0
      );
      assert(Boolean(movedImage), "new2.har: dragged image transform was not saved");
    }

    assert(consoleProblems.length === 0, `${file}: console problems: ${consoleProblems.join(" | ")}`);
    assert(requestFailures.length === 0, `${file}: request failures: ${requestFailures.join(" | ")}`);
    assert(pageErrors.length === 0, `${file}: page errors: ${pageErrors.join(" | ")}`);
    results.push(data);
    await page.close();
  }

  for (const file of ["amazon.har", "new.har", "new2.har"]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    const consoleProblems = [];
    const requestFailures = [];
    const pageErrors = [];

    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type())) consoleProblems.push(`${message.type()}: ${message.text()}`);
    });
    page.on("requestfailed", (request) => {
      if (!request.url().includes("/favicon.ico")) {
        requestFailures.push(`${request.method()} ${request.url()} ${request.failure() && request.failure().errorText}`);
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await loadCustomizer(page, mainUrl(file));
    const labels = await controlLabels(page);
    assert(labels.length > 0, `${file} mobile: controls did not render`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(overflow <= 2, `${file} mobile: horizontal overflow ${overflow}px`);
    assert(consoleProblems.length === 0, `${file} mobile: console problems: ${consoleProblems.join(" | ")}`);
    assert(requestFailures.length === 0, `${file} mobile: request failures: ${requestFailures.join(" | ")}`);
    assert(pageErrors.length === 0, `${file} mobile: page errors: ${pageErrors.join(" | ")}`);
    results.push({ file: `${file}:mobile`, controls: labels.slice(0, 5), overflow });
    await page.close();
  }

  await browser.close();
  console.log(JSON.stringify(results, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
