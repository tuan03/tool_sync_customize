(function () {
  const elements = Object.fromEntries(["product-id", "admin-secret", "price-multiplier", "raw-json", "convert", "dry-run", "sync", "status", "summary", "normalized-json", "byte-count"].map((id) => [id, document.getElementById(id)]));
  let normalizedConfig = null;

  function status(message, error = false) {
    elements.status.textContent = message;
    elements.status.classList.toggle("error", error);
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
})();
