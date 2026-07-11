(function () {
  const elements = Object.fromEntries(["product-id", "admin-secret", "price-multiplier", "raw-json", "convert", "dry-run", "sync", "status", "summary", "normalized-json", "byte-count", "proxy-panel", "proxy-state", "proxy-url", "proxy-location", "proxy-shop", "amazon-product-url", "fetch-amazon-link", "open-amazon-link", "copy-console-code", "amazon-customization-url", "amazon-link-status"].map((id) => [id, document.getElementById(id)]));
  let normalizedConfig = null;
  const AMAZON_CONFIG_CONSOLE_CODE = `const element = [...document.querySelectorAll('script[type="a-state"]')]
  .find(item => item.outerHTML.includes('gc:app-config'));

const amazonConfig = JSON.parse(element.textContent);
copy(JSON.stringify(amazonConfig));`;

  function status(message, error = false) {
    elements.status.textContent = message;
    elements.status.classList.toggle("error", error);
  }
  function amazonLinkStatus(message, error = false) {
    elements["amazon-link-status"].textContent = message;
    elements["amazon-link-status"].classList.toggle("error", error);
  }
  async function post(url, payload) {
    const secret = elements["admin-secret"].value;
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(payload) });
    const json = await response.json();
    if (!response.ok || !json.ok) throw new Error(json.error || `HTTP ${response.status}`);
    return json;
  }
  function rawConfig() {
    try { return JSON.parse(elements["raw-json"].value); }
    catch (error) { throw new Error(`JSON không hợp lệ: ${error.message}`); }
  }
  function renderSummary(summary) {
    elements.summary.hidden = false;
    elements.summary.innerHTML = `<div class="summary-grid">
      <div class="metric"><span>ASIN</span><b>${summary.asin || "—"}</b></div>
      <div class="metric"><span>Controls</span><b>${summary.controls}</b></div>
      <div class="metric"><span>Assets</span><b>${summary.assets}</b></div>
      <div class="metric"><span>Phụ phí</span><b>${summary.surchargeAmounts.length}</b></div>
      <div class="metric"><span>Kích thước</span><b>${(summary.bytes / 1024).toFixed(1)} KB</b></div>
    </div>`;
  }
  async function fetchAmazonCustomizationLink() {
    const url = elements["amazon-product-url"].value.trim();
    if (!url) {
      amazonLinkStatus("Nhập Amazon product URL trước.", true);
      return;
    }
    elements["fetch-amazon-link"].disabled = true;
    elements["open-amazon-link"].disabled = true;
    amazonLinkStatus("Đang lấy link...");
    try {
      const response = await fetch("/api/amazon/product-info-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const json = await response.json();
      if (!response.ok || !json.ok) {
        const error = new Error(json.error || `HTTP ${response.status}`);
        error.response = json;
        throw error;
      }
      elements["amazon-customization-url"].value = json.customizationUrl || "";
      elements["open-amazon-link"].disabled = !json.customizationUrl;
      amazonLinkStatus("Đã lấy được link.");
    } catch (error) {
      elements["amazon-customization-url"].value = "";
      amazonLinkStatus(error.message, true);
    } finally {
      elements["fetch-amazon-link"].disabled = false;
    }
  }
  function openAmazonCustomizationLink() {
    const value = elements["amazon-customization-url"].value.trim();
    if (!value) return;
    window.open(value, "_blank", "noopener,noreferrer");
    amazonLinkStatus("Đã mở link.");
  }
  async function copyConsoleCode() {
    await navigator.clipboard.writeText(AMAZON_CONFIG_CONSOLE_CODE);
    amazonLinkStatus("Da copy console code.");
  }
  async function loadAdminStatus() {
    try {
      const response = await fetch("/api/admin/status", { headers: { accept: "application/json" } });
      const json = await response.json();
      if (!response.ok || !json.ok) throw new Error(json.error || `HTTP ${response.status}`);
      const proxy = json.proxy || {};
      elements["proxy-panel"].classList.toggle("is-on", Boolean(proxy.enabled && proxy.configured));
      elements["proxy-panel"].classList.toggle("is-off", Boolean(!proxy.enabled));
      elements["proxy-panel"].classList.toggle("is-error", Boolean(proxy.enabled && !proxy.configured));
      elements["proxy-state"].textContent = proxy.enabled
        ? proxy.configured
          ? "Đã bật và sẵn sàng"
          : "Đã bật nhưng lỗi cấu hình"
        : "Đang tắt";
      elements["proxy-url"].textContent = proxy.enabled
        ? `${proxy.url || "Chưa có URL"}${proxy.authConfigured ? " · có auth" : " · không auth"}`
        : "SHOPIFY_PROXY_ENABLED=0";
      if (proxy.enabled) {
        const location = proxy.location || {};
        const place = [location.city, location.region, location.country].filter(Boolean).join(", ");
        const network = [location.isp, location.org].filter(Boolean).join(" · ");
        elements["proxy-location"].textContent = location.error
          ? `IP ${location.ip || proxy.host || "-"} · không lấy được vị trí: ${location.error}`
          : location.ip
            ? `IP ${location.ip}${place ? ` · ${place}` : ""}${network ? ` · ${network}` : ""}`
            : "Chưa có IP proxy để kiểm tra vị trí";
      } else {
        elements["proxy-location"].textContent = "";
      }
      elements["proxy-shop"].textContent = [json.shop, json.apiVersion].filter(Boolean).join(" · ");
      if (proxy.error) elements["proxy-url"].textContent = proxy.error;
    } catch (error) {
      elements["proxy-panel"].classList.add("is-error");
      elements["proxy-state"].textContent = "Không đọc được trạng thái proxy";
      elements["proxy-url"].textContent = error.message;
      elements["proxy-location"].textContent = "";
      elements["proxy-shop"].textContent = "";
    }
  }
  elements["fetch-amazon-link"].addEventListener("click", fetchAmazonCustomizationLink);
  elements["open-amazon-link"].addEventListener("click", openAmazonCustomizationLink);
  elements["copy-console-code"].addEventListener("click", copyConsoleCode);
  elements.convert.addEventListener("click", async () => {
    try {
      status("Đang chuyển đổi…");
      const result = await post("/api/shopify/convert", { config: rawConfig() });
      normalizedConfig = result.config;
      elements["normalized-json"].value = JSON.stringify(result.config, null, 2);
      elements["byte-count"].textContent = `${result.summary.bytes.toLocaleString()} / 131,072 bytes`;
      elements["dry-run"].disabled = false;
      elements.sync.disabled = false;
      renderSummary(result.summary);
      status("Convert thành công. Hãy chạy Dry-run trước khi Sync.");
    } catch (error) { status(error.message, true); }
  });
  async function sync(apply) {
    const productId = elements["product-id"].value.trim();
    if (!productId) return status("Cần nhập Shopify Product ID.", true);
    if (apply && !confirm("Ghi metafield và upload assets lên Shopify ngay?")) return;
    try {
      status(apply ? "Đang Sync lên Shopify…" : "Đang kiểm tra dry-run…");
      elements.sync.disabled = elements["dry-run"].disabled = true;
      const priceMultiplier = elements["price-multiplier"].value ? Number(elements["price-multiplier"].value) : null;
      const result = await post("/api/shopify/sync", { productId, normalizedConfig, priceMultiplier, apply });
      status(`${apply ? "Sync" : "Dry-run"} thành công cho ${result.product.title}; ${result.bytes.toLocaleString()} bytes.`);
      console.log(result);
    } catch (error) { status(error.message, true); }
    finally { elements.sync.disabled = elements["dry-run"].disabled = false; }
  }
  elements["dry-run"].addEventListener("click", () => sync(false));
  elements.sync.addEventListener("click", () => sync(true));
  loadAdminStatus();
})();
