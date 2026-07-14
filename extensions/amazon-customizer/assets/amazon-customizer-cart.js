(function () {
  "use strict";

  const CART_SURFACE_SELECTOR = 'form[action*="/cart"], .cart-items, [data-cart-items], .cart-drawer, .ajaxcart, .cart-popup';
  const ROOT_SELECTORS = [
    '[data-cart-item]',
    '.cart-item',
    '.cart__item',
    '.ajaxcart__product',
    '.ajaxcart__row',
    '.drawer__cart-item',
    '.mini-cart__item',
    '.line-item',
    'tr',
    'li'
  ];
  const loadedFonts = new Set();
  const imageCache = new Map();
  const previewCache = new Map();

  if (!document.querySelector(CART_SURFACE_SELECTOR)) return;
  if (document.querySelector("cart-customization-preview,[data-customization-preview-root]")) return;

  try {
    const raw = sessionStorage.getItem("amzcustom_last_add_timing");
    if (raw) {
      const timing = JSON.parse(raw);
      const totalSeconds = Number(((Date.now() - new Date(timing.startedAt).getTime()) / 1000).toFixed(2));
      console.log("[Amazon Customizer] Cart loaded after add customized item", {
        variantId: timing.variantId,
        customizationId: timing.customizationId,
        addToCartSeconds: timing.elapsedSeconds,
        cartLoadSeconds: totalSeconds
      });
      sessionStorage.removeItem("amzcustom_last_add_timing");
    }
  } catch (error) {
    console.warn("[Amazon Customizer] Could not read add-to-cart timing", error);
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function fromBase64Unicode(value) {
    return decodeURIComponent(escape(atob(String(value || ""))));
  }

  function decodePayload(properties) {
    const count = Number(properties?._customization_payload_count || 0);
    if (!count) return null;
    let joined = "";
    for (let index = 1; index <= count; index += 1) joined += properties[`_customization_payload_${index}`] || "";
    if (!joined) return null;
    try {
      return JSON.parse(fromBase64Unicode(joined));
    } catch (error) {
      console.warn("[Amazon Customizer] Could not decode customization payload", error);
      return null;
    }
  }

  function ensureFont(layer) {
    const key = `${layer.fontFamily || ""}|${layer.fontUrl || ""}|${layer.fontType || ""}`;
    if (!key || loadedFonts.has(key)) return Promise.resolve();
    loadedFonts.add(key);
    if (layer.fontUrl && "FontFace" in window) {
      const face = new FontFace(layer.fontFamily || "Arial", `url(${JSON.stringify(layer.fontUrl).slice(1, -1)})`);
      return face.load().then((loaded) => {
        document.fonts.add(loaded);
      }).catch(() => {});
    }
    if (/googlefont/i.test(layer.fontType || "") && layer.fontFamily) {
      const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(layer.fontFamily).replace(/%20/g, "+")}&display=swap`;
      if (![...document.querySelectorAll("link[href]")].some((link) => link.href === href)) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        document.head.appendChild(link);
      }
    }
    return Promise.resolve();
  }

  async function loadImage(url) {
    const key = String(url || "");
    if (!key) throw new Error("Missing preview layer image.");
    if (!imageCache.has(key)) {
      imageCache.set(key, new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = key;
      }).catch((error) => {
        imageCache.delete(key);
        throw error;
      }));
    }
    return imageCache.get(key);
  }

  function ratioRect(rect, size) {
    return {
      x: rect.x * size,
      y: rect.y * size,
      width: rect.width * size,
      height: rect.height * size
    };
  }

  async function renderPreviewDataUrl(previewModel, size = 320) {
    const cacheKey = JSON.stringify([previewModel, size]);
    if (previewCache.has(cacheKey)) return previewCache.get(cacheKey);
    const job = (async () => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      context.fillStyle = previewModel.background || "#ffffff";
      context.fillRect(0, 0, size, size);

      const textLayers = previewModel.layers.filter((layer) => layer.type === "text");
      await Promise.all(textLayers.map(ensureFont));

      for (const layer of previewModel.layers || []) {
        if (layer.type === "image") {
          const image = await loadImage(layer.src);
          const rect = ratioRect(layer.rect, size);
          context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
          continue;
        }
        if (layer.type === "clipped-image") {
          const image = await loadImage(layer.src);
          const clipRect = ratioRect(layer.clipRect, size);
          const imageRect = ratioRect(layer.imageRect, size);
          context.save();
          context.beginPath();
          context.rect(clipRect.x, clipRect.y, clipRect.width, clipRect.height);
          context.clip();
          context.drawImage(image, imageRect.x, imageRect.y, imageRect.width, imageRect.height);
          context.restore();
          continue;
        }
        if (layer.type === "text") {
          const rect = ratioRect(layer.rect, size);
          const lines = String(layer.text || "").split(/\r?\n/);
          const fontSize = Math.max(10, (Number(layer.fontSizeRatio) || 0.05) * size);
          const lineHeight = Math.max(fontSize * 1.18, (Number(layer.lineHeightRatio) || 0.06) * size);
          context.save();
          context.fillStyle = layer.color || "#000000";
          context.font = `${fontSize}px "${String(layer.fontFamily || "Arial").replace(/"/g, '\\"')}", Arial, sans-serif`;
          context.textAlign = "center";
          context.textBaseline = "middle";
          if (layer.singleLine) {
            context.fillText(lines.join(" ").replace(/\s+/g, " "), rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width);
          } else {
            lines.forEach((line, index) => {
              context.fillText(line, rect.x + rect.width / 2, rect.y + rect.height / 2 + (index - (lines.length - 1) / 2) * lineHeight, rect.width);
            });
          }
          context.restore();
        }
      }

      return canvas.toDataURL("image/jpeg", 0.82);
    })().catch((error) => {
      previewCache.delete(cacheKey);
      throw error;
    });
    previewCache.set(cacheKey, job);
    return job;
  }

  function cartLineRoots() {
    const roots = [];
    const seen = new Set();
    document.querySelectorAll(CART_SURFACE_SELECTOR).forEach((surface) => {
      surface.querySelectorAll(ROOT_SELECTORS.join(",")).forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (!node.querySelector("img")) return;
        if (!node.innerText.trim()) return;
        const key = `${node.tagName}:${node.innerText.slice(0, 120)}`;
        if (seen.has(key)) return;
        seen.add(key);
        roots.push(node);
      });
    });
    return roots;
  }

  function imageElementForRoot(root) {
    return root.querySelector("img");
  }

  function titlePattern(item) {
    const title = String(item.product_title || item.title || "").trim();
    return title ? new RegExp(escapeRegExp(title), "i") : null;
  }

  function matchRootsToItems(items, roots) {
    const matches = [];
    const used = new Set();
    items.forEach((item) => {
      let root = null;
      const pattern = titlePattern(item);
      if (pattern) {
        root = roots.find((candidate, index) => !used.has(index) && pattern.test(candidate.innerText || ""));
        if (root) used.add(roots.indexOf(root));
      }
      if (!root) {
        const nextIndex = roots.findIndex((candidate, index) => !used.has(index) && imageElementForRoot(candidate));
        if (nextIndex >= 0) {
          used.add(nextIndex);
          root = roots[nextIndex];
        }
      }
      matches.push({ item, root });
    });
    return matches;
  }

  async function applyCartPreviews() {
    const response = await fetch(`${window.Shopify.routes.root}cart.js`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Cart JSON failed (${response.status})`);
    const cart = await response.json();
    const previewItems = (cart.items || []).filter((item) => item.properties && item.properties._customization_payload_count).map((item) => ({
      item,
      payload: decodePayload(item.properties)
    })).filter((entry) => entry.payload?.previewModel?.layers?.length);

    if (!previewItems.length) return;

    const roots = cartLineRoots();
    const pairs = matchRootsToItems(previewItems.map((entry) => entry.item), roots);
    for (let index = 0; index < previewItems.length; index += 1) {
      const previewItem = previewItems[index];
      const root = pairs[index] && pairs[index].root;
      const image = root && imageElementForRoot(root);
      if (!image) continue;
      try {
        const dataUrl = await renderPreviewDataUrl(previewItem.payload.previewModel, 320);
        image.dataset.amzcustomOriginalSrc = image.dataset.amzcustomOriginalSrc || image.currentSrc || image.src;
        image.src = dataUrl;
        image.removeAttribute("srcset");
        image.setAttribute("data-amzcustom-preview", "true");
      } catch (error) {
        console.warn("[Amazon Customizer] Could not render cart preview", error);
      }
    }
  }

  let applyQueued = false;
  function scheduleApply() {
    if (applyQueued) return;
    applyQueued = true;
    requestAnimationFrame(() => {
      applyQueued = false;
      applyCartPreviews().catch((error) => console.warn("[Amazon Customizer] Cart preview apply failed", error));
    });
  }

  scheduleApply();
  new MutationObserver(scheduleApply).observe(document.body, { childList: true, subtree: true });
})();
