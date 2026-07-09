(function () {
  "use strict";

  let scheduled = false;
  let running = false;
  let updatingCart = false;
  let cartDataCache = null;
  let inFlightCartFetch = null;
  let cartObserver = null;

  const ROW_SELECTOR = 'tr, .cart-item, .cart-row, [data-cart-item]';
  const CART_ROOT_SELECTOR = 'form[action*="/cart"], .cart-items, [data-cart-items], .cart-drawer, .ajaxcart, .cart-popup';
  const JSON_HEADERS = { accept: "application/json" };
  const JSON_POST_HEADERS = { "content-type": "application/json", accept: "application/json" };
  const ZERO_DECIMAL_CURRENCIES = ["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"];
  const PRICE_SELECTORS = [
    ".cart-item__price",
    ".price",
    ".price--end",
    ".cart-item__discounted-prices",
    "[data-cart-item-price]",
    ".cart-item__totals",
    ".totals__total-line-price",
    "[data-cart-item-line-price]",
    ".cart-product-price",
    ".cart-item-price",
    ".line-price",
    ".total-price",
    ".cart-item-total",
  ].join(",");

  const style = document.createElement("style");
  style.textContent = `
    tr:has(a[href*="amazon-customization-addon"]),
    .cart-item:has(a[href*="amazon-customization-addon"]),
    .cart-row:has(a[href*="amazon-customization-addon"]),
    [data-cart-item]:has(a[href*="amazon-customization-addon"]),
    .cart-items td:has(a[href*="amazon-customization-addon"]) {
      display: none !important;
    }
  `;
  document.head.appendChild(style);

  const originalFetch = window.fetch.bind(window);

  function cartRoot() {
    return window.Shopify && window.Shopify.routes && window.Shopify.routes.root || "/";
  }

  function activeCurrency() {
    return window.Shopify && window.Shopify.currency && window.Shopify.currency.active || "USD";
  }

  function moneyFormat() {
    return window.Shopify && window.Shopify.theme && window.Shopify.theme.money_format || window.Shopify && window.Shopify.money_format || window.theme && window.theme.moneyFormat || "${{amount}}";
  }

  // Price + preview rendering
  function previewUrl(item) {
    const properties = item && item.properties;
    return properties && (properties._customization_preview || properties["Customization preview"] || "");
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

  function formatMoney(value, format) {
    const currency = activeCurrency();
    const isZeroDecimal = ZERO_DECIMAL_CURRENCIES.includes(currency);
    const formatString = format || "${{amount}}";
    const placeholderRegex = /\{\{\s*(\w+)\s*\}\}/;
    const numeric = isZeroDecimal ? value : value / 100;
    const placeholder = formatString.match(placeholderRegex) && formatString.match(placeholderRegex)[1] || "amount";
    let formatted = placeholder.includes("no_decimals") ? numeric.toFixed(0) : numeric.toFixed(2);

    if (placeholder.includes("with_comma_separator")) formatted = formatted.replace(/\./g, ",");
    else if (placeholder.includes("with_space_separator")) formatted = formatted.replace(/\./g, " ");
    else if (placeholder.includes("with_apostrophe_separator")) formatted = formatted.replace(/\./g, "'");

    return formatString.replace(placeholderRegex, formatted);
  }

  function updatePriceElement(element, originalCents, combinedCents, format, isZeroDecimal) {
    if (!element) return;
    if (element.children.length > 0) {
      for (const child of element.children) updatePriceElement(child, originalCents, combinedCents, format, isZeroDecimal);
      return;
    }

    const text = (element.textContent || "").trim();
    if (!text) return;

    const clean = text.replace(/\s/g, "");
    const match = clean.match(/[0-9]+(?:[.,][0-9]+)?/);
    if (!match) return;

    const numStr = match[0];
    let parsedValue;
    if (isZeroDecimal) {
      parsedValue = parseFloat(numStr.replace(/[.,]/g, ""));
    } else {
      let normalized = numStr;
      if (normalized.includes(",") && !normalized.includes(".")) {
        const parts = normalized.split(",");
        normalized = parts[parts.length - 1].length <= 2 ? normalized.replace(",", ".") : normalized.replace(",", "");
      } else {
        normalized = normalized.replace(/,/g, "");
      }
      parsedValue = parseFloat(normalized);
    }
    if (!Number.isFinite(parsedValue)) return;

    const parsedCents = isZeroDecimal ? parsedValue : Math.round(parsedValue * 100);
    const storedOriginal = element.getAttribute("data-amzcustom-original-price");
    const actualOriginalCents = storedOriginal ? parseInt(storedOriginal, 10) : originalCents;
    const tolerance = 5;

    if (Math.abs(parsedCents - actualOriginalCents) > tolerance && parsedCents !== combinedCents) return;

    element.setAttribute("data-amzcustom-original-price", String(actualOriginalCents));
    element.setAttribute("data-amzcustom-combined-price", String(combinedCents));

    const newPriceStr = formatMoney(combinedCents, format);
    if (text.length <= numStr.length + 4) {
      element.textContent = newPriceStr;
    } else {
      element.textContent = text.replace(numStr, newPriceStr.replace(/[^0-9.,]/g, ""));
    }
  }

  function findPriceElements(row) {
    const elements = new Set();
    row.querySelectorAll(PRICE_SELECTORS).forEach((element) => elements.add(element));
    row.querySelectorAll("*").forEach((element) => {
      const className = element.className || "";
      if (typeof className === "string" && /price|total|money|amount/i.test(className)) elements.add(element);
      const text = element.textContent || "";
      if (/[$\u20AB\u00A3\u20AC\u00A5]|\bVND\b|\bUSD\b/i.test(text) && element.children.length <= 3 && text.length < 30) {
        elements.add(element);
      }
    });
    return Array.from(elements);
  }

  // DOM row matching
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

  function cachedPreviewUrl(row) {
    const variantId = getVariantIdFromRow(row);
    if (!variantId) return "";
    try {
      return localStorage.getItem("amzcustom_preview_" + variantId) || "";
    } catch (error) {
      return "";
    }
  }

  function hideAddonRow(row) {
    row.style.setProperty("display", "none", "important");
    row.classList.add("amzcustom-addon-hidden");
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

  function isAddonItem(item) {
    return Boolean(item && item.properties && item.properties._customization_fee_component);
  }

  function isMainCustomizedItem(item) {
    return Boolean(item && item.properties && item.properties._customization_id && !item.properties._customization_fee_component);
  }

  function customizationIdOf(item) {
    return item && item.properties && item.properties._customization_id || "";
  }

  function addonAmountOf(item) {
    return item && item.properties && item.properties._customization_fee_component || "";
  }

  function groupAddonsByCustomization(cartItems) {
    const groups = new Map();
    for (const item of cartItems || []) {
      const customizationId = customizationIdOf(item);
      if (!customizationId) continue;
      if (!groups.has(customizationId)) groups.set(customizationId, { main: null, addons: [] });
      const group = groups.get(customizationId);
      if (isAddonItem(item)) group.addons.push(item);
      else if (isMainCustomizedItem(item)) group.main = item;
    }
    return groups;
  }

  function findMainItemInUpdates(cartItems, key) {
    return cartItems.find((item) => {
      return isMainCustomizedItem(item) && (item.key === key || String(item.id) === String(key) || String(item.variant_id) === String(key));
    }) || null;
  }

  // Cart data + synchronization
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
        const response = await originalFetch(`${cartRoot()}cart.js`, {
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

  async function postCartUpdate(updates) {
    return originalFetch(`${cartRoot()}cart/update.js`, {
      method: "POST",
      headers: JSON_POST_HEADERS,
      body: JSON.stringify({ updates }),
      credentials: "same-origin",
    });
  }

  function buildQuantitySyncUpdates(cartItems) {
    const updates = {};
    const groups = groupAddonsByCustomization(cartItems);

    for (const group of groups.values()) {
      if (!group.main) {
        for (const addon of group.addons) {
          if (addon.quantity > 0) updates[addon.key] = 0;
        }
        continue;
      }

      for (const addon of group.addons) {
        if (addon.quantity !== group.main.quantity) updates[addon.key] = group.main.quantity;
      }
    }

    return updates;
  }

  function applyQuantityToAddonGroup(group, quantity, updates) {
    updates[group.main.key] = quantity;
    for (const addon of group.addons) updates[addon.key] = quantity;
  }

  async function syncAddonQuantities(cartItems) {
    if (updatingCart) return false;

    const updates = buildQuantitySyncUpdates(cartItems);
    if (!Object.keys(updates).length) return false;

    updatingCart = true;
    try {
      const response = await postCartUpdate(updates);
      if (!response.ok) return false;
      cartDataCache = null;
      return true;
    } catch (error) {
      console.warn("Amazon customizer could not sync surcharge quantities", error);
      return false;
    } finally {
      updatingCart = false;
    }
  }

  function applyRowPrice(row, mainItem, addons) {
    if (!addons.length) return;

    const currency = activeCurrency();
    const isZeroDecimal = ZERO_DECIMAL_CURRENCIES.includes(currency);
    const format = moneyFormat();

    const mainUnitPrice = mainItem.final_price || mainItem.price || 0;
    const mainLinePrice = mainItem.final_line_price || mainItem.line_price || 0;
    const addonUnitPriceSum = addons.reduce((sum, addon) => sum + (addon.final_price || addon.price || 0), 0);
    const addonLinePriceSum = addons.reduce((sum, addon) => sum + (addon.final_line_price || addon.line_price || 0), 0);
    const combinedUnitPrice = mainUnitPrice + addonUnitPriceSum;
    const combinedLinePrice = mainLinePrice + addonLinePriceSum;

    findPriceElements(row).forEach((element) => {
      const className = `${element.className || ""} ${element.parentElement && element.parentElement.className || ""}`;
      const isLinePrice = /total|line|subtotal/i.test(className) || mainItem.quantity > 1;
      updatePriceElement(element, isLinePrice ? mainLinePrice : mainUnitPrice, isLinePrice ? combinedLinePrice : combinedUnitPrice, format, isZeroDecimal);
    });
  }

  // Main cart page/cart drawer decoration pass
  async function applyCartDecorations() {
    if (running) return;
    running = true;

    try {
      let cart = await getCartData();
      if (!cart || !Array.isArray(cart.items)) return;

      if (await syncAddonQuantities(cart.items)) {
        if (/\/cart(?:$|[/?#])/.test(window.location.pathname)) {
          window.location.reload();
          return;
        }
        cart = await getCartData();
        if (!cart || !Array.isArray(cart.items)) return;
        schedule();
      }

      const groups = groupAddonsByCustomization(cart.items);

      document.querySelectorAll(ROW_SELECTOR).forEach((row) => {
        const item = matchCartItem(row, cart.items);
        if (!item) return;

        if (isAddonItem(item)) {
          hideAddonRow(row);
          return;
        }

        const url = previewUrl(item) || cachedPreviewUrl(row);
        if (url) replaceImage(row, url);

        const customizationId = customizationIdOf(item);
        const addons = customizationId && groups.get(customizationId) ? groups.get(customizationId).addons : [];
        if (isMainCustomizedItem(item) && addons && addons.length) applyRowPrice(row, item, addons);

        row.classList.add("amzcustom-processed");
      });
    } catch (error) {
      console.warn("Amazon customizer could not apply cart previews", error);
    } finally {
      running = false;
    }
  }

  // Cart request interception for quantity sync
  function parseRequestBody(body) {
    if (!body) return null;
    if (typeof body === "string") {
      try {
        return { data: JSON.parse(body), isJson: true };
      } catch (error) {
        return { data: Object.fromEntries(new URLSearchParams(body)), isJson: false };
      }
    }
    if (body instanceof FormData) return { data: Object.fromEntries(body.entries()), isJson: false };
    return null;
  }

  function findMainItemForChange(cartItems, idOrLine) {
    if (idOrLine === undefined || idOrLine === null) return null;
    const raw = String(idOrLine);

    if (/^\d+$/.test(raw)) {
      const lineIndex = parseInt(raw, 10) - 1;
      if (lineIndex >= 0 && lineIndex < cartItems.length && isMainCustomizedItem(cartItems[lineIndex])) return cartItems[lineIndex];
    }

    return cartItems.find((item) => isMainCustomizedItem(item) && (item.key === raw || String(item.id) === raw || String(item.variant_id) === raw)) || null;
  }

  async function augmentCartMutation(url, init) {
    const parsed = parseRequestBody(init && init.body);
    if (!parsed || !parsed.data) return null;

    const cart = await getCartData();
    if (!cart || !Array.isArray(cart.items)) return null;

    const updates = {};
    if (url.includes("/cart/change")) {
      const mainItem = findMainItemForChange(cart.items, parsed.data.id || parsed.data.line);
      const quantity = parseInt(parsed.data.quantity, 10);
      if (!mainItem || !Number.isFinite(quantity)) return null;
      const group = groupAddonsByCustomization(cart.items).get(customizationIdOf(mainItem));
      if (!group || !group.addons.length) return null;
      applyQuantityToAddonGroup(group, quantity, updates);
    } else if (url.includes("/cart/update") && parsed.data.updates) {
      const groups = groupAddonsByCustomization(cart.items);
      for (const [key, value] of Object.entries(parsed.data.updates)) {
        const mainItem = findMainItemInUpdates(cart.items, key);
        if (!mainItem) continue;
        const quantity = parseInt(value, 10);
        if (!Number.isFinite(quantity)) continue;
        const group = groups.get(customizationIdOf(mainItem));
        if (!group || !group.addons.length) continue;
        applyQuantityToAddonGroup(group, quantity, updates);
      }
      if (!Object.keys(updates).length) return null;
    } else {
      return null;
    }

    const nextInit = { ...init };
    const nextBody = { updates: { ...(parsed.data.updates || {}), ...updates } };
    if (parsed.data.sections) nextBody.sections = parsed.data.sections;
    if (parsed.data.sections_url) nextBody.sections_url = parsed.data.sections_url;
    nextInit.headers = { ...(nextInit.headers || {}), "content-type": "application/json", accept: "application/json" };
    nextInit.body = JSON.stringify(nextBody);
    return { url: `${cartRoot()}cart/update.js`, init: nextInit };
  }

  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
    const method = init && init.method ? String(init.method).toUpperCase() : "GET";

    if (url && method === "POST" && (url.includes("/cart/change") || url.includes("/cart/update"))) {
      try {
        const augmented = await augmentCartMutation(url, init || {});
        if (augmented) {
          cartDataCache = null;
          const response = await originalFetch(augmented.url, augmented.init);
          cartDataCache = null;
          schedule();
          return response;
        }
      } catch (error) {
        console.warn("Amazon customizer could not augment cart mutation", error);
      }
    }

    const response = await originalFetch(input, init);
    if (url && response && response.ok && (url.includes("/cart") || url.includes("cart.js"))) {
      cartDataCache = null;
      schedule();
    }
    return response;
  };

  // Scheduling + rerender hooks
  function schedule() {
    applyInstantPreviews();
    if (!document.querySelector(CART_ROOT_SELECTOR) || scheduled) return;

    scheduled = true;
    window.setTimeout(() => {
      scheduled = false;
      cartDataCache = null;
      applyCartDecorations();
    }, 80);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", applyInstantPreviews);
  else applyInstantPreviews();

  document.addEventListener("DOMContentLoaded", schedule);
  window.addEventListener("pageshow", schedule);

  cartObserver = new MutationObserver(() => {
    schedule();
  });
  cartObserver.observe(document.documentElement, { childList: true, subtree: true });

  const originalPushState = history.pushState;
  history.pushState = function () {
    const result = originalPushState.apply(this, arguments);
    schedule();
    return result;
  };

  window.addEventListener("popstate", schedule);
})();
