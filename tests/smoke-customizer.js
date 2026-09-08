const fs = require("fs");
const path = require("path");
const os = require("os");
const SMOKE_BASE_URL = process.env.CUSTOMIZER_SMOKE_URL || "http://localhost:3000";

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
  await page.goto(`${SMOKE_BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await page.fill("#custom-url", url);
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/custom-form") && response.request().method() === "POST"),
    page.click("#load-form button"),
  ]);
  await page.waitForSelector("#workspace:not(.is-empty)", { timeout: 15000 });
}

async function controlLabels(page) {
  return page.$$eval("#controls .control-title h3", (items) => items.map((item) => item.textContent.trim().replace(/\s*\(optional\)\s*$/, "").replace(/:\s.*$/, "")));
}

async function selectedValue(page, title) {
  const group = controlGroup(page, title);
  const select = group.locator("select");
  if (await select.count()) return select.inputValue();
  const card = group.locator(".option-card.is-selected .option-name");
  return (await card.count()) ? (await card.first().textContent()).trim() : "";
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function controlGroup(page, title) {
  return page.locator(".control-group").filter({ has: page.locator(".control-title h3").filter({ hasText: title }) });
}

function unexpectedConsoleProblems(items) {
  return items.filter((item) => !item.includes("Failed to load resource: the server responded with a status of 400"));
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
    const httpProblems = [];
    const requestFailures = [];
    const pageErrors = [];

    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type())) consoleProblems.push(`${message.type()}: ${message.text()}`);
    });
    page.on("requestfailed", (request) => {
      if (!request.url().includes("/favicon.ico") && !request.url().includes("/api/asset?")) {
        requestFailures.push(`${request.method()} ${request.url()} ${request.failure() && request.failure().errorText}`);
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400 && !response.url().includes("favicon.ico")) httpProblems.push(`${response.status()} ${response.url()}`);
    });

    await loadCustomizer(page, mainUrl(file));
    const status = await page.textContent("#status");
    const warningCount = await page.$$eval("#warnings .warning", (items) => items.length);
    assert(status === "Customizer loaded.", `${file}: customizer did not load`);
    assert(warningCount === 0, `${file}: visible warnings found`);

    const data = { file, controls: await controlLabels(page), price: await page.textContent("#price-delta") };

    if (file === "amazon.har") {
      const personalizedOptionCards = await controlGroup(page, "Choose Personalized Option").locator(".option-card").count();
      assert(personalizedOptionCards === 2, `amazon.har: personalized option should render as clickable cards (found ${personalizedOptionCards}; controls: ${data.controls.join(", ")})`);
      assert((await controlGroup(page, "CONFIRMATION PRODUCT").locator(".option-card").count()) === 2, "amazon.har: non-dropdown text options should render as clickable cards");
      assert((await controlGroup(page, "CONFIRMATION PRODUCT").locator("select").count()) === 0, "amazon.har: confirmation should not render as select");
      await controlGroup(page, "Choose Personalized Option").locator(".option-card").nth(1).click();
      await page.waitForTimeout(250);
      const labels = await controlLabels(page);
      assert(labels.includes("Font"), `amazon.har: Font did not appear after Custom Name (controls: ${labels.join(", ")})`);
      assert(!labels.includes("Text Color"), "amazon.har: fixed Text Color should be hidden");
      assert(labels.includes("Custom Name"), "amazon.har: Custom Name input did not appear");
      assert((await page.$$eval(".font-dropdown", (items) => items.length)) >= 1, "amazon.har: font picker missing");
      assert((await page.$$eval(".font-choice", (items) => items.length)) >= 12, "amazon.har: visible font choices missing");
      assert((await page.$$eval('link[href*="fonts.googleapis"]', (items) => items.length)) === 0, "amazon.har: should use HAR font assets, not Google Fonts");
      await controlGroup(page, "Custom Name").locator('input[type="text"]').fill("ABCDEFGHIJKLMNOPQRST");
      await page.waitForTimeout(150);
      const customNameFontSize = await page.$eval(".placement-layer", (item) => Number(getComputedStyle(item).fontSize.replace("px", "")));
      assert(customNameFontSize < 18, "amazon.har: long custom text did not auto-fit inside placement");
      data.afterCustomName = labels;
    }

    if (file === "new.har") {
      assert((await controlGroup(page, "Message Windows").locator(".option-card").count()) === 2, "new.har: Message Windows should render as Yes/No cards");
      assert((await controlGroup(page, "Choose Item Size").locator(".option-card").count()) === 5, "new.har: Choose Item Size should render as text cards");
      assert((await selectedValue(page, "Message Windows")) !== "", "new.har: required Message Windows has no default");
      assert(["", "No selection"].includes(await selectedValue(page, "Would You Like to Purchase a Matching Tapestry?")), "new.har: optional paid tapestry should not default to a paid option");
      await controlGroup(page, "Message Windows").locator(".option-card").filter({ hasText: "YES" }).click();
      await page.waitForTimeout(250);
      const labels = await controlLabels(page);
      assert(labels.includes("Message Sender's Name"), "new.har: sender name did not appear after YES");
      assert(labels.includes("Custom Message Text"), "new.har: custom message did not appear after YES");
      assert(!labels.includes("Colors"), "new.har: fixed single color controls should be hidden");
      assert((await page.$$eval(".font-dropdown", (items) => items.length)) >= 1, "new.har: font picker missing");
      assert((await page.$$eval(".font-choice", (items) => items.length)) >= 1, "new.har: visible font choice missing");
      assert((await page.$$eval('link[href*="fonts.googleapis"]', (items) => items.length)) === 0, "new.har: should use HAR font assets, not Google Fonts");
      const defaultPriceDelta = await page.textContent("#price-delta");
      assert(["+0.00", "+$0.00"].includes(defaultPriceDelta), `new.har: optional paid field changed default price (${defaultPriceDelta})`);
      await page.setInputFiles("input[type=file]", UPLOAD_FIXTURE);
      await page.waitForTimeout(350);
      assert((await page.$$eval(".placement-layer img.inner-image", (items) => items.length)) >= 1, "new.har: upload preview missing");
      assert((await page.$$eval(".zoom-control", (items) => items.length)) >= 1, "new.har: upload zoom missing");
      data.afterMessageYes = labels;
    }

    if (file === "new2.har") {
      const colorGroup = controlGroup(page, "Color");
      const colorCards = await colorGroup.locator(".option-card").count();
      assert(colorCards === 10, `new2.har: collapsed Color group should show 10 cards (found ${colorCards})`);
      await colorGroup.locator(".option-toggle").click();
      assert((await controlGroup(page, "Color").locator(".option-card,.option-row").count()) === 30, "new2.har: expanded Color group should expose all 30 choices");
      assert((await selectedValue(page, "Design optimization (HD images or background removal)")) !== "", "new2.har: optional no-cost default missing");
      assert((await page.$$eval(".swatch", (items) => items.length)) >= 16, "new2.har: multi-color swatches missing");
      assert((await page.$$eval(".font-dropdown", (items) => items.length)) >= 1, "new2.har: font picker missing");
      assert((await page.$$eval(".font-choice", (items) => items.length)) >= 20, "new2.har: visible font choices missing");
      assert((await page.$$eval('link[href*="fonts.googleapis"]', (items) => items.length)) === 0, "new2.har: should use HAR font assets, not Google Fonts");
      const uploaders = page.locator("input[type=file]");
      await uploaders.nth(0).setInputFiles(UPLOAD_FIXTURE);
      await uploaders.nth(1).setInputFiles(UPLOAD_FIXTURE);
      await page
        .locator('.control-group')
        .filter({ has: page.locator('.control-title h3').filter({ hasText: 'Your Image 02' }) })
        .locator('input[type="range"]')
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
        .locator('.control-group')
        .filter({ has: page.locator('.control-title h3').filter({ hasText: 'Text 01' }) })
        .locator('textarea')
        .fill(["ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT"].join("\n"));
      await controlGroup(page, "Text 02").locator("textarea").fill("WORLD");
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

    const unexpectedConsole = unexpectedConsoleProblems(consoleProblems);
    assert(unexpectedConsole.length === 0, `${file}: console problems: ${unexpectedConsole.join(" | ")}; responses: ${httpProblems.join(" | ")}`);
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
      if (!request.url().includes("/favicon.ico") && !request.url().includes("/api/asset?")) {
        requestFailures.push(`${request.method()} ${request.url()} ${request.failure() && request.failure().errorText}`);
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await loadCustomizer(page, mainUrl(file));
    const labels = await controlLabels(page);
    assert(labels.length > 0, `${file} mobile: controls did not render`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(overflow <= 2, `${file} mobile: horizontal overflow ${overflow}px`);
    const unexpectedConsole = unexpectedConsoleProblems(consoleProblems);
    assert(unexpectedConsole.length === 0, `${file} mobile: console problems: ${unexpectedConsole.join(" | ")}`);
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
