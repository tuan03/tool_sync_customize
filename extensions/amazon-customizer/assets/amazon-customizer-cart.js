(function () {
  "use strict";

  let scheduled = false;
  let running = false;

  function escapeSelector(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function previewUrl(item) {
    const properties = item && item.properties;
    return properties && (properties._customization_preview || properties["Customization preview"] || "");
  }

  function replaceImage(row, url) {
    if (!row || !url) return;
    const image = row.querySelector(".cart-items__media-image, img");
    if (!image || image.dataset.amzcustomPreview === url) return;
    image.src = url;
    image.removeAttribute("srcset");
    image.removeAttribute("sizes");
    image.dataset.amzcustomPreview = url;
    image.alt = "Customized product preview";
    image.style.objectFit = "contain";
  }

  async function applyPreviews() {
    if (running) return;
    running = true;
    try {
      const response = await fetch(`${window.Shopify.routes.root}cart.js`, {
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      if (!response.ok) return;
      const cart = await response.json();
      for (const item of cart.items || []) {
        const url = previewUrl(item);
        if (!url) continue;
        const key = escapeSelector(item.key);
        document.querySelectorAll(`[data-key="${key}"], #CartItem-${key}`).forEach((row) => replaceImage(row, url));
      }
    } catch (error) {
      console.warn("Amazon customizer could not apply cart previews", error);
    } finally {
      running = false;
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(() => {
      scheduled = false;
      applyPreviews();
    }, 80);
  }

  document.addEventListener("DOMContentLoaded", schedule);
  window.addEventListener("pageshow", schedule);
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
})();
