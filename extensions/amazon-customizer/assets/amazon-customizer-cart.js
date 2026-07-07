(function () {
  "use strict";

  let scheduled = false;
  let running = false;
  let updatingCart = false;
  let cartDataCache = null;

  // 1. Immediately inject CSS to hide customization addon rows instantly
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

  const ZERO_DECIMAL_CURRENCIES = ["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"];
  const PRICE_SELECTORS = [
    '.cart-item__price',
    '.price',
    '.price--end',
    '.cart-item__discounted-prices',
    '[data-cart-item-price]',
    '.cart-item__totals',
    '.totals__total-line-price',
    '[data-cart-item-line-price]',
    '.cart-product-price',
    '.cart-item-price',
    '.line-price',
    '.total-price',
    '.cart-item-total'
  ].join(',');

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
    const currency = window.Shopify?.currency?.active || "USD";
    const isZeroDecimal = ZERO_DECIMAL_CURRENCIES.includes(currency);
    let formatString = format || "${{amount}}";
    let placeholderRegex = /\{\{\s*(\w+)\s*\}\}/;
    let numeric = isZeroDecimal ? value : value / 100;
    let formatted = "";

    function floatToString(num, decimals) {
      let str = num.toFixed(decimals).toString();
      if (str.match(/^\.\d+/)) return "0" + str;
      return str;
    }

    const placeholder = formatString.match(placeholderRegex)?.[1] || "amount";
    if (placeholder.includes("no_decimals")) {
      formatted = floatToString(numeric, 0);
    } else {
      formatted = floatToString(numeric, 2);
    }

    if (placeholder.includes("with_comma_separator")) {
      formatted = formatted.replace(/\./g, ",");
    } else if (placeholder.includes("with_space_separator")) {
      formatted = formatted.replace(/\./g, " ");
    } else if (placeholder.includes("with_apostrophe_separator")) {
      formatted = formatted.replace(/\./g, "'");
    }

    return formatString.replace(placeholderRegex, formatted);
  }

  function updatePriceElement(element, originalCents, combinedCents, format, isZeroDecimal) {
    if (element.children.length > 0) {
      for (const child of element.children) {
        updatePriceElement(child, originalCents, combinedCents, format, isZeroDecimal);
      }
      return;
    }

    const currentCombinedAttr = element.getAttribute("data-amzcustom-combined-price");
    if (currentCombinedAttr && parseInt(currentCombinedAttr, 10) === combinedCents) {
      return;
    }

    const text = element.textContent.trim();
    if (!text) return;

    let clean = text.replace(/\s/g, "");
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
        if (parts[parts.length - 1].length <= 2) {
          normalized = normalized.replace(",", ".");
        } else {
          normalized = normalized.replace(",", "");
        }
      } else {
        normalized = normalized.replace(/,/g, "");
      }
      parsedValue = parseFloat(normalized);
    }

    if (isNaN(parsedValue)) return;

    const parsedCents = isZeroDecimal ? parsedValue : Math.round(parsedValue * 100);
    const storedOriginal = element.getAttribute("data-amzcustom-original-price");
    const actualOriginalCents = storedOriginal ? parseInt(storedOriginal, 10) : originalCents;
    const tolerance = isZeroDecimal ? 5 : 5;

    if (Math.abs(parsedCents - actualOriginalCents) <= tolerance || parsedCents === combinedCents) {
      const newPriceStr = formatMoney(combinedCents, format);
      element.setAttribute("data-amzcustom-original-price", String(actualOriginalCents));
      element.setAttribute("data-amzcustom-combined-price", String(combinedCents));
      
      if (parsedCents !== combinedCents) {
        if (text.length <= numStr.length + 4) {
          element.textContent = newPriceStr;
        } else {
          element.textContent = text.replace(numStr, formatMoney(combinedCents, format).replace(/[^0-9.,]/g, ""));
        }
      }
    }
  }

  function getVariantIdFromRow(row) {
    const key = row.getAttribute('data-key') || row.getAttribute('data-cart-item-key') || '';
    if (key) {
      const variantId = key.split(':')[0];
      if (/^\d{8,}$/.test(variantId)) return variantId;
    }
    
    const links = row.querySelectorAll('a[href*="variant="]');
    for (const link of links) {
      const href = link.getAttribute('href');
      const match = href.match(/variant=(\d{8,})/);
      if (match) return match[1];
    }

    const variantEl = row.querySelector('[data-variant-id], [data-item-variant-id]');
    if (variantEl) {
      const variantId = variantEl.getAttribute('data-variant-id') || variantEl.getAttribute('data-item-variant-id');
      if (variantId && /^\d{8,}$/.test(variantId)) return variantId;
    }
    
    const removeBtn = row.querySelector('cart-remove-button, .cart-remove, a[href*="/cart/change?line="]');
    if (removeBtn) {
      const href = removeBtn.getAttribute('href') || '';
      const idMatch = href.match(/id=(\d{8,})/) || removeBtn.getAttribute('id')?.match(/Remove-(\d{8,})/);
      if (idMatch) return idMatch[1];
    }

    return null;
  }

  function getLineIndexFromRow(row, cartItems) {
    const id = row.getAttribute('id') || '';
    const idMatch = id.match(/(?:CartItem|CartDrawer-Item|Cart-Item)-(\d+)/i);
    if (idMatch) {
      const index = parseInt(idMatch[1]) - 1;
      if (index >= 0 && index < cartItems.length) return index;
    }

    const lineEl = row.querySelector('[href*="line="], input[name="updates[]"], cart-remove-button a');
    if (lineEl) {
      const href = lineEl.getAttribute('href') || '';
      const lineMatch = href.match(/line=(\d+)/);
      if (lineMatch) {
        const index = parseInt(lineMatch[1]) - 1;
        if (index >= 0 && index < cartItems.length) return index;
      }
      const inputId = lineEl.getAttribute('id') || '';
      const inputMatch = inputId.match(/(?:Quantity|updates|Remove)-(\d+)/i);
      if (inputMatch) {
        const index = parseInt(inputMatch[1]) - 1;
        if (index >= 0 && index < cartItems.length) return index;
      }
    }

    return null;
  }

  function findPriceElements(row) {
    const els = new Set();
    row.querySelectorAll(PRICE_SELECTORS).forEach(el => els.add(el));
    row.querySelectorAll('*').forEach(el => {
      const className = el.className || '';
      if (typeof className === 'string' && /price|total|money|amount/i.test(className)) {
        els.add(el);
      }
      const text = el.textContent || '';
      if (/[$\u20AB\u00A3\u20AC\u00A5]|\bVND\b|\bUSD\b/i.test(text)) {
        if (el.children.length <= 3 && text.length < 30) {
          els.add(el);
        }
      }
    });
    return Array.from(els);
  }

  function updateCartCounter(rawCount, realCount) {
    const selectors = [
      '.cart-count-bubble', 
      '.cart-count', 
      '#cart-icon-bubble', 
      '[data-cart-count]', 
      '.header__cart-count', 
      '.cart-link__count', 
      '.cart-item-count', 
      '.cart-items-count',
      '.cart-items__count',
      '.cart-counter',
      '.cart-link .count',
      '#CartCount',
      'h1 .badge',
      '.cart__title .badge',
      '.title-wrapper .badge',
      'h1 span',
      '.cart__title span',
      '.title-wrapper span',
      '.cart-header span'
    ];

    selectors.forEach(selector => {
      document.querySelectorAll(selector).forEach(el => {
        const txt = el.textContent.trim();
        if (txt === String(rawCount)) {
          el.textContent = String(realCount);
        } else if (el.querySelector('span')) {
          el.querySelectorAll('span').forEach(span => {
            if (span.textContent.trim() === String(rawCount)) {
              span.textContent = String(realCount);
            }
          });
        }
        el.classList.add("amzcustom-count-processed");
      });
    });

    const containers = document.querySelectorAll('header, .header, #header, .cart-drawer, #cart-drawer, .cart-notification, #cart-notification, .cart-header, .cart-title, .title-wrapper, h1, .h1, #cart-title, .main-cart-title, .cart__title');
    containers.forEach(container => {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
      let node;
      const nodesToUpdate = [];
      while (node = walker.nextNode()) {
        const text = node.nodeValue.trim();
        if (text === String(rawCount)) {
          nodesToUpdate.push(node);
          node.parentElement?.classList.add("amzcustom-count-processed");
        } else if (text === `(${rawCount})`) {
          node.nodeValue = node.nodeValue.replace(`(${rawCount})`, `(${realCount})`);
          node.parentElement?.classList.add("amzcustom-count-processed");
        } else {
          const regex = new RegExp(`\\b${rawCount}\\s*(items|item|sản phẩm)\\b`, 'i');
          if (regex.test(text)) {
            node.nodeValue = node.nodeValue.replace(regex, (match, word) => {
              const suffix = realCount === 1 ? (word.endsWith('s') ? word.slice(0, -1) : word) : word;
              return `${realCount} ${suffix}`;
            });
            node.parentElement?.classList.add("amzcustom-count-processed");
          }
        }
      }
      nodesToUpdate.forEach(n => {
        n.nodeValue = String(realCount);
      });
    });

    // Make sure all selectors are shown even if they didn't match the exact rawCount string
    document.querySelectorAll(selectors.join(', ')).forEach(el => {
      el.classList.add("amzcustom-count-processed");
    });
  }

  function applyInstantPreviews() {
    if (cartObserver) {
      try { cartObserver.disconnect(); } catch (e) {}
    }
    try {
      const currency = window.Shopify?.currency?.active || "USD";
      const isZeroDecimal = ZERO_DECIMAL_CURRENCIES.includes(currency);
      const format = window.Shopify?.theme?.money_format || window.Shopify?.money_format || window.theme?.moneyFormat || "${{amount}}";

      // Update count immediately using cache to prevent count flashing
      try {
        const cachedReal = localStorage.getItem("amzcustom_real_cart_count");
        const cachedRaw = localStorage.getItem("amzcustom_raw_cart_count");
        if (cachedReal !== null && cachedRaw !== null) {
          updateCartCounter(parseInt(cachedRaw, 10), parseInt(cachedReal, 10));
        }
      } catch (e) {}

      // Detect if theme rewrote processed rows (e.g. during quantity updates)
      document.querySelectorAll('.amzcustom-processed').forEach((row) => {
        const img = row.querySelector(".cart-items__media-image, img");
        const hasPreview = img ? img.hasAttribute("data-amzcustom-preview") : true;
        
        const priceEls = findPriceElements(row);
        const isPriceUpdated = priceEls.length === 0 || priceEls.some(el => el.hasAttribute("data-amzcustom-combined-price"));

        if (!hasPreview || !isPriceUpdated) {
          row.classList.remove("amzcustom-processed");
        }
      });

      document.querySelectorAll('tr, .cart-item, .cart-row, [data-cart-item]').forEach((row, rowIndex) => {
        if (row.classList.contains("amzcustom-processed")) return;
        const variantId = getVariantIdFromRow(row);
        if (variantId) {
          let processed = false;

          // 1. Instant Image Preview
          const cachedPreview = localStorage.getItem("amzcustom_preview_" + variantId);
          if (cachedPreview) {
            replaceImage(row, cachedPreview);
            processed = true;
          }

          // 2. Instant Price Preview (to prevent price flashing)
          const cachedSurcharge = localStorage.getItem("amzcustom_surcharge_" + variantId);
          if (cachedSurcharge) {
            const addonUnitPriceSum = parseInt(cachedSurcharge, 10);
            if (addonUnitPriceSum > 0) {
              let quantity = 1;
              const qtyInput = row.querySelector('input[name="updates[]"], input.quantity__input, .cart-item__quantity-wrapper input');
              if (qtyInput) {
                quantity = parseInt(qtyInput.value) || 1;
              }

              const cachedBasePrice = localStorage.getItem("amzcustom_unit_price_" + variantId);
              const baseUnitPrice = cachedBasePrice ? parseInt(cachedBasePrice, 10) : null;

              const priceEls = findPriceElements(row);

              priceEls.forEach((el) => {
                const text = el.textContent.trim();
                if (!text) return;

                let clean = text.replace(/\s/g, "");
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
                    if (parts[parts.length - 1].length <= 2) {
                      normalized = normalized.replace(",", ".");
                    } else {
                      normalized = normalized.replace(",", "");
                    }
                  } else {
                    normalized = normalized.replace(/,/g, "");
                  }
                  parsedValue = parseFloat(normalized);
                }

                if (isNaN(parsedValue)) return;

                const parsedCents = isZeroDecimal ? parsedValue : Math.round(parsedValue * 100);
                const storedOriginal = el.getAttribute("data-amzcustom-original-price");
                const originalCents = storedOriginal ? parseInt(storedOriginal, 10) : parsedCents;

                let isLinePrice = false;
                if (baseUnitPrice !== null) {
                  const expectedUnitPrice = baseUnitPrice;
                  const expectedLinePrice = baseUnitPrice * quantity;
                  const diffUnit = Math.abs(originalCents - expectedUnitPrice);
                  const diffLine = Math.abs(originalCents - expectedLinePrice);
                  if (diffLine < diffUnit && quantity > 1) {
                    isLinePrice = true;
                  }
                } else {
                  isLinePrice = /total|line|subtotal/i.test(el.className || '') || /total|line|subtotal/i.test(el.parentElement?.className || '');
                }

                const combinedCents = isLinePrice 
                  ? originalCents + (addonUnitPriceSum * quantity)
                  : originalCents + addonUnitPriceSum;

                updatePriceElement(el, originalCents, combinedCents, format, isZeroDecimal);
              });
              processed = true;
            }
          }

          if (processed) {
            row.classList.add("amzcustom-processed");
          }
        }
      });
    } finally {
      if (cartObserver) {
        try { cartObserver.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
      }
    }
  }

  // 2. Patch window.fetch to intercept cart quantity changes and update main/addon items together
  const originalFetch = window.fetch;
  
  let inFlightCartFetch = null;
  async function getCartData() {
    if (cartDataCache) return cartDataCache;
    if (inFlightCartFetch) return inFlightCartFetch;

    inFlightCartFetch = (async () => {
      try {
        const response = await originalFetch(`${window.Shopify.routes.root}cart.js`, { headers: { accept: "application/json" } });
        if (response.ok) {
          cartDataCache = await response.json();
          setTimeout(() => { cartDataCache = null; }, 2000);
          return cartDataCache;
        }
      } catch (e) {
        console.warn("Amazon customizer failed to get cart data", e);
      } finally {
        inFlightCartFetch = null;
      }
      return null;
    })();

    return inFlightCartFetch;
  }

  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input instanceof URL ? input.href : (input && input.url));
    
    // Helper to perform original fetch and patch its json output
    const doFetch = async (args) => {
      const response = await originalFetch.apply(this, args);
      if (response && response.ok && url && (url.includes("/cart") || url.includes("cart.js"))) {
        try {
          const clone = response.clone();
          const data = await clone.json();
          if (data && data.items) {
            const realCount = data.items.filter(item => !(item.properties && item.properties._customization_fee_component)).reduce((sum, item) => sum + item.quantity, 0);
            
            // Patch the response.json method
            const originalJson = response.json;
            response.json = async function() {
              const json = await originalJson.call(this);
              if (json) {
                json.item_count = realCount;
              }
              return json;
            };

            try {
              localStorage.setItem("amzcustom_raw_cart_count", String(data.item_count));
              localStorage.setItem("amzcustom_real_cart_count", String(realCount));
            } catch (e) {}

            // Also update the DOM immediately
            updateCartCounter(data.item_count, realCount);
          }
        } catch (e) {
          // Ignore non-json responses or errors
        }
      }
      return response;
    };

    if (!url || !init || !init.method || init.method.toUpperCase() !== "POST") {
      return doFetch(arguments);
    }

    const isChange = url.includes("/cart/change");
    const isUpdate = url.includes("/cart/update");

    if (isChange || isUpdate) {
      cartDataCache = null; // Invalidate cache immediately on change/update start
      try {
        const cart = await getCartData();
        if (cart && cart.items) {
          const addons = cart.items.filter(item => item.properties && item.properties._customization_fee_component);
          const mainItems = cart.items.filter(item => item.properties && item.properties._customization_id && !item.properties._customization_fee_component);

          let bodyObj = null;
          let isJson = false;

          if (typeof init.body === "string") {
            try {
              bodyObj = JSON.parse(init.body);
              isJson = true;
            } catch {
              bodyObj = Object.fromEntries(new URLSearchParams(init.body));
            }
          } else if (init.body instanceof FormData) {
            bodyObj = Object.fromEntries(init.body.entries());
          }

          if (bodyObj) {
            let updates = {};
            let intercepted = false;

            if (isChange) {
              const id = bodyObj.id || bodyObj.line;
              const quantity = parseInt(bodyObj.quantity);
              
              if (id !== undefined && !isNaN(quantity)) {
                let mainItem = null;
                if (!isNaN(id) && parseInt(id) > 0) {
                  mainItem = cart.items[parseInt(id) - 1];
                } else {
                  mainItem = mainItems.find(item => item.key === id || String(item.id) === String(id) || item.variant_id === parseInt(id));
                }

                if (mainItem && mainItems.includes(mainItem)) {
                  intercepted = true;
                  updates[mainItem.key] = quantity;
                  
                  const associatedAddons = addons.filter(addon => addon.properties._customization_id === mainItem.properties._customization_id);
                  for (const addon of associatedAddons) {
                    updates[addon.key] = quantity;
                  }
                }
              }
            } else if (isUpdate) {
              let reqUpdates = bodyObj.updates;
              if (reqUpdates) {
                intercepted = true;
                updates = { ...reqUpdates };
                for (const [key, qty] of Object.entries(reqUpdates)) {
                  const mainItem = mainItems.find(item => item.key === key || String(item.id) === String(key) || item.variant_id === parseInt(key));
                  if (mainItem) {
                    const associatedAddons = addons.filter(addon => addon.properties._customization_id === mainItem.properties._customization_id);
                    for (const addon of associatedAddons) {
                      updates[addon.key] = qty;
                    }
                  }
                }
              }
            }

            if (intercepted) {
              const newInit = { ...init };
              const newBody = { updates };
              
              if (bodyObj.sections) newBody.sections = bodyObj.sections;
              if (bodyObj.sections_url) newBody.sections_url = bodyObj.sections_url;

              newInit.headers = {
                ...newInit.headers,
                "content-type": "application/json"
              };
              newInit.body = JSON.stringify(newBody);

              const updateUrl = `${window.Shopify.routes.root}cart/update.js`;
              const response = await doFetch([updateUrl, newInit]);
              
              cartDataCache = null;
              schedule();
              return response;
            }
          }
        }
      } catch (err) {
        console.warn("Amazon customizer failed to intercept fetch", err);
      }
    }

    return doFetch(arguments);
  };

  async function syncCartQuantities(mainItems, addons) {
    if (updatingCart) {
      return false;
    }

    const updates = {};
    let needsUpdate = false;

    for (const mainItem of mainItems) {
      const associatedAddons = addons.filter(addon => addon.properties._customization_id === mainItem.properties._customization_id);
      for (const addon of associatedAddons) {
        if (addon.quantity !== mainItem.quantity) {
          updates[addon.key] = mainItem.quantity;
          needsUpdate = true;
        }
      }
    }

    for (const addon of addons) {
      const hasMainItem = mainItems.some(mainItem => mainItem.properties._customization_id === addon.properties._customization_id);
      if (!hasMainItem && addon.quantity > 0) {
        updates[addon.key] = 0;
        needsUpdate = true;
      }
    }

    if (needsUpdate) {
      updatingCart = true;
      try {
        const response = await fetch(`${window.Shopify.routes.root}cart/update.js`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates })
        });
        if (response.ok) {
          window.location.reload();
          return true;
        }
      } catch (error) {
        console.warn("syncCartQuantities error", error);
      } finally {
        updatingCart = false;
      }
    }
    return false;
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

      // We start DOM mutations here. Disconnect the observer to prevent infinite loops.
      if (cartObserver) {
        try { cartObserver.disconnect(); } catch (e) {}
      }
      try {
        const rawCount = cart.item_count;
        const realCount = (cart.items || []).filter(item => !(item.properties && item.properties._customization_fee_component)).reduce((sum, item) => sum + item.quantity, 0);
        try {
          localStorage.setItem("amzcustom_raw_cart_count", String(rawCount));
          localStorage.setItem("amzcustom_real_cart_count", String(realCount));
        } catch (e) {}
        updateCartCounter(rawCount, realCount);

        const addons = (cart.items || []).filter(item => item.properties && item.properties._customization_fee_component);
        const mainItems = (cart.items || []).filter(item => item.properties && item.properties._customization_id && !item.properties._customization_fee_component);

        const didSync = await syncCartQuantities(mainItems, addons);
        if (didSync) {
          return;
        }

        const currency = window.Shopify?.currency?.active || "USD";
        const isZeroDecimal = ZERO_DECIMAL_CURRENCIES.includes(currency);
        const format = window.Shopify?.theme?.money_format || window.Shopify?.money_format || window.theme?.moneyFormat || "${{amount}}";

        document.querySelectorAll('tr, .cart-item, .cart-row, [data-cart-item]').forEach((row, rowIndex) => {
          let item = null;
          const lineIndex = getLineIndexFromRow(row, cart.items || []);
          if (lineIndex !== null) {
            item = cart.items[lineIndex];
          } else {
            const key = row.getAttribute('data-key') || row.getAttribute('data-cart-item-key');
            if (key) {
              item = (cart.items || []).find(i => i.key === key);
            } else {
              const variantId = getVariantIdFromRow(row);
              if (variantId) {
                const matchingItems = (cart.items || []).filter(i => String(i.variant_id) === String(variantId) || String(i.id) === String(variantId));
                if (matchingItems.length === 1) {
                  item = matchingItems[0];
                }
              }
            }
          }

          if (!item) return;

          const isAddon = item.properties && item.properties._customization_fee_component;
          if (isAddon) {
            row.style.setProperty("display", "none", "important");
            row.classList.add("amzcustom-addon-hidden");
            return;
          }

          const isMainCustomized = item.properties && item.properties._customization_id && !item.properties._customization_fee_component;
          if (isMainCustomized) {
            const url = previewUrl(item);
            if (url) replaceImage(row, url);
            
            row.querySelectorAll('.amzcustom-surcharge-label').forEach(el => el.remove());

            // Save unit price to localStorage for applyInstantPreviews
            const mainUnitPrice = item.final_price || item.price;
            try {
              localStorage.setItem("amzcustom_unit_price_" + item.variant_id, String(mainUnitPrice));
            } catch (e) {}

            const associatedAddons = addons.filter(addon => addon.properties._customization_id === item.properties._customization_id);
            if (associatedAddons.length > 0) {
              const mainUnitPrice = item.final_price || item.price;
              const mainLinePrice = item.final_line_price || item.line_price;

              const addonUnitPriceSum = associatedAddons.reduce((sum, addon) => sum + (addon.final_price || addon.price), 0);
              const addonLinePriceSum = associatedAddons.reduce((sum, addon) => sum + (addon.final_line_price || addon.line_price), 0);

              const combinedUnitPrice = mainUnitPrice + addonUnitPriceSum;
              const combinedLinePrice = mainLinePrice + addonLinePriceSum;

              const priceEls = findPriceElements(row);
              priceEls.forEach((el) => {
                updatePriceElement(el, mainUnitPrice, combinedUnitPrice, format, isZeroDecimal);
                updatePriceElement(el, mainLinePrice, combinedLinePrice, format, isZeroDecimal);
              });
            }
            row.classList.add("amzcustom-processed");
          } else {
            // Revert customizations if it was previously processed or cached
            const variantId = item.variant_id || item.id;
            if (variantId) {
              try {
                localStorage.removeItem("amzcustom_preview_" + variantId);
                localStorage.removeItem("amzcustom_surcharge_" + variantId);
                localStorage.removeItem("amzcustom_unit_price_" + variantId);
              } catch (e) {}
            }

            // Restore image
            const image = row.querySelector(".cart-items__media-image, img");
            if (image && image.dataset.amzcustomOriginalSrc) {
              image.src = image.dataset.amzcustomOriginalSrc;
              image.alt = image.dataset.amzcustomOriginalAlt || "";
              delete image.dataset.amzcustomOriginalSrc;
              delete image.dataset.amzcustomOriginalAlt;
              delete image.dataset.amzcustomPreview;
            }

            // Restore prices
            const priceEls = findPriceElements(row);
            priceEls.forEach((el) => {
              const storedOriginal = el.getAttribute("data-amzcustom-original-price");
              if (storedOriginal) {
                const originalCents = parseInt(storedOriginal, 10);
                updatePriceElement(el, originalCents, originalCents, format, isZeroDecimal);
                el.removeAttribute("data-amzcustom-original-price");
                el.removeAttribute("data-amzcustom-combined-price");
              }
            });

            row.classList.remove("amzcustom-processed");
          }
        });
      } finally {
        if (cartObserver) {
          try { cartObserver.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
        }
      }
    } catch (error) {
      console.warn("Amazon customizer could not apply cart previews", error);
    } finally {
      running = false;
    }
  }

  let cartObserver = null;

  function schedule() {
    applyInstantPreviews();

    // Only fetch cart.js if there are cart elements (cart page, cart drawer, or cart popups)
    const hasCart = document.querySelector('form[action*="/cart"], .cart-items, [data-cart-items], .cart-drawer, .ajaxcart, .cart-popup') !== null;
    if (!hasCart) {
      return;
    }

    if (scheduled) return;
    scheduled = true;
    window.setTimeout(() => {
      scheduled = false;
      applyPreviews();
    }, 80);
  }

  // Run instantly on execution to avoid any flicker
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyInstantPreviews);
  } else {
    applyInstantPreviews();
  }

  document.addEventListener("DOMContentLoaded", schedule);
  window.addEventListener("pageshow", schedule);

  let runCount = 0;
  cartObserver = new MutationObserver((mutations) => {
    runCount++;
    if (runCount > 150) {
      cartObserver.disconnect();
      return;
    }
    schedule();
  });
  cartObserver.observe(document.documentElement, { childList: true, subtree: true });
})();
  cartObserver.observe(document.documentElement, { childList: true, subtree: true });
})();
