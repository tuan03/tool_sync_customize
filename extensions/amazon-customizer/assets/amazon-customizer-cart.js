(function () {
  "use strict";

  const ROW_SELECTOR = "tr, .cart-item, .cart-row, [data-cart-item]";
  const CART_ROOT_SELECTOR = 'form[action*="/cart"], .cart-items, [data-cart-items], .cart-drawer, .ajaxcart, .cart-popup';
  const JSON_HEADERS = { accept: "application/json" };

  let scheduled = false;
  let running = false;
  let cartDataCache = null;
  let inFlightCartFetch = null;

  function cartRoot() {
    return window.Shopify && window.Shopify.routes && window.Shopify.routes.root || "/";
  }

  function getVariantIdFromRow(row) {
    const key = row.getAttribute("data-key") || row.getAttribute("data-cart-item-key") || "";
    if (key) {
      const variantId = key.split(":")[0];
      if (/^\d{8,}$/.test(variantId)) return variantId;
    }

    const links = row.querySelectorAll('a[href*="variant="]');
    for (const link of links) {
      const href = link.getAttribute("href");
      const match = href && href.match(/variant=(\d{8,})/);
      if (match) return match[1];
    }

    const variantEl = row.querySelector("[data-variant-id], [data-item-variant-id]");
    if (variantEl) {
      const variantId = variantEl.getAttribute("data-variant-id") || variantEl.getAttribute("data-item-variant-id");
      if (variantId && /^\d{8,}$/.test(variantId)) return variantId;
    }

    return null;
  }

  function getLineIndexFromRow(row, cartItems) {
    const id = row.getAttribute("id") || "";
    const idMatch = id.match(/(?:CartItem|CartDrawer-Item|Cart-Item)-(\d+)/i);
    if (idMatch) {
      const index = parseInt(idMatch[1], 10) - 1;
      if (index >= 0 && index < cartItems.length) return index;
    }

    const lineEl = row.querySelector('[href*="line="], input[name="updates[]"], cart-remove-button a');
    if (!lineEl) return null;

    const href = lineEl.getAttribute("href") || "";
    const lineMatch = href.match(/line=(\d+)/);
    if (lineMatch) {
      const index = parseInt(lineMatch[1], 10) - 1;
      if (index >= 0 && index < cartItems.length) return index;
    }

    const inputId = lineEl.getAttribute("id") || "";
    const inputMatch = inputId.match(/(?:Quantity|updates|Remove)-(\d+)/i);
    if (!inputMatch) return null;
    const index = parseInt(inputMatch[1], 10) - 1;
    return index >= 0 && index < cartItems.length ? index : null;
  }

  function matchCartItemByKey(row, cartItems) {
    const key = row.getAttribute("data-key") || row.getAttribute("data-cart-item-key");
    if (!key) return null;
    return cartItems.find((item) => item.key === key) || null;
  }

  function matchCartItemByVariant(row, cartItems) {
    const variantId = getVariantIdFromRow(row);
    if (!variantId) return null;
    const matches = cartItems.filter((item) => String(item.variant_id) === String(variantId) || String(item.id) === String(variantId));
    return matches.length === 1 ? matches[0] : null;
  }

  function matchCartItem(row, cartItems) {
    const lineIndex = getLineIndexFromRow(row, cartItems);
    if (lineIndex !== null) return cartItems[lineIndex];
    return matchCartItemByKey(row, cartItems) || matchCartItemByVariant(row, cartItems);
  }

  function isMainCustomizedItem(item) {
    return Boolean(item && item.properties && item.properties._customization_id && !item.properties._customization_fee_component);
  }

  function previewUrl(item) {
    const properties = item && item.properties;
    return properties && (properties._customization_preview || properties["Customization preview"] || "");
  }

  function cachedPreviewUrl(row) {
    const variantId = getVariantIdFromRow(row);
    if (!variantId) return "";
    try {
      return localStorage.getItem("amzcustom_preview_" + variantId) || "";
    } catch {
      return "";
    }
  }

  function replaceImage(row, url) {
    if (!row || !url) return;
    const image = row.querySelector(".cart-items__media-image, img");
    if (!image || image.dataset.amzcustomPreview === url) return;
    if (!image.dataset.amzcustomOriginalSrc) {
      image.dataset.amzcustomOriginalSrc = image.src || "";
      image.dataset.amzcustomOriginalAlt = image.alt || "";
    }
    image.src = url;
    image.removeAttribute("srcset");
    image.removeAttribute("sizes");
    image.dataset.amzcustomPreview = url;
    image.alt = "Customized product preview";
    image.style.objectFit = "contain";
  }

  function applyInstantPreviews() {
    document.querySelectorAll(ROW_SELECTOR).forEach((row) => {
      const url = cachedPreviewUrl(row);
      if (url) replaceImage(row, url);
    });
  }

  async function getCartData() {
    if (cartDataCache) return cartDataCache;
    if (inFlightCartFetch) return inFlightCartFetch;

    inFlightCartFetch = (async () => {
      try {
        const response = await fetch(`${cartRoot()}cart.js`, {
          headers: JSON_HEADERS,
          credentials: "same-origin",
        });
        if (!response.ok) return null;
        cartDataCache = await response.json();
        window.setTimeout(() => {
          cartDataCache = null;
        }, 1500);
        return cartDataCache;
      } catch (error) {
        console.warn("Amazon customizer could not load cart data", error);
        return null;
      } finally {
        inFlightCartFetch = null;
      }
    })();

    return inFlightCartFetch;
  }

  async function applyCartPreviews() {
    if (running) return;
    running = true;

    try {
      const cart = await getCartData();
      if (!cart || !Array.isArray(cart.items)) return;

      document.querySelectorAll(ROW_SELECTOR).forEach((row) => {
        const item = matchCartItem(row, cart.items);
        if (!item || !isMainCustomizedItem(item)) return;
        const url = previewUrl(item) || cachedPreviewUrl(row);
        if (url) replaceImage(row, url);
        row.classList.add("amzcustom-processed");
      });
    } catch (error) {
      console.warn("Amazon customizer could not apply cart previews", error);
    } finally {
      running = false;
    }
  }

  function schedule() {
    applyInstantPreviews();
    if (!document.querySelector(CART_ROOT_SELECTOR) || scheduled) return;

    scheduled = true;
    window.setTimeout(() => {
      scheduled = false;
      cartDataCache = null;
      applyCartPreviews();
    }, 80);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", applyInstantPreviews);
  else applyInstantPreviews();

  document.addEventListener("DOMContentLoaded", schedule);
  window.addEventListener("pageshow", schedule);
  window.addEventListener("popstate", schedule);

  const originalPushState = history.pushState;
  history.pushState = function () {
    const result = originalPushState.apply(this, arguments);
    schedule();
    return result;
  };

  const observer = new MutationObserver(() => {
    schedule();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
