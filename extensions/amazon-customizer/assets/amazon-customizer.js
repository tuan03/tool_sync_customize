(function () {
  "use strict";
  const instances = new WeakMap();
  const loadedFonts = new Set();
  let imageEditorAssetsPromise = null;
  const canvasImageCache = new Map();
  const COLLAPSED_OPTION_LIMIT = 10;
  const q = (root, selector) => root.querySelector(selector);
  const escapeHtml = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char]));

  function normalizeConfigShape(config) {
    if (!config || typeof config !== "object") return null;
    for (const key of ["optionGroups", "textInputs", "imageInputs", "fontGroups", "colorGroups", "placements", "surfaces", "conditionalRules", "controlOrder", "assets"]) {
      if (!Array.isArray(config[key])) config[key] = [];
    }
    for (const group of config.optionGroups) if (!Array.isArray(group.options)) group.options = [];
    for (const group of config.fontGroups) if (!Array.isArray(group.options)) group.options = [];
    for (const group of config.colorGroups) if (!Array.isArray(group.options)) group.options = [];
    config.controlOrder = config.controlOrder.filter((entry) => entry && entry.type && entry.id);
    config.product ||= {};
    config.pricing ||= {};
    return config;
  }

  async function parseConfig(root) {
    try {
      let config = JSON.parse(root.dataset.config);
      if (typeof config === "string") config = JSON.parse(config);
      if (config && config.externalConfig) {
        if (!config.configUrl) throw new Error("Missing external customizer config URL.");
        const url = String(config.configUrl).startsWith("//") ? `${window.location.protocol}${config.configUrl}` : config.configUrl;
        const response = await fetch(url, { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`External customizer config failed to load (${response.status}).`);
        config = await response.json();
        if (typeof config === "string") config = JSON.parse(config);
      }
      return normalizeConfigShape(config);
    }
    catch (error) { console.error("Invalid Amazon customizer metafield", error); return null; }
  }
  function initialState(config) {
    const options = {}, fonts = {}, colors = {};
    for (const group of config.optionGroups || []) {
      const groupOptions = Array.isArray(group.options) ? group.options : [];
      const fallback = groupOptions.find((option) => !option.outOfStock) || groupOptions[0];
      const defaultOption = groupOptions.find((option) => option.id === group.defaultOptionId && !option.outOfStock);
      options[group.id] = (defaultOption && defaultOption.id) || (group.required && fallback && fallback.id) || "";
    }
    for (const group of config.fontGroups || []) {
      const groupOptions = Array.isArray(group.options) ? group.options : [];
      fonts[group.id] = group.defaultFontId || (groupOptions[0] && groupOptions[0].id) || "";
    }
    for (const group of config.colorGroups || []) {
      const groupOptions = Array.isArray(group.options) ? group.options : [];
      colors[group.id] = group.defaultColorId || (groupOptions[0] && groupOptions[0].id) || "";
    }
    return { options, fonts, colors, texts: {}, images: {}, imageTransforms: {}, textTransforms: {}, placementOffsets: {}, visible: {}, errors: {}, activeEdit: "", expandedOptionGroups: {}, promotedOptionIds: {} };
  }
  function resolveCurrency(context) {
    if (typeof context === "string" && context) return context;
    const dataset = context?.root?.dataset || context?.dataset;
    return (
      dataset?.currencyCode ||
      document.querySelector("[data-amzcustom-root]")?.dataset?.currencyCode ||
      window.Shopify?.currency?.active ||
      "USD"
    );
  }
  function formatMoney(value, context) {
    const amount = Number(value || 0);
    const currency = resolveCurrency(context);
    const locale = document.documentElement.lang || navigator.language || "en-US";
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
    } catch (_error) {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
    }
  }
  function variantPickerRoot(root) {
    const productId = String(root?.dataset?.productId || "");
    return (
      (productId && document.querySelector(`variant-picker[data-product-id="${CSS.escape(productId)}"]`)) ||
      root.closest(".shopify-section, featured-product-information, main")?.querySelector("variant-picker") ||
      null
    );
  }
  function variantSelectsRoot(root) {
    const productId = String(root?.dataset?.productId || "");
    return (
      (productId && document.querySelector(`variant-selects[data-product-id="${CSS.escape(productId)}"]`)) ||
      root.closest("product-info, .shopify-section, featured-product-information, main")?.querySelector("variant-selects") ||
      null
    );
  }
  function productFormRoot(root) {
    return (
      root.closest("product-info, .shopify-section, featured-product-information, main")?.querySelector('form[action*="/cart/add"]') ||
      root.closest('form[action*="/cart/add"]') ||
      null
    );
  }
  function parseSelectedVariantJson(root) {
    const variantSelects = variantSelectsRoot(root);
    const script = variantSelects?.querySelector("[data-selected-variant]");
    if (!script?.textContent) return null;
    try {
      return JSON.parse(script.textContent);
    } catch (_error) {
      return null;
    }
  }
  function currentVariantSelection(root) {
    const form = productFormRoot(root);
    const variantInput = form?.querySelector('input[name="id"]');
    const variantIdFromForm = String(variantInput?.value || "");
    const selectedVariant = parseSelectedVariantJson(root);
    const picker = variantPickerRoot(root);
    const source = picker?.querySelector('input[type="radio"]:checked[data-variant-id], select option:checked[data-variant-id]');
    const variantId = variantIdFromForm || String(selectedVariant?.id || "") || source?.dataset?.variantId || root?.dataset?.variantId || "";
    const variantPrice = Number(selectedVariant?.price);
    const legacyVariantPrice = Number(source?.dataset?.variantPrice);
    const basePrice = Number.isFinite(variantPrice)
      ? variantPrice / 100
      : Number.isFinite(legacyVariantPrice)
        ? legacyVariantPrice / 100
        : Number(root?.dataset?.basePrice || 0);
    stageLog("Current variant selection resolved", {
      productId: root?.dataset?.productId || "",
      variantIdFromForm,
      variantIdFromSelectedVariantJson: String(selectedVariant?.id || ""),
      variantIdFromLegacyPicker: String(source?.dataset?.variantId || ""),
      resolvedVariantId: variantId,
      variantPriceFromSelectedVariantJson: Number.isFinite(variantPrice) ? variantPrice : null,
      variantPriceFromLegacyPicker: Number.isFinite(legacyVariantPrice) ? legacyVariantPrice : null,
      resolvedBasePrice: Number.isFinite(basePrice) ? basePrice : Number(root?.dataset?.basePrice || 0)
    });
    return {
      variantId: String(variantId || ""),
      basePrice: Number.isFinite(basePrice) ? basePrice : 0,
    };
  }
  function basePrice(instance) {
    const value = currentVariantSelection(instance?.root).basePrice;
    return Number.isFinite(value) ? value : 0;
  }
  function currentVariantId(instance) {
    return currentVariantSelection(instance?.root).variantId;
  }
  function surcharge(instance) {
    return (instance.config.optionGroups || []).reduce((total, group) => total + (selected(group, instance.state)?.cost || 0), 0);
  }
  function totalPrice(instance) {
    return basePrice(instance) + surcharge(instance);
  }
  function nowMs() {
    return performance.now();
  }
  function secondsSince(startedAt) {
    return Number(((nowMs() - startedAt) / 1000).toFixed(2));
  }
  function stageLog(label, details = {}) {
    console.log(`[Amazon Customizer] ${label}`, details);
  }
  function cssFontFamily(family) {
    return `"${String(family || "").replace(/"/g, '\\"')}", Arial, Helvetica, sans-serif`;
  }
  function ensureFontLoaded(font) {
    if (!font || !font.family || loadedFonts.has(font.family)) return;
    loadedFonts.add(font.family);
    if (font.fontUrl) {
      const style = document.createElement("style");
      style.textContent = `@font-face{font-family:${JSON.stringify(font.family)};src:url(${JSON.stringify(font.fontUrl)});font-display:swap}`;
      document.head.appendChild(style);
      return;
    }
    if (/googlefont/i.test(font.fontType || "")) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font.family).replace(/%20/g, "+")}&display=swap`;
      document.head.appendChild(link);
    }
  }
  function loadExternalStyle(url) {
    if ([...document.querySelectorAll("link[href]")].some((link) => link.href === url)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = url;
      link.onload = resolve;
      link.onerror = () => reject(new Error(`Could not load stylesheet: ${url}`));
      document.head.appendChild(link);
    });
  }
  function loadExternalScript(url) {
    if ([...document.querySelectorAll("script[src]")].some((script) => script.src === url)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Could not load script: ${url}`));
      document.head.appendChild(script);
    });
  }
  function ensureImageEditorAssets() {
    if (window.tui?.ImageEditor) return Promise.resolve();
    if (!imageEditorAssetsPromise) {
      imageEditorAssetsPromise = (async () => {
        await Promise.all([
          loadExternalStyle("https://uicdn.toast.com/tui-color-picker/v2.2.6/tui-color-picker.css"),
          loadExternalStyle("https://uicdn.toast.com/tui-image-editor/v3.15.3/tui-image-editor.css")
        ]);
        await loadExternalScript("https://cdnjs.cloudflare.com/ajax/libs/fabric.js/4.4.0/fabric.min.js");
        await loadExternalScript("https://uicdn.toast.com/tui.code-snippet/v1.5.0/tui-code-snippet.min.js");
        await loadExternalScript("https://uicdn.toast.com/tui-color-picker/v2.2.6/tui-color-picker.min.js");
        await loadExternalScript("https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/1.3.3/FileSaver.min.js");
        await loadExternalScript("https://uicdn.toast.com/tui-image-editor/v3.15.3/tui-image-editor.min.js");
      })();
    }
    return imageEditorAssetsPromise;
  }
  function ensureImageEditorOverrideStyle() {
    if (document.getElementById("amzcustom-editor-overrides")) return;
    const style = document.createElement("style");
    style.id = "amzcustom-editor-overrides";
    style.textContent = `
      .amzcustom-editor-modal .tui-image-editor-container,
      .amzcustom-editor-modal .tui-image-editor-header,
      .amzcustom-editor-modal .tui-image-editor-main-container,
      .amzcustom-editor-modal .tui-image-editor-main,
      .amzcustom-editor-modal .tui-image-editor-wrap,
      .amzcustom-editor-modal .tui-image-editor-controls,
      .amzcustom-editor-modal .tui-image-editor-help-menu,
      .amzcustom-editor-modal .tui-image-editor-help-menu.top {
        background: #fff !important;
        color: #111 !important;
      }
      .amzcustom-editor-modal .tui-image-editor-header {
        height: 52px !important;
        min-width: 0 !important;
        border-bottom: 1px solid #e3e6e6 !important;
      }
      .amzcustom-editor-modal .tui-image-editor-main-container {
        top: 52px !important;
        bottom: 190px !important;
        height: auto !important;
      }
      .amzcustom-editor-modal .tui-image-editor-main {
        top: 0 !important;
        bottom: 0 !important;
        height: auto !important;
      }
      .amzcustom-editor-modal .tui-image-editor-controls {
        height: 64px !important;
        bottom: 0 !important;
        border-top: 1px solid #e3e6e6 !important;
        z-index: 4 !important;
      }
      .amzcustom-editor-modal .tui-image-editor-submenu {
        bottom: 64px !important;
        height: 126px !important;
        overflow-x: auto !important;
        overflow-y: hidden !important;
        background: #fff !important;
        border-top: 1px solid #e3e6e6 !important;
        z-index: 3 !important;
      }
      .amzcustom-editor-modal .tui-image-editor-submenu,
      .amzcustom-editor-modal .tui-image-editor-submenu *,
      .amzcustom-editor-modal .tui-image-editor-container label,
      .amzcustom-editor-modal .tui-image-editor-container span,
      .amzcustom-editor-modal .tui-image-editor-container input,
      .amzcustom-editor-modal .tui-image-editor-container button {
        color: #111 !important;
        opacity: 1 !important;
        text-shadow: none !important;
      }
      .amzcustom-editor-modal .tui-image-editor-header-logo,
      .amzcustom-editor-modal .tui-image-editor-header-buttons,
      .amzcustom-editor-modal .tui-image-editor-submenu-style {
        display: none !important;
      }
      .amzcustom-editor-modal .tui-image-editor-help-menu.top {
        width: auto !important;
        min-width: 0 !important;
        box-shadow: none !important;
        border: 1px solid #e3e6e6 !important;
        border-radius: 999px !important;
      }
      .amzcustom-editor-modal .tui-image-editor-help-menu.top > .tui-image-editor-item {
        display: none !important;
      }
      .amzcustom-editor-modal .tui-image-editor-help-menu.top > .tui-image-editor-item[tooltip-content="Undo"],
      .amzcustom-editor-modal .tui-image-editor-help-menu.top > .tui-image-editor-item[tooltip-content="Redo"],
      .amzcustom-editor-modal .tui-image-editor-help-menu.top > .tui-image-editor-item[tooltip-content="Reset"] {
        display: inline-block !important;
      }
      .amzcustom-editor-modal .tui-image-editor-menu > .tui-image-editor-item {
        background: transparent !important;
        opacity: 1 !important;
      }
      .amzcustom-editor-modal .tui-image-editor-menu > .tui-image-editor-item.active {
        background: #eef6f8 !important;
        box-shadow: inset 0 0 0 1px #007185 !important;
      }
      .amzcustom-editor-modal .tui-image-editor-container svg,
      .amzcustom-editor-modal .tui-image-editor-container svg use {
        color: #111 !important;
        fill: #111 !important;
        stroke: #111 !important;
        opacity: 1 !important;
      }
      .amzcustom-editor-modal .tui-image-editor-checkbox input + label:before,
      .amzcustom-editor-modal .tui-image-editor-checkbox > label > span:before {
        border: 1px solid #8d9096 !important;
        background-color: #fff !important;
      }
      .amzcustom-editor-modal .tui-image-editor-range-value {
        background: #fff !important;
        color: #111 !important;
        border-color: #8d9096 !important;
      }
      .amzcustom-editor-modal .tui-image-editor-virtual-range-bar {
        background: #9ca3af !important;
      }
      .amzcustom-editor-modal .tui-image-editor-virtual-range-subbar,
      .amzcustom-editor-modal .tui-image-editor-virtual-range-pointer {
        background: #111 !important;
      }
      @media (max-width: 760px) {
        .amzcustom-editor-modal {
          align-items: stretch !important;
          justify-items: stretch !important;
        }
        .amzcustom-editor-modal .tui-image-editor-header {
          height: 48px !important;
        }
        .amzcustom-editor-modal .tui-image-editor-main-container {
          top: 48px !important;
          bottom: 74px !important;
          overflow: hidden !important;
        }
        .amzcustom-editor-modal .tui-image-editor-main {
          overflow: hidden !important;
        }
        .amzcustom-editor-modal .tui-image-editor-wrap {
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          overflow: hidden !important;
        }
        .amzcustom-editor-modal .tui-image-editor-controls {
          height: 74px !important;
          overflow-x: auto !important;
          overflow-y: hidden !important;
          white-space: nowrap !important;
          -webkit-overflow-scrolling: touch !important;
        }
        .amzcustom-editor-modal .tui-image-editor-menu {
          min-width: max-content !important;
          padding: 0 12px !important;
        }
        .amzcustom-editor-modal .tui-image-editor-submenu {
          bottom: 74px !important;
          height: 112px !important;
          overflow-x: auto !important;
          overflow-y: hidden !important;
          -webkit-overflow-scrolling: touch !important;
        }
      }
    `;
    document.head.appendChild(style);
  }
  function imageDataFromUrl(dataUrl, file) {
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve({ file, dataUrl, width: image.naturalWidth || 1, height: image.naturalHeight || 1 });
      image.onerror = () => resolve({ file, dataUrl, width: 1, height: 1 });
      image.src = dataUrl;
    });
  }
  function forceStyle(element, styles) {
    if (!element) return;
    for (const [key, value] of Object.entries(styles)) element.style.setProperty(key, value, "important");
  }
  function restyleImageEditor(modal) {
    const root = modal.querySelector(".tui-image-editor-container");
    if (!root) return;
    root.querySelectorAll(".tui-image-editor-header,.tui-image-editor-header *,.tui-image-editor-help-menu,.tui-image-editor-help-menu *,.tui-image-editor-main-container,.tui-image-editor-main,.tui-image-editor-wrap,.tui-image-editor-controls,.tui-image-editor-controls *,.tui-image-editor-submenu,.tui-image-editor-submenu > div,.tui-image-editor-submenu .tui-image-editor-submenu-item").forEach((item) => forceStyle(item, { background: "#fff", color: "#111", opacity: "1" }));
    root.querySelectorAll(".tui-image-editor-submenu *,.tui-image-editor-submenu label,.tui-image-editor-submenu span,label,span,.tui-image-editor-range-wrap label,.tui-image-editor-submenu label > span").forEach((item) => forceStyle(item, { color: "#111", opacity: "1", textShadow: "none" }));
    root.querySelectorAll("svg,svg use").forEach((item) => forceStyle(item, { color: "#111", fill: "#111", stroke: "#111", opacity: "1" }));
    root.querySelectorAll(".tui-image-editor-submenu-style").forEach((item) => forceStyle(item, { display: "none", background: "transparent" }));
    forceStyle(root.querySelector(".tui-image-editor-help-menu.top"), { background: "#fff", color: "#111", boxShadow: "none" });
  }
  async function openImageEditor(instance, id) {
    const image = instance.state.images[id];
    if (!image?.dataUrl) return;
    const modal = document.createElement("div");
    modal.className = "amzcustom-editor-modal";
    modal.innerHTML = `<div class="amzcustom-editor-dialog" role="dialog" aria-modal="true" aria-label="Edit image"><div class="amzcustom-editor-head"><h3>Edit image</h3><div><button type="button" data-editor-cancel>Cancel</button><button type="button" class="primary" data-editor-save>Save</button></div></div><div class="amzcustom-editor-body"><div class="amzcustom-editor-loading">Loading editor...</div><div class="amzcustom-editor-container"></div></div></div>`;
    document.body.appendChild(modal);
    let close = (editor) => {
      try { editor?.destroy?.(); } catch {}
      modal.remove();
    };
    let editor = null;
    modal.querySelector("[data-editor-cancel]").addEventListener("click", () => close(editor));
    try {
      await ensureImageEditorAssets();
      ensureImageEditorOverrideStyle();
      modal.querySelector(".amzcustom-editor-loading")?.remove();
      const isMobileEditor = window.matchMedia("(max-width: 760px)").matches;
      const editorMaxWidth = isMobileEditor ? Math.max(260, window.innerWidth - 32) : Math.max(320, Math.min(920, window.innerWidth - 80));
      const editorMaxHeight = isMobileEditor ? Math.max(220, window.innerHeight - 300) : Math.max(260, Math.min(620, window.innerHeight - 210));
      editor = new window.tui.ImageEditor(modal.querySelector(".amzcustom-editor-container"), {
        includeUI: {
          loadImage: { path: image.dataUrl, name: image.file?.name || "Custom image" },
          menuBarPosition: "bottom"
        },
        cssMaxWidth: editorMaxWidth,
        cssMaxHeight: editorMaxHeight,
        usageStatistics: false
      });
      const editorContainer = modal.querySelector(".amzcustom-editor-container");
      let restyleQueued = false;
      const scheduleRestyle = () => {
        if (restyleQueued) return;
        restyleQueued = true;
        requestAnimationFrame(() => {
          restyleQueued = false;
          restyleImageEditor(modal);
          setTimeout(() => restyleImageEditor(modal), 60);
        });
      };
      const observer = new MutationObserver(scheduleRestyle);
      observer.observe(editorContainer, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
      const originalClose = close;
      close = (activeEditor) => {
        observer.disconnect();
        originalClose(activeEditor);
      };
      editorContainer.addEventListener("click", scheduleRestyle);
      requestAnimationFrame(() => { editor?.ui?.resizeEditor?.(); scheduleRestyle(); setTimeout(scheduleRestyle, 160); setTimeout(scheduleRestyle, 420); });
      modal.querySelector("[data-editor-save]").addEventListener("click", async () => {
        const dataUrl = editor.toDataURL();
        instance.state.images[id] = await imageDataFromUrl(dataUrl, image.file);
        close(editor);
        renderControls(instance);
      });
    } catch (error) {
      modal.querySelector(".amzcustom-editor-loading").textContent = error.message || "Could not load image editor.";
    }
  }
  function activeStyleGroup(instance, item, groups) {
    let best = groups && groups[0], bestScore = -1;
    const ancestors = new Set(item.ancestors || []);
    for (const group of groups || []) {
      let score = group.groupId && group.groupId === item.groupId ? 100 : 0;
      for (const id of group.ancestors || []) if (ancestors.has(id)) score += 1;
      if (score > bestScore) { best = group; bestScore = score; }
    }
    return best;
  }
  function normalizeText(value, input) {
    let text = String(value || "");
    if (input.maxLines) text = text.split(/\r?\n/).slice(0, input.maxLines).join("\n");
    if (input.maxLength) text = text.slice(0, input.maxLength);
    return text;
  }
  const textMeasureCanvas = document.createElement("canvas");
  const textMeasureContext = textMeasureCanvas.getContext("2d");
  function isSingleLineText(input) {
    return Number(input && input.maxLines || 1) <= 1;
  }
  function textLines(input, value) {
    const text = String(value || "");
    if (isSingleLineText(input)) return [text.replace(/\r?\n/g, " ")];
    return text.split(/\r?\n/);
  }
  function textFontSize(instance, input, boxStyles, value, fontFamily) {
    const width = Number(String(boxStyles.width || "100").replace("%", "")) || 100;
    const height = Number(String(boxStyles.height || "20").replace("%", "")) || 20;
    const stage = q(instance.modal, ".amzcustom-stage");
    const stageSize = stage && stage.clientWidth ? stage.clientWidth : 620;
    const boxWidth = Math.max(1, stageSize * width / 100);
    const boxHeight = Math.max(1, stageSize * height / 100);
    const lines = textLines(input, value);
    const maxFont = Math.max(4, Math.min(34, boxHeight / Math.max(1, lines.length * 1.18)));
    let size = maxFont;
    if (textMeasureContext) {
      textMeasureContext.font = `${size}px ${fontFamily || "Arial"}`;
      const measured = Math.max(1, ...lines.map((line) => textMeasureContext.measureText(line || " ").width));
      size = Math.min(size, size * (boxWidth * 0.98) / measured);
    } else {
      const longest = lines.reduce((max, line) => Math.max(max, line.length), 1);
      size = Math.min(size, boxWidth / Math.max(1, longest * 0.58));
    }
    return `${Math.max(4, size)}px`;
  }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function transformStyle(transform) {
    const item = transform || {};
    return `translate(${item.x || 0}%,${item.y || 0}%) scale(${item.scale || 1}) rotate(${item.rotation || 0}deg)`;
  }
  function fitBoxStyle(image) {
    const width = Number(image && image.width) || 1;
    const height = Number(image && image.height) || 1;
    if (width >= height) return `width:100%;height:${100 * height / width}%;`;
    return `width:${100 * width / height}%;height:100%;`;
  }
  function evaluate(instance) {
    const state = instance.state;
    state.visible = {};
    const grouped = {};
    for (const rule of instance.config.conditionalRules || []) (grouped[rule.dependentId] ||= []).push(rule);
    for (const [id, rules] of Object.entries(grouped)) {
      state.visible[id] = rules.some((rule) => {
        const matcher = rule.matcher || {};
        return matcher.matcherType !== "ChoiceMatcher" || (matcher.choiceIds || []).includes(state.options[matcher.componentIdentifier]);
      });
    }
  }
  function visible(instance, item) {
    if (instance.state.visible[item.id] === false) return false;
    return !(item.ancestors || []).some((id) => instance.state.visible[id] === false);
  }
  function asset(url) { return url || ""; }
  function selected(group, state) { return (Array.isArray(group.options) ? group.options : []).find((option) => option.id === state.options[group.id]); }
  function box(config, placementId, state) {
    const placement = (config.placements || []).find((item) => item.id === placementId);
    const size = config.product.previewSize || 400;
    if (!placement) return {};
    const offset = state.placementOffsets[placementId] || { x:0, y:0 };
    return { left:`${100 * (placement.position.x + offset.x) / size}%`, top:`${100 * (placement.position.y + offset.y) / size}%`, width:`${100 * placement.dimension.width / size}%`, height:`${100 * placement.dimension.height / size}%` };
  }
  function setBox(element, styles) { Object.assign(element.style, styles); }
  function startEdit(instance, editId) {
    instance.state.activeEdit = editId;
    renderControls(instance);
    q(instance.modal, ".amzcustom-preview")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function endEdit(instance) {
    instance.state.activeEdit = "";
    renderControls(instance);
  }
  function scheduleFontReadyRender(instance) {
    if (!document.fonts || instance.fontReadyRenderQueued) return;
    instance.fontReadyRenderQueued = true;
    document.fonts.ready.then(() => {
      instance.fontReadyRenderQueued = false;
      renderPreview(instance);
    }).catch(() => {
      instance.fontReadyRenderQueued = false;
    });
  }
  function triggerFileInput(root) {
    const input = root?.querySelector(".amzcustom-file");
    if (!input) return;
    input.value = "";
    input.click();
  }
  function isBackgroundOptionGroup(group) {
    return /background\s*color/i.test(`${group.label || ""} ${group.instructions || ""}`);
  }
  function normalizeAssetUrl(url) {
    if (!url) return "";
    try {
      const parsed = new URL(url, window.location.href);
      parsed.hash = "";
      parsed.search = "";
      return parsed.toString();
    } catch {
      return String(url).split("#")[0].split("?")[0];
    }
  }
  function isMockupOverlayGroup(instance, group, surface) {
    const options = Array.isArray(group?.options) ? group.options : [];
    if (!surface?.baseImage?.url || !options.length) return false;
    if (options.some((option) => !option?.overlayImage?.url)) return false;
    const baseUrl = normalizeAssetUrl(surface.baseImage.url);
    return options.some((option) => normalizeAssetUrl(option.overlayImage.url) === baseUrl);
  }
  function previewBaseUrl(instance, surface) {
    const fallback = surface?.baseImage?.url || instance.config.product.productImageUrl;
    for (const group of instance.config.optionGroups || []) {
      if (!visible(instance, group) || !isMockupOverlayGroup(instance, group, surface)) continue;
      const overlay = selected(group, instance.state)?.overlayImage?.url;
      if (overlay) return overlay;
    }
    return fallback;
  }
  function renderOptionOverlays(instance, shouldRender, className) {
    const stage = q(instance.modal, ".amzcustom-stage");
    const surface = (instance.config.surfaces || [])[0];
    for (const group of instance.config.optionGroups || []) {
      if (!visible(instance, group) || !shouldRender(group)) continue;
      if (isMockupOverlayGroup(instance, group, surface)) continue;
      const overlay = selected(group, instance.state)?.overlayImage?.url;
      if (overlay) stage.insertAdjacentHTML("beforeend", `<img class="${escapeHtml(className || "amzcustom-stage-overlay")}" alt="" src="${escapeHtml(asset(overlay))}">`);
    }
  }

  function renderPreview(instance) {
    const stage = q(instance.modal, ".amzcustom-stage");
    stage.innerHTML = "";
    const config = instance.config, state = instance.state;
    const surface = (config.surfaces || [])[0];
    const base = previewBaseUrl(instance, surface);
    if (base) stage.insertAdjacentHTML("beforeend", `<img class="amzcustom-stage-base" alt="" src="${escapeHtml(asset(base))}">`);
    renderOptionOverlays(instance, isBackgroundOptionGroup, "amzcustom-stage-background");
    for (const input of config.imageInputs || []) {
      if (!visible(instance, input) || !state.images[input.id]) continue;
      const placement = (config.placements || []).find((item) => item.id === input.placementId) || null;
      const boxStyles = box(config, input.placementId, state);
      const editId = `image:${input.id}`;
      const layer = document.createElement("div"); layer.className = `amzcustom-layer amzcustom-image-layer ${placement?.isFreePlacement ? "is-free-placement" : ""} ${state.activeEdit === editId ? "is-active-edit" : ""}`; layer.dataset.placementId=input.placementId||""; layer.dataset.editId = editId; setBox(layer, boxStyles);
      const transform = state.imageTransforms[input.id] || { x: 0, y: 0, scale: 1, rotation: 0 };
      const fit = fitBoxStyle(state.images[input.id]);
      layer.innerHTML = `<div class="amzcustom-clip"><div class="amzcustom-transform-box" style="${fit}transform:${transformStyle(transform)}"><img alt="" src="${escapeHtml(state.images[input.id].dataUrl)}"></div></div>${state.activeEdit === editId ? `<div class="amzcustom-edit-box"><button type="button" class="amzcustom-rotate-handle" data-transform-handle="rotate" aria-label="Rotate"></button><button type="button" class="amzcustom-resize-handle nw" data-transform-handle="resize" aria-label="Resize"></button><button type="button" class="amzcustom-resize-handle ne" data-transform-handle="resize" aria-label="Resize"></button><button type="button" class="amzcustom-resize-handle sw" data-transform-handle="resize" aria-label="Resize"></button><button type="button" class="amzcustom-resize-handle se" data-transform-handle="resize" aria-label="Resize"></button></div>` : ""}`;
      stage.appendChild(layer);
    }
    renderOptionOverlays(instance, (group) => !isBackgroundOptionGroup(group), "amzcustom-stage-overlay");
    for (const input of config.textInputs || []) {
      if (!visible(instance, input) || !state.texts[input.id]) continue;
      const boxStyles = box(config, input.placementId, state);
      const editId = `text:${input.id}`;
      const layer = document.createElement("div"); layer.className = `amzcustom-layer amzcustom-text-layer ${isSingleLineText(input) ? "is-single-line" : ""} ${state.activeEdit === editId ? "is-active-edit" : ""}`; layer.dataset.placementId=input.placementId||""; layer.dataset.editId = editId; setBox(layer, boxStyles);
      const fontGroup = activeStyleGroup(instance, input, config.fontGroups || []);
      const colorGroup = activeStyleGroup(instance, input, config.colorGroups || []);
      const font = (Array.isArray(fontGroup?.options) ? fontGroup.options : []).find((item) => item.id === state.fonts[fontGroup.id]);
      const color = (Array.isArray(colorGroup?.options) ? colorGroup.options : []).find((item) => item.id === state.colors[colorGroup.id]);
      ensureFontLoaded(font);
      const transform = state.textTransforms[input.id] || { x: 0, y: 0, scale: 1, rotation: 0 };
      layer.innerHTML = `<div class="amzcustom-clip"><div class="amzcustom-transform-box" style="transform:${transformStyle(transform)}"><span>${escapeHtml(isSingleLineText(input) ? state.texts[input.id].replace(/\r?\n/g, " ") : state.texts[input.id])}</span></div></div>${state.activeEdit === editId ? `<div class="amzcustom-edit-box"><button type="button" class="amzcustom-rotate-handle" data-transform-handle="rotate" aria-label="Rotate"></button><button type="button" class="amzcustom-resize-handle nw" data-transform-handle="resize" aria-label="Resize"></button><button type="button" class="amzcustom-resize-handle ne" data-transform-handle="resize" aria-label="Resize"></button><button type="button" class="amzcustom-resize-handle sw" data-transform-handle="resize" aria-label="Resize"></button><button type="button" class="amzcustom-resize-handle se" data-transform-handle="resize" aria-label="Resize"></button></div>` : ""}`;
      const fontFamily = cssFontFamily(font?.family || "Arial");
      layer.dataset.fontFamily = font?.family || "Arial";
      layer.dataset.fontUrl = font?.fontUrl || "";
      layer.dataset.fontType = font?.fontType || "";
      layer.style.fontFamily = fontFamily; layer.style.color = color?.value || "#000";
      layer.style.fontSize = textFontSize(instance, input, boxStyles, state.texts[input.id], fontFamily);
      stage.appendChild(layer);
    }
    if (surface?.maskImage?.url) stage.insertAdjacentHTML("beforeend", `<img class="amzcustom-stage-mask" alt="" src="${escapeHtml(asset(surface.maskImage.url))}">`);
    bindPreviewDrag(instance);
    syncEditBoxes(stage);
    q(instance.modal, ".amzcustom-price").textContent = "";
    q(instance.modal, ".amzcustom-total-price").textContent = `Total: ${formatMoney(totalPrice(instance), instance)}`;
  }
  function bindPreviewDrag(instance) {
    const stage=q(instance.modal,".amzcustom-stage");
    if (!stage.dataset.clearEditBound) {
      stage.dataset.clearEditBound = "true";
      stage.addEventListener("pointerdown", (event) => {
        if (event.target.closest("[data-layer-action],[data-transform-handle]")) return;
        const layers = [...stage.querySelectorAll(".amzcustom-layer[data-edit-id]")].reverse();
        const hitLayer = layers.find((item) => pointHitsLayer(item, event));
        const targetLayer = event.target.closest(".amzcustom-layer[data-edit-id]");
        if (hitLayer) {
          if (hitLayer !== targetLayer) {
            event.preventDefault();
            event.stopImmediatePropagation();
            startPreviewEdit(instance, stage, hitLayer, event, "move");
          }
          return;
        }
        if (instance.state.activeEdit) {
          event.preventDefault();
          event.stopImmediatePropagation();
          instance.state.activeEdit = "";
          renderControls(instance);
        }
      }, true);
    }
    stage.querySelectorAll(".amzcustom-layer[data-edit-id]").forEach((layer)=>{
      layer.addEventListener("pointerdown",(event)=>{ if (event.target.closest("[data-layer-action]")) return; const handle=event.target.closest("[data-transform-handle]")?.dataset.transformHandle || ""; if (!handle && !pointHitsLayer(layer, event)) return; startPreviewEdit(instance, stage, layer, event, handle || "move");
      });
    });
  }
  function pointHitsLayer(layer, event) {
    const box = layer.classList.contains("amzcustom-image-layer") ? layer.querySelector("img") : layer.querySelector(".amzcustom-transform-box");
    const rect = box?.getBoundingClientRect();
    return !!rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  }
  function syncEditBoxes(stage) {
    stage.querySelectorAll(".amzcustom-layer.is-active-edit").forEach(syncEditBox);
  }
  function syncEditBox(layer) {
    const imageBox = layer.classList.contains("amzcustom-image-layer") ? layer.querySelector("img") : layer.querySelector(".amzcustom-transform-box");
    const editBox = layer.querySelector(".amzcustom-edit-box");
    if (!imageBox || !editBox) return;
    const imageRect = imageBox.getBoundingClientRect();
    const layerRect = layer.getBoundingClientRect();
    Object.assign(editBox.style, {
      left: `${imageRect.left - layerRect.left}px`,
      top: `${imageRect.top - layerRect.top}px`,
      width: `${imageRect.width}px`,
      height: `${imageRect.height}px`,
      transform: "none",
      translate: "0 0"
    });
  }
  function visualRect(layer) {
    return (layer.classList.contains("amzcustom-image-layer") ? layer.querySelector("img") : layer.querySelector(".amzcustom-transform-box"))?.getBoundingClientRect();
  }
  function isOutsidePreview(stage, layer) {
    const stageRect = stage.getBoundingClientRect();
    const rect = visualRect(layer);
    return !rect || rect.right < stageRect.left || rect.left > stageRect.right || rect.bottom < stageRect.top || rect.top > stageRect.bottom;
  }
  function intersectsPlacement(layer) {
    const rect = visualRect(layer);
    const layerRect = layer.getBoundingClientRect();
    if (!rect || !layerRect) return false;
    const overlapX = Math.min(rect.right, layerRect.right) - Math.max(rect.left, layerRect.left);
    const overlapY = Math.min(rect.bottom, layerRect.bottom) - Math.max(rect.top, layerRect.top);
    return overlapX > 1 && overlapY > 1;
  }
  function startPreviewEdit(instance, stage, layer, event, action) {
    event.preventDefault();
    try { layer.setPointerCapture?.(event.pointerId); } catch {}
    instance.state.activeEdit = layer.dataset.editId;
    stage.querySelectorAll(".amzcustom-layer.is-active-edit").forEach((item)=>item.classList.remove("is-active-edit"));
    layer.classList.add("is-active-edit");
    const [type,id]=layer.dataset.editId.split(":");
    const start={x:event.clientX,y:event.clientY};
    const rect=layer.getBoundingClientRect();
    const box=layer.querySelector(".amzcustom-edit-box") || layer.querySelector(".amzcustom-transform-box");
    const boxRect=box.getBoundingClientRect();
    const bucket=type==="image"?instance.state.imageTransforms:instance.state.textTransforms;
    const original={x:0,y:0,scale:1,rotation:0,...(bucket[id]||{})};
    const center={x:boxRect.left+boxRect.width/2,y:boxRect.top+boxRect.height/2};
    const startDistance=Math.hypot(start.x-center.x,start.y-center.y)||1;
    const startAngle=Math.atan2(start.y-center.y,start.x-center.x)*180/Math.PI;
    let syncFrame = 0;
    const scheduleSync = () => {
      if (syncFrame) return;
      syncFrame = requestAnimationFrame(() => { syncFrame = 0; syncEditBox(layer); });
    };
    const moveBase = type === "image" ? (layer.querySelector("img")?.getBoundingClientRect() || boxRect) : boxRect;
    const move=(next)=>{ if (action==="resize") { const distance=Math.hypot(next.clientX-center.x,next.clientY-center.y)||1; bucket[id]={...original,scale:clamp(original.scale*distance/startDistance,.3,4)}; } else if (action==="rotate") { const angle=Math.atan2(next.clientY-center.y,next.clientX-center.x)*180/Math.PI; bucket[id]={...original,rotation:Math.round(original.rotation+angle-startAngle)}; } else { const dx=(next.clientX-start.x)/Math.max(1,moveBase.width)*100, dy=(next.clientY-start.y)/Math.max(1,moveBase.height)*100; const limit=100000; bucket[id]={...original,x:clamp(original.x+dx,-limit,limit),y:clamp(original.y+dy,-limit,limit)}; } layer.querySelectorAll(".amzcustom-transform-box").forEach((item)=>{ item.style.transform=transformStyle(bucket[id]); }); scheduleSync();};
    const up=(next)=>{window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up);try { layer.releasePointerCapture?.(next.pointerId); } catch {} if(syncFrame) cancelAnimationFrame(syncFrame); if(type==="image" && action==="move" && (isOutsidePreview(stage, layer) || !intersectsPlacement(layer))) bucket[id]={x:0,y:0,scale:1,rotation:0}; renderPreview(instance);};
    window.addEventListener("pointermove",move);window.addEventListener("pointerup",up);
  }
  function controlHeader(item, value) {
    const suffix = value ? `: <strong>${escapeHtml(value)}</strong>` : "";
    const help = visibleInstructions(item.instructions);
    const helpButton = help ? `<button type="button" class="amzcustom-help-trigger" data-help="${escapeHtml(help)}" aria-label="${escapeHtml(help)}"></button>` : "";
    return `<div class="amzcustom-title"><span>${escapeHtml(item.label)}<span class="amzcustom-title-value">${suffix}</span></span>${helpButton}${item.required ? "" : '<em>(optional)</em>'}</div>${value ? `<div class="amzcustom-selected">Selected: <strong>${escapeHtml(value)}</strong></div>` : ""}`;
  }
  function visibleInstructions(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    const hidden = [
      "Please check the spelling carefully.",
      "'Why pay for shipping twice? Add the matching Pillow to your order now, complete the look, and save time & money.'",
      "Why pay for shipping twice? Add the matching Pillow to your order now, complete the look, and save time & money.",
      "If you don't fill it out, we'll make it according to the Amazon page time.",
      "Why pay for shipping twice? Add the matching tapestry to your order now, complete the look, and save time & money."
    ].map((item) => item.replace(/\s+/g, " ").trim());
    return hidden.includes(text) ? "" : text;
  }
  function isYesNoGroup(item) {
    const labels = (item.options || []).map((option) => String(option.label || "").trim().toUpperCase()).sort();
    return labels.length === 2 && labels[0] === "NO" && labels[1] === "YES";
  }
  function isInlineChoiceGroup(item) {
    const options = item.options || [];
    return options.length > 0 && options.length <= 3 && options.every((option) => !option.thumbnailImage && !option.overlayImage && !option.cost);
  }
  function isSizeChoiceGroup(item) {
    return /\bsize\b/i.test(String(item.label || ""));
  }
  function isTextChoiceGroup(item) {
    const label = String(item.label || "");
    return /(?:matching|tapestry|pillow|purchase)/i.test(label) && !isYesNoGroup(item);
  }
  function fontDropdownHtml(state, item) {
    const options = Array.isArray(item.options) ? item.options : [];
    const selected = options.find((font) => font.id === state.fonts[item.id]) || options[0] || {};
    return `<details class="amzcustom-font-dropdown"><summary style="font-family:${escapeHtml(cssFontFamily(selected.family || "Arial"))}"><span>${escapeHtml(selected.family || "Select font")}</span></summary><div class="amzcustom-fonts">${options.map((font) => { ensureFontLoaded(font); return `<button type="button" class="amzcustom-font ${state.fonts[item.id] === font.id ? "is-selected" : ""}" data-font="${escapeHtml(font.id)}" style="font-family:${escapeHtml(cssFontFamily(font.family))}">${escapeHtml(font.family)}</button>`; }).join("")}</div></details>`;
  }
  function imageActionButton(action, label, icon) {
    const icons = {
      edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
      done: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
      replace: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8 12 3 7 8"/><path d="M12 3v12"/></svg>',
      delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 15H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>'
    };
    return `<button type="button" data-image-action="${escapeHtml(action)}">${icons[icon] || ""}<span>${escapeHtml(label)}</span></button>`;
  }
  function uploadButtonHtml() {
    return `<button type="button" class="amzcustom-upload-button" data-image-action="replace"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8 12 3 7 8"/><path d="M12 3v12"/></svg><span>Upload</span></button>`;
  }
  function imageUploadStatusHtml(image) {
    const status = image?.uploadStatus || "";
    if (status === "uploading") return '<div class="amzcustom-meta"><span>Uploading image...</span></div>';
    if (status === "uploaded") return '<div class="amzcustom-meta"><span>Image uploaded</span></div>';
    if (status === "failed") return `<div class="amzcustom-meta"><span>${escapeHtml(image.uploadError || "Upload failed. We will retry when you add to cart.")}</span></div>`;
    return "";
  }
  function optionChoicesHtml(instance, state, item) {
    item.options = Array.isArray(item.options) ? item.options : [];
    const isMobile = window.matchMedia && window.matchMedia("(max-width: 760px)").matches;
    const shouldCollapse = !isMobile && item.options.length > COLLAPSED_OPTION_LIMIT;
    const expanded = state.expandedOptionGroups[item.id] === true;
    const promotedOption = item.options.find((option) => option.id === state.promotedOptionIds[item.id]);
    const primaryOptions = shouldCollapse
      ? [...(promotedOption ? [promotedOption] : []), ...item.options.filter((option) => option.id !== promotedOption?.id)].slice(0, COLLAPSED_OPTION_LIMIT)
      : item.options;
    const visibleOptions = shouldCollapse ? primaryOptions : item.options;
    const optionItems = !item.required ? [{ id: "", label: "No selection", cost: 0, noSelection: true }, ...visibleOptions] : visibleOptions;
    const choices = optionItems.map((option) => {
      const img = option.thumbnailImage || option.overlayImage;
      return `<button type="button" class="amzcustom-choice ${state.options[item.id] === option.id ? "is-selected" : ""} ${option.outOfStock ? "is-out" : ""}" data-option="${escapeHtml(option.id)}" data-option-source="primary" ${option.outOfStock ? "disabled" : ""}>${img ? `<img src="${escapeHtml(img.url)}" alt="">` : `<span class="amzcustom-stock-icon"></span>`}<span>${escapeHtml(option.label)}</span>${option.outOfStock ? "<small>Out of stock</small>" : option.cost ? `<small>+${formatMoney(option.cost, instance)}</small>` : ""}</button>`;
    }).join("");
    const toggle = shouldCollapse ? `<button type="button" class="amzcustom-options-toggle" data-options-toggle="${escapeHtml(item.id)}">${expanded ? "See less" : `See all ${item.options.length} options`}</button>` : "";
    const primaryIds = new Set(primaryOptions.map((option) => option.id));
    const overflowOptions = shouldCollapse ? item.options.filter((option) => !primaryIds.has(option.id)) : [];
    const overflow = shouldCollapse && expanded ? `<div class="amzcustom-options-list">${overflowOptions.map((option) => { const img = option.thumbnailImage || option.overlayImage; return `<button type="button" class="amzcustom-option-row ${state.options[item.id] === option.id ? "is-selected" : ""} ${option.outOfStock ? "is-out" : ""}" data-option="${escapeHtml(option.id)}" data-option-source="overflow" ${option.outOfStock ? "disabled" : ""}>${img ? `<img src="${escapeHtml(img.url)}" alt="">` : `<span class="amzcustom-row-icon"></span>`}<span>${escapeHtml(option.label)}</span></button>`; }).join("")}</div>` : "";
    return `<div class="amzcustom-choices ${isYesNoGroup(item) ? "is-yes-no" : ""} ${isInlineChoiceGroup(item) ? "is-inline-choice" : ""} ${isSizeChoiceGroup(item) ? "is-size-choice" : ""} ${isTextChoiceGroup(item) ? "is-text-choice" : ""} ${shouldCollapse ? "is-collapsed" : ""} ${expanded ? "is-expanded" : ""}">${choices}</div>${toggle}${overflow}`;
  }
  function controlHtml(instance, type, item) {
    if (!visible(instance, item)) return "";
    const state = instance.state;
    if (type === "option") {
      item.options = Array.isArray(item.options) ? item.options : [];
      const hasImages = item.options.some((option) => option.thumbnailImage || option.overlayImage);
      const selectedValue = item.options.find((option) => option.id === state.options[item.id])?.label || "";
      if (item.displayHint === "choice-grid" || hasImages || isYesNoGroup(item) || isSizeChoiceGroup(item) || isTextChoiceGroup(item) || isInlineChoiceGroup(item)) return `<section class="amzcustom-control ${state.errors[item.id] ? "is-invalid" : ""}" data-id="${item.id}">${controlHeader(item, selectedValue)}${optionChoicesHtml(instance, state, item)}<span class="amzcustom-error">${escapeHtml(state.errors[item.id] || "")}</span></section>`;
      return `<section class="amzcustom-control ${state.errors[item.id] ? "is-invalid" : ""}" data-id="${item.id}">${controlHeader(item, selectedValue)}<select>${!item.required ? '<option value="">No selection</option>' : ""}${item.options.map((option) => `<option value="${escapeHtml(option.id)}" ${state.options[item.id] === option.id ? "selected" : ""} ${option.outOfStock ? "disabled" : ""}>${escapeHtml(option.label)}${option.outOfStock ? " - Out of stock" : option.cost ? ` (+${formatMoney(option.cost, instance)})` : ""}</option>`).join("")}</select><span class="amzcustom-error">${escapeHtml(state.errors[item.id] || "")}</span></section>`;
    }
    if (type === "text") {
      const value = state.texts[item.id] || "";
      return `<section class="amzcustom-control ${state.errors[item.id] ? "is-invalid" : ""}" data-id="${item.id}">${controlHeader(item)}${item.maxLines > 1 ? `<textarea maxlength="${item.maxLength || ""}" rows="${Math.min(item.maxLines || 3, 5)}">${escapeHtml(value)}</textarea>` : `<input type="text" maxlength="${item.maxLength || ""}" value="${escapeHtml(value)}" placeholder="${escapeHtml(item.placeholder || "")}">`}<div class="amzcustom-meta"><span>${value.length}${item.maxLength ? `/${item.maxLength}` : ""}</span></div><span class="amzcustom-error">${escapeHtml(state.errors[item.id] || "")}</span></section>`;
    }
    if (type === "image") { const active = state.activeEdit === `image:${item.id}`; return `<section class="amzcustom-control ${active ? "is-editing" : ""} ${state.errors[item.id] ? "is-invalid" : ""}" data-id="${item.id}">${controlHeader(item)}<input class="amzcustom-file is-hidden" type="file" accept="image/png,image/jpeg,image/webp">${state.images[item.id] ? `<div class="amzcustom-upload-row"><img src="${escapeHtml(state.images[item.id].dataUrl)}" alt=""><div class="amzcustom-actions">${imageActionButton(active ? "done" : "edit", active ? "Done" : "Edit", active ? "done" : "edit")}${imageActionButton("replace", "Replace", "replace")}${imageActionButton("delete", "Delete", "delete")}</div></div>${imageUploadStatusHtml(state.images[item.id])}` : uploadButtonHtml()}<span class="amzcustom-error">${escapeHtml(state.errors[item.id] || "")}</span></section>`; }
    if (type === "font") return `<section class="amzcustom-control" data-id="${item.id}">${controlHeader(item)}${fontDropdownHtml(state, item)}</section>`;
    if (type === "color") { const options = Array.isArray(item.options) ? item.options : []; return `<section class="amzcustom-control" data-id="${item.id}">${controlHeader(item)}<div class="amzcustom-swatches">${options.map((color) => `<button type="button" class="amzcustom-swatch ${state.colors[item.id] === color.id ? "is-selected" : ""}" data-color="${escapeHtml(color.id)}" style="--swatch:${escapeHtml(color.value || "#fff")}" title="${escapeHtml(color.name)}"><span>${escapeHtml(color.name)}</span></button>`).join("")}</div></section>`; }
    return "";
  }
  function captureScrollState(instance) {
    const dialog = q(instance.modal, ".amzcustom-dialog");
    const active = document.activeElement?.closest?.("[data-id]");
    const activeId = active?.dataset.id || "";
    const choices = activeId ? q(instance.modal, `[data-id="${CSS.escape(activeId)}"] .amzcustom-choices`) : null;
    const choicesById = {};
    q(instance.modal, ".amzcustom-controls")?.querySelectorAll(".amzcustom-control[data-id] .amzcustom-choices").forEach((item) => {
      const id = item.closest(".amzcustom-control")?.dataset.id;
      if (id) choicesById[id] = item.scrollLeft;
    });
    return {
      dialog,
      dialogScrollTop: dialog ? dialog.scrollTop : 0,
      windowX: window.scrollX,
      windowY: window.scrollY,
      activeId,
      choicesScrollLeft: choices ? choices.scrollLeft : null,
      choicesById,
    };
  }
  function restoreScrollState(instance, state) {
    if (!state) return;
    const dialog = q(instance.modal, ".amzcustom-dialog") || state.dialog;
    if (dialog) dialog.scrollTop = state.dialogScrollTop;
    if (state.choicesScrollLeft != null && state.activeId) {
      const choices = q(instance.modal, `[data-id="${CSS.escape(state.activeId)}"] .amzcustom-choices`);
      if (choices) choices.scrollLeft = state.choicesScrollLeft;
    }
    for (const [id, scrollLeft] of Object.entries(state.choicesById || {})) {
      const choices = q(instance.modal, `[data-id="${CSS.escape(id)}"] .amzcustom-choices`);
      if (choices) choices.scrollLeft = scrollLeft;
    }
    window.scrollTo(state.windowX, state.windowY);
  }
  function scheduleScrollRestore(instance, state) {
    restoreScrollState(instance, state);
    requestAnimationFrame(() => {
      restoreScrollState(instance, state);
      setTimeout(() => restoreScrollState(instance, state), 0);
    });
  }
  function renderControls(instance, options = {}) {
    const preserveScroll = options.preserveScroll !== false;
    const scrollState = preserveScroll ? captureScrollState(instance) : null;
    evaluate(instance);
    const maps = { option:new Map(instance.config.optionGroups.map((x)=>[x.id,x])), text:new Map(instance.config.textInputs.map((x)=>[x.id,x])), image:new Map(instance.config.imageInputs.map((x)=>[x.id,x])), font:new Map(instance.config.fontGroups.map((x)=>[x.id,x])), color:new Map(instance.config.colorGroups.map((x)=>[x.id,x])) };
    const seen = new Set();
    let html = "";
    for (const entry of instance.config.controlOrder || []) {
      const item = maps[entry.type]?.get(entry.id);
      const key = `${entry.type}:${entry.id}`;
      if (item && !seen.has(key)) { html += controlHtml(instance, entry.type, item); seen.add(key); }
    }
    for (const type of ["option", "text", "image", "font", "color"]) for (const item of maps[type].values()) {
      const key = `${type}:${item.id}`;
      if (!seen.has(key)) html += controlHtml(instance, type, item);
    }
    q(instance.modal, ".amzcustom-controls").innerHTML = html;
    bindControls(instance); renderPreview(instance); requestAnimationFrame(() => positionOptionLists(instance));
    if (preserveScroll && scrollState) {
      scheduleScrollRestore(instance, scrollState);
    }
  }
  function positionOptionLists(instance) {
    const dialog = q(instance.modal, ".amzcustom-dialog");
    if (!dialog) return;
    const dialogRect = dialog.getBoundingClientRect();
    const headHeight = q(instance.modal, ".amzcustom-head")?.getBoundingClientRect().height || 0;
    const footHeight = q(instance.modal, ".amzcustom-foot")?.getBoundingClientRect().height || 0;
    q(instance.modal, ".amzcustom-controls")?.querySelectorAll(".amzcustom-options-list").forEach((list) => {
      const control = list.closest(".amzcustom-control");
      const toggle = control?.querySelector("[data-options-toggle]");
      if (!control || !toggle) return;
      list.classList.remove("is-above", "is-below");
      list.style.top = "";
      list.style.bottom = "";
      list.style.maxHeight = "";
      const toggleRect = toggle.getBoundingClientRect();
      const availableBelow = dialogRect.bottom - footHeight - toggleRect.bottom - 12;
      const availableAbove = toggleRect.top - dialogRect.top - headHeight - 12;
      const useBelow = availableBelow >= 220 || availableBelow >= availableAbove;
      const available = Math.max(96, useBelow ? availableBelow : availableAbove);
      list.style.maxHeight = `${Math.min(420, available)}px`;
      if (useBelow) {
        list.classList.add("is-below");
        list.style.top = `${toggle.offsetTop + toggle.offsetHeight + 6}px`;
      } else {
        list.classList.add("is-above");
        list.style.bottom = `${control.offsetHeight - toggle.offsetTop + 6}px`;
      }
    });
  }
  function hideHelpTips(root) {
    root.querySelectorAll(".amzcustom-help-trigger.is-open").forEach((item) => item.classList.remove("is-open", "is-above", "is-below"));
  }
  function usesHoverHelp() {
    return window.matchMedia?.("(hover: hover) and (pointer: fine)")?.matches;
  }
  function showHelpTip(root, trigger) {
    hideHelpTips(root);
    trigger.classList.add("is-open");
    positionHelpTip(trigger);
  }
  function positionHelpTip(trigger) {
    const text = trigger.dataset.help || "";
    if (!text) return;
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(360, window.innerWidth - margin * 2);
    const lineCount = Math.ceil(text.length / 42);
    const estimatedHeight = Math.min(180, Math.max(52, lineCount * 18 + 26));
    const showBelow = rect.bottom + estimatedHeight + 14 <= window.innerHeight || rect.top < estimatedHeight + 14;
    const left = clamp(rect.left + rect.width / 2 - width / 2, margin, window.innerWidth - width - margin);
    const top = showBelow ? rect.bottom + 10 : clamp(rect.top - estimatedHeight - 10, margin, window.innerHeight - estimatedHeight - margin);
    trigger.style.setProperty("--help-left", `${left}px`);
    trigger.style.setProperty("--help-top", `${top}px`);
    trigger.style.setProperty("--help-width", `${width}px`);
    trigger.classList.toggle("is-below", showBelow);
    trigger.classList.toggle("is-above", !showBelow);
  }
  function fileData(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = reject; reader.onload = () => { const image = new Image(); image.onload = () => resolve({ file, dataUrl: reader.result, width: image.naturalWidth || 1, height: image.naturalHeight || 1 }); image.onerror = () => resolve({ file, dataUrl: reader.result, width: 1, height: 1 }); image.src = reader.result; }; reader.readAsDataURL(file); }); }
  function bindControls(instance) {
    if (instance.controlsBound) return;
    instance.controlsBound = true;
    const controls = q(instance.modal, ".amzcustom-controls");
    controls.addEventListener("pointerover", (event) => {
      if (!usesHoverHelp()) return;
      const helpTrigger = event.target.closest(".amzcustom-help-trigger");
      if (helpTrigger) showHelpTip(instance.modal, helpTrigger);
    });
    controls.addEventListener("pointerout", (event) => {
      if (!usesHoverHelp()) return;
      const helpTrigger = event.target.closest(".amzcustom-help-trigger");
      if (helpTrigger && !helpTrigger.contains(event.relatedTarget)) hideHelpTips(instance.modal);
    });
    controls.addEventListener("focusin", (event) => {
      const helpTrigger = event.target.closest(".amzcustom-help-trigger");
      if (helpTrigger) showHelpTip(instance.modal, helpTrigger);
    });
    controls.addEventListener("focusout", (event) => {
      const helpTrigger = event.target.closest(".amzcustom-help-trigger");
      if (helpTrigger && !helpTrigger.contains(event.relatedTarget)) hideHelpTips(instance.modal);
    });
    controls.addEventListener("click", (event) => {
      const helpTrigger = event.target.closest(".amzcustom-help-trigger");
      if (helpTrigger) {
        if (usesHoverHelp()) return;
        const wasOpen = helpTrigger.classList.contains("is-open");
        hideHelpTips(instance.modal);
        if (!wasOpen) {
          showHelpTip(instance.modal, helpTrigger);
        }
        return;
      }
      if (!event.target.closest(".amzcustom-help-trigger")) hideHelpTips(instance.modal);
      const optionsToggle = event.target.closest("[data-options-toggle]");
      if (optionsToggle) {
        const id = optionsToggle.dataset.optionsToggle;
        const dialog = q(instance.modal, ".amzcustom-dialog");
        const scrollTop = dialog ? dialog.scrollTop : null;
        instance.state.expandedOptionGroups[id] = !instance.state.expandedOptionGroups[id];
        renderControls(instance);
        if (scrollTop != null) requestAnimationFrame(() => {
          dialog.scrollTop = scrollTop;
          positionOptionLists(instance);
          setTimeout(() => { dialog.scrollTop = scrollTop; positionOptionLists(instance); }, 0);
        });
        return;
      }
      const option = event.target.closest("[data-option]"), font = event.target.closest("[data-font]"), color = event.target.closest("[data-color]");
      const imageAction = event.target.closest("[data-image-action]"), layerAction = event.target.closest("[data-layer-action]");
      if (imageAction) {
        const id = imageAction.closest("[data-id]").dataset.id;
        if (imageAction.dataset.imageAction === "edit") return openImageEditor(instance, id);
        if (imageAction.dataset.imageAction === "done") return endEdit(instance);
        if (imageAction.dataset.imageAction === "replace") return triggerFileInput(imageAction.closest("[data-id]"));
        if (imageAction.dataset.imageAction === "delete") { delete instance.state.images[id]; delete instance.state.imageTransforms[id]; if (instance.state.activeEdit === `image:${id}`) instance.state.activeEdit = ""; }
        renderControls(instance); return;
      }
      if (layerAction) {
        const layer = layerAction.closest("[data-edit-id]"), [type,id] = layer.dataset.editId.split(":");
        if (layerAction.dataset.layerAction === "done") return endEdit(instance);
        if (layerAction.dataset.layerAction === "delete") { if (type === "image") { delete instance.state.images[id]; delete instance.state.imageTransforms[id]; } else { instance.state.texts[id] = ""; delete instance.state.textTransforms[id]; } instance.state.activeEdit = ""; renderControls(instance); }
        if (layerAction.dataset.layerAction === "replace") return triggerFileInput(q(instance.modal, `[data-id="${CSS.escape(id)}"]`));
        return;
      }
      const button = option || font || color; if (!button) return;
      const id = button.closest("[data-id]").dataset.id;
      if (option && !option.disabled) {
        instance.state.options[id] = option.dataset.option;
        if (option.dataset.optionSource === "overflow") {
          instance.state.promotedOptionIds[id] = option.dataset.option;
          instance.state.expandedOptionGroups[id] = false;
        } else delete instance.state.promotedOptionIds[id];
      }
      if (font) {
        instance.state.fonts[id] = font.dataset.font;
        const group = instance.config.fontGroups.find((item) => item.id === id);
        ensureFontLoaded((Array.isArray(group?.options) ? group.options : []).find((item) => item.id === font.dataset.font));
        scheduleFontReadyRender(instance);
      }
      if (color) instance.state.colors[id] = color.dataset.color;
      const dialog = q(instance.modal, ".amzcustom-dialog");
      const scrollTop = option && dialog ? dialog.scrollTop : null;
      const optionGroup = option?.closest("[data-id]");
      const choices = optionGroup?.querySelector(".amzcustom-choices");
      const optionScrollLeft = choices ? choices.scrollLeft : null;
      renderControls(instance);
      if (scrollTop != null) requestAnimationFrame(() => {
        dialog.scrollTop = scrollTop;
        if (optionScrollLeft != null && optionGroup) {
          const nextChoices = q(instance.modal, `[data-id="${CSS.escape(id)}"] .amzcustom-choices`);
          if (nextChoices) nextChoices.scrollLeft = optionScrollLeft;
        }
        setTimeout(() => {
          dialog.scrollTop = scrollTop;
          if (optionScrollLeft != null && optionGroup) {
            const nextChoices = q(instance.modal, `[data-id="${CSS.escape(id)}"] .amzcustom-choices`);
            if (nextChoices) nextChoices.scrollLeft = optionScrollLeft;
          }
        }, 0);
      });
    });
    q(instance.modal, ".amzcustom-controls").addEventListener("input", async (event) => {
      const group = event.target.closest("[data-id]"); if (!group) return; const id = group.dataset.id;
      const textInput = instance.config.textInputs.find((x)=>x.id===id);
      if (event.target.matches('input[type="text"],textarea')) { instance.state.texts[id] = normalizeText(event.target.value, textInput || {}); event.target.value = instance.state.texts[id]; const meta=group.querySelector(".amzcustom-meta span"); if(meta) meta.textContent = `${instance.state.texts[id].length}${textInput?.maxLength ? `/${textInput.maxLength}` : ""}`; evaluate(instance); renderPreview(instance); return; }
      if (event.target.matches('input[type="file"]') && event.target.files[0]) {
        instance.state.images[id] = await fileData(event.target.files[0]);
        instance.state.images[id].uploadStatus = "queued";
        instance.state.images[id].uploadPromise = null;
        instance.state.images[id].uploadedFile = null;
        instance.state.images[id].uploadError = "";
        instance.state.imageTransforms[id] = { x:0, y:0, scale:1, rotation:0 };
        if (instance.state.activeEdit === `image:${id}`) instance.state.activeEdit = "";
        evaluate(instance);
        renderControls(instance);
        startBackgroundUpload(instance, id).catch(() => renderControls(instance));
        return;
      }
      if (event.target.matches("select")) { if (instance.config.optionGroups.some((x)=>x.id===id)) instance.state.options[id] = event.target.value; else if (instance.config.fontGroups.some((x)=>x.id===id)) { instance.state.fonts[id] = event.target.value; const group = instance.config.fontGroups.find((x)=>x.id===id); ensureFontLoaded((Array.isArray(group?.options) ? group.options : []).find((item)=>item.id===event.target.value)); } else instance.state.colors[id] = event.target.value; }
      evaluate(instance); renderControls(instance);
    });
  }
  function validate(instance) {
    const errors = {};
    for (const group of instance.config.optionGroups) if (visible(instance, group) && group.required && !instance.state.options[group.id]) errors[group.id] = "Vui lòng chọn một tùy chọn.";
    for (const input of instance.config.textInputs) {
      const value = instance.state.texts[input.id] || "";
      if (!visible(instance,input)) continue;
      if (input.required && !value.trim()) errors[input.id] = "This field is required.";
      else if (value && value.length < input.minLength) errors[input.id] = `Enter at least ${input.minLength} characters.`;
      else if (value && input.regexChoice && instance.config.regexChoices?.[input.regexChoice]?.pattern) {
        try { if (!new RegExp(`^(?:${instance.config.regexChoices[input.regexChoice].pattern})$`).test(value)) errors[input.id] = instance.config.regexChoices[input.regexChoice].instructions || "Use only supported characters."; } catch {}
      }
    }
    for (const input of instance.config.imageInputs) if (visible(instance,input) && input.required && !instance.state.images[input.id]) errors[input.id] = "Bắt buộc tải ảnh.";
    instance.state.errors = errors;
    stageLog("Validation result", {
      errorIds: Object.keys(errors),
      firstErrorId: Object.keys(errors)[0] || null
    });
    return !Object.keys(errors).length;
  }
  function scrollToFirstError(instance) {
    const firstErrorId = Object.keys(instance.state.errors || {})[0];
    if (!firstErrorId) {
      stageLog("Scroll to first error skipped", { reason: "no_errors" });
      return;
    }
    requestAnimationFrame(() => {
      const control = q(instance.modal, `[data-id="${CSS.escape(firstErrorId)}"]`);
      const dialog = q(instance.modal, ".amzcustom-dialog");
      if (!control) {
        stageLog("Scroll to first error failed", {
          firstErrorId,
          reason: "control_not_found"
        });
        return;
      }
      if (dialog) {
        const headHeight = q(instance.modal, ".amzcustom-head")?.getBoundingClientRect().height || 0;
        const footHeight = q(instance.modal, ".amzcustom-foot")?.getBoundingClientRect().height || 0;
        const dialogRect = dialog.getBoundingClientRect();
        const controlRect = control.getBoundingClientRect();
        const currentScroll = dialog.scrollTop;
        const topInDialog = controlRect.top - dialogRect.top + currentScroll;
        const targetScroll = Math.max(0, topInDialog - headHeight - 20);
        const visibleTop = currentScroll + headHeight;
        const visibleBottom = currentScroll + dialog.clientHeight - footHeight;
        const controlTop = topInDialog;
        const controlBottom = topInDialog + controlRect.height;
        const needsScroll = controlTop < visibleTop || controlBottom > visibleBottom;
        stageLog("Scroll to first error metrics", {
          firstErrorId,
          currentScroll,
          targetScroll,
          headHeight,
          footHeight,
          dialogClientHeight: dialog.clientHeight,
          controlTop,
          controlBottom,
          visibleTop,
          visibleBottom,
          needsScroll
        });
        if (needsScroll) {
          dialog.scrollTo({ top: targetScroll, behavior: "smooth" });
          requestAnimationFrame(() => {
            stageLog("Scroll to first error after scroll", {
              firstErrorId,
              scrollTopAfter: dialog.scrollTop
            });
          });
        }
      } else {
        stageLog("Scroll to first error failed", {
          firstErrorId,
          reason: "dialog_not_found"
        });
      }
      const field = control.querySelector("input:not([type='file']), textarea, select, button, .amzcustom-upload-button");
      stageLog("Scroll to first error focus target", {
        firstErrorId,
        fieldTag: field?.tagName || null,
        fieldType: field?.getAttribute?.("type") || null
      });
      field?.focus?.({ preventScroll: true });
    });
  }
  async function upload(instance, file, label = "asset") {
    if (!instance.root.dataset.uploadUrl) throw new Error("Theme block chưa cấu hình upload URL.");
    const startedAt = nowMs();
    stageLog(`Upload started: ${label}`, {
      mimeType: file?.type || "unknown",
      bytesApprox: Number(file?.size || 0)
    });
    const prepareResponse = await fetch(instance.root.dataset.uploadUrl, {
      method:"POST",
      headers:{ "content-type":"application/json" },
      body:JSON.stringify({ action: "prepare", mimeType: file?.type, fileSize: Number(file?.size || 0) })
    });
    const prepareJson = await prepareResponse.json();
    if (!prepareResponse.ok || !prepareJson.ok) throw new Error(prepareJson.error || "Upload preparation failed");
    const upload = prepareJson.upload || {};
    const form = new FormData();
    for (const parameter of upload.parameters || []) form.append(parameter.name, parameter.value);
    form.append("file", file, upload.filename || file.name || "upload.bin");
    const stagedResponse = await fetch(upload.url, { method: "POST", body: form });
    if (!stagedResponse.ok) throw new Error(`Staged upload failed: HTTP ${stagedResponse.status}`);
    const response = await fetch(instance.root.dataset.uploadUrl, {
      method:"POST",
      headers:{ "content-type":"application/json" },
      body:JSON.stringify({ action: "complete", resourceUrl: upload.resourceUrl, filename: upload.filename, mimeType: upload.mimeType || file?.type })
    });
    const json = await response.json();
    if (!response.ok || !json.ok) throw new Error(json.error || "Upload thất bại");
    stageLog(`Upload completed: ${label}`, {
      elapsedSeconds: secondsSince(startedAt),
      fileId: json.file?.id,
      filename: json.file?.filename
    });
    return json.file;
  }
  async function startBackgroundUpload(instance, id) {
    const image = instance.state.images[id];
    if (!image?.file) return null;
    if (image.uploadedFile) return image.uploadedFile;
    if (image.uploadPromise) return image.uploadPromise;
    const token = crypto.randomUUID();
    image.uploadToken = token;
    image.uploadStatus = "uploading";
    image.uploadError = "";
    const promise = upload(instance, image.file, `custom image:${id}`).then((file) => {
      const current = instance.state.images[id];
      if (!current || current.uploadToken !== token) return file;
      current.uploadPromise = null;
      current.uploadStatus = "uploaded";
      current.uploadedFile = file;
      current.uploadError = "";
      return file;
    }).catch((error) => {
      const current = instance.state.images[id];
      if (current && current.uploadToken === token) {
        current.uploadPromise = null;
        current.uploadStatus = "failed";
        current.uploadError = error.message || "Upload failed";
      }
      throw error;
    });
    image.uploadPromise = promise;
    renderControls(instance);
    return promise;
  }
  async function loadCanvasImage(url) {
    const key = String(url || "");
    if (!key) throw new Error("Không có URL preview asset.");
    if (!canvasImageCache.has(key)) {
      canvasImageCache.set(key, (async () => {
        const response = await fetch(key);
        if (!response.ok) throw new Error(`Không tải được preview asset (${response.status}).`);
        const objectUrl = URL.createObjectURL(await response.blob());
        try {
          return await new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => {
              resolve(image);
            };
            image.onerror = (err) => {
              reject(err);
            };
            image.src = objectUrl;
          });
        } finally {
          setTimeout(()=>URL.revokeObjectURL(objectUrl),0);
        }
      })().catch((error) => {
        canvasImageCache.delete(key);
        throw error;
      }));
    }
    return canvasImageCache.get(key);
  }
  function rectToCanvas(stageRect, targetRect, size) {
    return {
      x: (targetRect.left - stageRect.left) / stageRect.width * size,
      y: (targetRect.top - stageRect.top) / stageRect.height * size,
      width: targetRect.width / stageRect.width * size,
      height: targetRect.height / stageRect.height * size,
    };
  }
  function rectToRatio(stageRect, targetRect) {
    return {
      x: (targetRect.left - stageRect.left) / stageRect.width,
      y: (targetRect.top - stageRect.top) / stageRect.height,
      width: targetRect.width / stageRect.width,
      height: targetRect.height / stageRect.height,
    };
  }
  function toBase64Unicode(value) {
    return btoa(unescape(encodeURIComponent(String(value || ""))));
  }
  function chunkString(value, size) {
    const chunks = [];
    for (let index = 0; index < value.length; index += size) chunks.push(value.slice(index, index + size));
    return chunks;
  }
  function buildPreviewModel(instance, uploadedImages) {
    const stage = q(instance.modal, ".amzcustom-stage");
    if (!stage) return null;
    const stageRect = stage.getBoundingClientRect();
    if (!stageRect.width || !stageRect.height) return null;
    const layers = [];
    for (const child of stage.children) {
      if (child.tagName === "IMG") {
        layers.push({
          type: "image",
          src: child.currentSrc || child.src,
          rect: rectToRatio(stageRect, child.getBoundingClientRect())
        });
        continue;
      }
      const editId = child.dataset.editId || "";
      const imageId = editId.startsWith("image:") ? editId.split(":")[1] : "";
      const inner = child.querySelector(".amzcustom-transform-box img");
      if (inner) {
        const uploaded = imageId ? uploadedImages[imageId] : null;
        layers.push({
          type: "clipped-image",
          src: uploaded?.url || inner.currentSrc || inner.src,
          clipRect: rectToRatio(stageRect, (child.querySelector(".amzcustom-clip") || child).getBoundingClientRect()),
          imageRect: rectToRatio(stageRect, inner.getBoundingClientRect())
        });
        continue;
      }
      const textNode = child.querySelector(".amzcustom-transform-box span") || child.querySelector("span") || child;
      const textBox = child.querySelector(".amzcustom-transform-box") || child;
      const style = getComputedStyle(child);
      layers.push({
        type: "text",
        text: textNode.textContent || "",
        rect: rectToRatio(stageRect, textBox.getBoundingClientRect()),
        color: style.color || "#000000",
        fontFamily: child.dataset.fontFamily || style.fontFamily || "Arial",
        fontUrl: child.dataset.fontUrl || "",
        fontType: child.dataset.fontType || "",
        fontSizeRatio: (parseFloat(style.fontSize) || 16) / stageRect.width,
        lineHeightRatio: ((parseFloat(style.fontSize) || 16) * 1.18) / stageRect.height,
        singleLine: child.classList.contains("is-single-line")
      });
    }
    return {
      width: Math.round(stageRect.width),
      height: Math.round(stageRect.height),
      background: "#ffffff",
      layers
    };
  }
  function buildCustomizationPayload(instance, customizationId, uploadedImages) {
    return {
      customizationId,
      schemaVersion: instance.config.schemaVersion,
      productId: instance.root.dataset.productId,
      variantId: currentVariantId(instance),
      createdAt: new Date().toISOString(),
      surcharge: surcharge(instance),
      previewModel: buildPreviewModel(instance, uploadedImages),
      selections: {
        options: instance.state.options,
        texts: instance.state.texts,
        fonts: instance.state.fonts,
        colors: instance.state.colors,
        images: uploadedImages,
        imageTransforms: instance.state.imageTransforms,
        textTransforms: instance.state.textTransforms,
        placementOffsets: instance.state.placementOffsets
      }
    };
  }
  function visibleCustomizationProperties(instance, uploadedImages) {
    const properties = {};
    for (const group of instance.config.optionGroups || []) {
      if (!visible(instance, group)) continue;
      const selectedId = instance.state.options[group.id];
      if (!selectedId) continue;
      const option = (group.options || []).find((item) => item.id === selectedId);
      const value = option?.label || selectedId;
      if (value) properties[String(group.label || group.id)] = value;
    }
    for (const input of instance.config.textInputs || []) {
      if (!visible(instance, input)) continue;
      const value = String(instance.state.texts[input.id] || "").trim();
      if (value) properties[String(input.label || input.id)] = value;
    }
    for (const group of instance.config.fontGroups || []) {
      if (!visible(instance, group)) continue;
      const selectedId = instance.state.fonts[group.id];
      if (!selectedId) continue;
      const font = (group.options || []).find((item) => item.id === selectedId);
      const value = font?.family || font?.label || selectedId;
      if (value) properties[String(group.label || group.id)] = value;
    }
    for (const group of instance.config.colorGroups || []) {
      if (!visible(instance, group)) continue;
      const selectedId = instance.state.colors[group.id];
      if (!selectedId) continue;
      const color = (group.options || []).find((item) => item.id === selectedId);
      const value = color?.name || color?.label || selectedId;
      if (value) properties[String(group.label || group.id)] = value;
    }
    for (const input of instance.config.imageInputs || []) {
      if (!visible(instance, input)) continue;
      const image = instance.state.images[input.id];
      if (!image) continue;
      const uploaded = uploadedImages[input.id];
      const value = uploaded?.filename || image.file?.name || "Uploaded image";
      properties[String(input.label || input.id)] = value;
    }
    return properties;
  }
  function customizationProperties(instance, customizationId, payload) {
    const visibleProperties = visibleCustomizationProperties(instance, payload.selections.images || {});
    const summary = "Customized product";
    const payloadEncoded = toBase64Unicode(JSON.stringify(payload));
    const payloadChunks = chunkString(payloadEncoded, 240);
    const properties = {
      Customization: summary,
      "_customization_id": customizationId,
      "_customization_options": JSON.stringify(instance.state.options),
      "_customization_schema": String(instance.config.schemaVersion),
      "_customization_payload_encoding": "base64-json",
      "_customization_payload_count": String(payloadChunks.length)
    };
    Object.assign(properties, visibleProperties);
    payloadChunks.forEach((chunk, index) => {
      properties[`_customization_payload_${index + 1}`] = chunk;
    });
    return properties;
  }
  function resetAddButton(instance) {
    const add = q(instance?.modal, ".amzcustom-add");
    if (!add) return;
    add.disabled = false;
    add.classList.remove("is-loading");
    add.textContent = "Add to cart";
  }
  function closeModal(instance) {
    if (!instance?.modal) return;
    instance.modal.hidden = true;
    document.body.classList.remove("amzcustom-locked");
  }
  function resetInstanceUi(instance, reason = "manual") {
    if (!instance) return;
    closeModal(instance);
    resetAddButton(instance);
    stageLog("Customizer UI reset", {
      reason,
      productId: instance.root?.dataset?.productId || "",
      variantId: currentVariantId(instance)
    });
  }
  function resetAllCustomizerUis(reason = "manual") {
    document.querySelectorAll("[data-amzcustom-root]").forEach((root) => {
      const instance = instances.get(root);
      if (instance) resetInstanceUi(instance, reason);
    });
  }
  function getCartDrawer() {
    const drawer = document.querySelector("cart-drawer");
    return drawer instanceof HTMLElement ? drawer : null;
  }
  function getCartDrawerSectionIds(drawer) {
    if (!drawer || typeof drawer.getSectionsToRender !== "function") return [];
    return [...new Set((drawer.getSectionsToRender() || []).map((section) => String(section?.id || "")).filter(Boolean))];
  }
  function extractSectionInnerHtml(html, selector = ".shopify-section") {
    if (typeof html !== "string") return "";
    return new DOMParser().parseFromString(html, "text/html").querySelector(selector)?.innerHTML || "";
  }
  async function fetchCartSections(sectionIds) {
    const uniqueSectionIds = [...new Set(sectionIds.filter(Boolean))];
    if (!uniqueSectionIds.length) return {};
    const url = new URL(`${window.Shopify.routes.root}cart`, window.location.origin);
    url.searchParams.set("sections", uniqueSectionIds.join(","));
    url.searchParams.set("_", String(Date.now()));
    stageLog("Cart sections refresh started", {
      sectionIds: uniqueSectionIds,
      url: url.toString()
    });
    const response = await fetch(url.toString(), {
      cache: "no-store",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Cart sections refresh failed (${response.status})`);
    const sections = await response.json();
    stageLog("Cart sections refresh completed", {
      sectionIds: uniqueSectionIds,
      sectionKeys: sections && typeof sections === "object" ? Object.keys(sections) : []
    });
    return sections;
  }
  async function refreshCartUiFromServer(reason = "manual") {
    const drawer = getCartDrawer();
    const sectionIds = getCartDrawerSectionIds(drawer);
    if (!sectionIds.includes("cart-icon-bubble")) sectionIds.push("cart-icon-bubble");
    if (drawer && !sectionIds.includes("cart-drawer")) sectionIds.push("cart-drawer");
    if (!sectionIds.length) return;

    try {
      const sections = await fetchCartSections(sectionIds);
      stageLog("Cart UI refresh applying", {
        reason,
        hasDrawer: Boolean(drawer),
        sectionKeys: Object.keys(sections || {})
      });

      if (drawer && typeof drawer.renderContents === "function" && typeof sections["cart-drawer"] === "string") {
        drawer.renderContents({ id: drawer.productId || null, sections }, { openDrawer: false });
      } else {
        const bubble = document.getElementById("cart-icon-bubble");
        if (bubble && typeof sections["cart-icon-bubble"] === "string") {
          bubble.innerHTML = extractSectionInnerHtml(sections["cart-icon-bubble"], ".shopify-section");
        }
      }

      const drawerItemNodes = drawer?.querySelectorAll?.('[id^="CartDrawer-Item-"]')?.length || 0;
      stageLog("Cart UI refresh applied", {
        reason,
        drawerItemNodes,
        bubbleText: document.getElementById("cart-icon-bubble")?.textContent?.trim()?.slice(0, 80) || ""
      });
    } catch (error) {
      console.warn("[Amazon Customizer] Cart UI refresh failed", {
        reason,
        error: error?.message || String(error)
      });
    }
  }
  async function finish(instance) {
    if (!validate(instance)) {
      renderControls(instance, { preserveScroll: false });
      scrollToFirstError(instance);
      return;
    }
    const add = q(instance.modal, ".amzcustom-add");
    const startedAt = performance.now();
    const startedAtIso = new Date().toISOString();
    console.log("[Amazon Customizer] Add customized item started", {
      variantId: currentVariantId(instance),
      productId: instance.root.dataset.productId,
      startedAt: startedAtIso
    });
    add.disabled = true;
    add.classList.add("is-loading");
    add.innerHTML = '<span class="amzcustom-spinner" aria-hidden="true"></span><span>Saving...</span>';
    try {
      const imageEntries = Object.entries(instance.state.images);
      stageLog("Add customized item context", {
        variantId: currentVariantId(instance),
        imageCount: imageEntries.length,
        surcharge: surcharge(instance),
        basePrice: basePrice(instance),
        totalPrice: totalPrice(instance)
      });
      const uploadedImageEntries = await Promise.all(imageEntries.map(async ([id, value]) => {
        const uploadStartedAt = nowMs();
        const file = value.uploadedFile || await (value.uploadPromise || startBackgroundUpload(instance, id));
        stageLog("Custom image ready", { id, elapsedSeconds: secondsSince(uploadStartedAt), fileId: file?.id });
        return [id, file];
      }));
      const uploadedImages = Object.fromEntries(uploadedImageEntries);
      
      stageLog("All custom images uploaded", {
        elapsedSeconds: secondsSince(startedAt),
        uploadedImageCount: uploadedImageEntries.length
      });
      
      const customizationId = crypto.randomUUID();
      const payload = buildCustomizationPayload(instance, customizationId, uploadedImages);
      stageLog("Customization payload prepared", {
        elapsedSeconds: secondsSince(startedAt),
        payloadBytes: JSON.stringify(payload).length,
        previewLayers: payload.previewModel?.layers?.length || 0
      });
      
      const properties = customizationProperties(instance, customizationId, payload);
      const selectedVariantId = currentVariantId(instance);
      if (!selectedVariantId) throw new Error("Please choose a product variant before customizing.");
      const items = [{ id:Number(selectedVariantId), quantity:1, properties }];
      
      const cartAddStartedAt = nowMs();
      const addResponse = await fetch(`${window.Shopify.routes.root}cart/add.js`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({items}) });
      
      if (!addResponse.ok) {
        const errorJson = await addResponse.json();
        throw new Error(errorJson.description || "Không thể thêm vào giỏ hàng.");
      }
      stageLog("Cart add completed", {
        elapsedSeconds: secondsSince(cartAddStartedAt),
        lineItemCount: items.length
      });
      const finishedAt = performance.now();
      const elapsedSeconds = Number(((finishedAt - startedAt) / 1000).toFixed(2));
      console.log("[Amazon Customizer] Add customized item completed", {
        variantId: selectedVariantId,
        customizationId,
        elapsedSeconds
      });
      try {
        sessionStorage.setItem("amzcustom_last_add_timing", JSON.stringify({
          startedAt: startedAtIso,
          elapsedSeconds,
          variantId: selectedVariantId,
          customizationId
        }));
      } catch (e) {
      }
      resetInstanceUi(instance, "before-cart-redirect");
      window.location.href = `${window.Shopify.routes.root}cart`;
    } catch (error) {
      const failedAt = performance.now();
      console.warn("[Amazon Customizer] Add customized item failed", {
        variantId: currentVariantId(instance),
        elapsedSeconds: Number(((failedAt - startedAt) / 1000).toFixed(2)),
        error: error?.message || String(error)
      });
      alert(error.message);
      resetAddButton(instance);
    }
  }
  async function create(root) {
    if (instances.has(root)) return;
    const openButton = q(root, ".amzcustom-open");
    const originalText = openButton ? openButton.textContent : "";
    if (openButton) {
      openButton.disabled = true;
      openButton.textContent = "Loading...";
    }
    const config = await parseConfig(root);
    if (openButton) {
      openButton.disabled = false;
      openButton.textContent = originalText;
    }
    if (!config || instances.has(root)) return;
    for(const group of config.fontGroups||[])for(const font of group.options||[])ensureFontLoaded(font);
    const modal = document.createElement("div"); modal.className="amzcustom-modal"; modal.hidden=true;
    modal.innerHTML = `<div class="amzcustom-backdrop"></div><section class="amzcustom-dialog" role="dialog" aria-modal="true"><header class="amzcustom-head"><h2>Customize your product</h2><button class="amzcustom-close" aria-label="Close">×</button></header><div class="amzcustom-body"><div class="amzcustom-preview"><div class="amzcustom-stage"></div></div><div class="amzcustom-controls"></div></div><footer class="amzcustom-foot"><div class="amzcustom-price-summary"><strong class="amzcustom-price"></strong><strong class="amzcustom-total-price"></strong></div><button class="amzcustom-add">Add to cart</button></footer></section>`;
    document.body.appendChild(modal); const instance={root,modal,config,state:initialState(config)}; instances.set(root,instance);
    q(root,".amzcustom-open").addEventListener("click",()=>{ modal.hidden=false; document.body.classList.add("amzcustom-locked"); renderControls(instance); scheduleFontReadyRender(instance); });
    q(modal,".amzcustom-close").addEventListener("click",()=>closeModal(instance)); q(modal,".amzcustom-backdrop").addEventListener("click",()=>closeModal(instance)); q(modal,".amzcustom-add").addEventListener("click",()=>finish(instance));
    const form = root.closest('form[action*="/cart/add"]');
    if (form) {
      form.addEventListener("submit", () => {
        const variantId = form.querySelector('[name="id"]')?.value || root.dataset.variantId;
        if (variantId) {
          try {
            localStorage.removeItem("amzcustom_preview_" + variantId);
            localStorage.removeItem("amzcustom_unit_price_" + variantId);
          } catch (e) {}
        }
      });
    }
  }
  document.querySelectorAll("[data-amzcustom-root]").forEach(create);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      resetAllCustomizerUis("pageshow-persisted");
      refreshCartUiFromServer("pageshow-persisted");
    }
  });
  window.addEventListener("pagehide", () => {
    resetAllCustomizerUis("pagehide");
  });
})();
