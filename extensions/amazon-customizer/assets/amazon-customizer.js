(function () {
  "use strict";
  const instances = new WeakMap();
  const loadedFonts = new Set();
  const COLLAPSED_OPTION_LIMIT = 10;
  const q = (root, selector) => root.querySelector(selector);
  const escapeHtml = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char]));

  function parseConfig(root) {
    try { return JSON.parse(root.dataset.config); }
    catch (error) { console.error("Invalid Amazon customizer metafield", error); return null; }
  }
  function initialState(config) {
    const options = {}, fonts = {}, colors = {};
    for (const group of config.optionGroups || []) {
      const fallback = (group.options || []).find((option) => !option.outOfStock) || group.options[0];
      const defaultOption = (group.options || []).find((option) => option.id === group.defaultOptionId && !option.outOfStock);
      options[group.id] = (defaultOption && defaultOption.id) || (group.required && fallback && fallback.id) || "";
    }
    for (const group of config.fontGroups || []) fonts[group.id] = group.defaultFontId || (group.options[0] && group.options[0].id) || "";
    for (const group of config.colorGroups || []) colors[group.id] = group.defaultColorId || (group.options[0] && group.options[0].id) || "";
    return { options, fonts, colors, texts: {}, images: {}, imageTransforms: {}, textTransforms: {}, placementOffsets: {}, visible: {}, errors: {}, activeEdit: "", expandedOptionGroups: {}, promotedOptionIds: {} };
  }
  function formatMoney(value) { return `${Number(value || 0).toLocaleString()} VND`; }
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
  function selected(group, state) { return group.options.find((option) => option.id === state.options[group.id]); }
  function surcharge(instance) { return (instance.config.optionGroups || []).reduce((total, group) => total + (selected(group, instance.state)?.cost || 0), 0); }
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
  function renderOptionOverlays(instance, shouldRender, className) {
    const stage = q(instance.modal, ".amzcustom-stage");
    for (const group of instance.config.optionGroups || []) {
      if (!visible(instance, group) || !shouldRender(group)) continue;
      const overlay = selected(group, instance.state)?.overlayImage?.url;
      if (overlay) stage.insertAdjacentHTML("beforeend", `<img class="${escapeHtml(className || "amzcustom-stage-overlay")}" alt="" src="${escapeHtml(asset(overlay))}">`);
    }
  }

  function renderPreview(instance) {
    const stage = q(instance.modal, ".amzcustom-stage");
    stage.innerHTML = "";
    const config = instance.config, state = instance.state;
    const surface = (config.surfaces || [])[0];
    const base = surface?.baseImage?.url || config.product.productImageUrl;
    if (base) stage.insertAdjacentHTML("beforeend", `<img class="amzcustom-stage-base" alt="" src="${escapeHtml(asset(base))}">`);
    renderOptionOverlays(instance, isBackgroundOptionGroup, "amzcustom-stage-background");
    for (const input of config.imageInputs || []) {
      if (!visible(instance, input) || !state.images[input.id]) continue;
      const editId = `image:${input.id}`;
      const layer = document.createElement("div"); layer.className = `amzcustom-layer amzcustom-image-layer ${state.activeEdit === editId ? "is-active-edit" : ""}`; layer.dataset.placementId=input.placementId||""; layer.dataset.editId = editId; setBox(layer, box(config, input.placementId, state));
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
      const font = fontGroup?.options.find((item) => item.id === state.fonts[fontGroup.id]);
      const color = colorGroup?.options.find((item) => item.id === state.colors[colorGroup.id]);
      ensureFontLoaded(font);
      const transform = state.textTransforms[input.id] || { x: 0, y: 0, scale: 1, rotation: 0 };
      layer.innerHTML = `<div class="amzcustom-clip"><div class="amzcustom-transform-box" style="transform:${transformStyle(transform)}"><span>${escapeHtml(isSingleLineText(input) ? state.texts[input.id].replace(/\r?\n/g, " ") : state.texts[input.id])}</span></div></div>${state.activeEdit === editId ? `<div class="amzcustom-edit-box"><button type="button" class="amzcustom-rotate-handle" data-transform-handle="rotate" aria-label="Rotate"></button><button type="button" class="amzcustom-resize-handle nw" data-transform-handle="resize" aria-label="Resize"></button><button type="button" class="amzcustom-resize-handle ne" data-transform-handle="resize" aria-label="Resize"></button><button type="button" class="amzcustom-resize-handle sw" data-transform-handle="resize" aria-label="Resize"></button><button type="button" class="amzcustom-resize-handle se" data-transform-handle="resize" aria-label="Resize"></button></div>` : ""}`;
      const fontFamily = cssFontFamily(font?.family || "Arial");
      layer.style.fontFamily = fontFamily; layer.style.color = color?.value || "#000";
      layer.style.fontSize = textFontSize(instance, input, boxStyles, state.texts[input.id], fontFamily);
      stage.appendChild(layer);
    }
    if (surface?.maskImage?.url) stage.insertAdjacentHTML("beforeend", `<img class="amzcustom-stage-mask" alt="" src="${escapeHtml(asset(surface.maskImage.url))}">`);
    bindPreviewDrag(instance);
    syncEditBoxes(stage);
    q(instance.modal, ".amzcustom-price").textContent = `Phụ phí: ${surcharge(instance).toLocaleString()} VND`;
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
    const up=(next)=>{window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up);try { layer.releasePointerCapture?.(next.pointerId); } catch {} if(syncFrame) cancelAnimationFrame(syncFrame); if(action==="move" && type==="image" && isOutsidePreview(stage, layer)) bucket[id]=original; renderPreview(instance);};
    window.addEventListener("pointermove",move);window.addEventListener("pointerup",up);
  }
  function controlHeader(item, value) {
    const suffix = value ? `: ${value}` : "";
    const help = visibleInstructions(item.instructions);
    return `<div class="amzcustom-title"><span>${escapeHtml(item.label)}${escapeHtml(suffix)}</span>${item.required ? "" : '<em>(optional)</em>'}</div>${help ? `<p class="amzcustom-help">${escapeHtml(help)}</p>` : ""}`;
  }
  function visibleInstructions(value) {
    const text = String(value || "").trim();
    const hidden = [
      "Please check the spelling carefully.",
      "'Why pay for shipping twice? Add the matching Pillow to your order now, complete the look, and save time & money.'",
      "Why pay for shipping twice? Add the matching Pillow to your order now, complete the look, and save time & money.",
      "If you don't fill it out, we'll make it according to the Amazon page time.",
      "Why pay for shipping twice? Add the matching tapestry to your order now, complete the look, and save time & money."
    ];
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
  function isTextChoiceGroup(item) {
    const label = String(item.label || "");
    return /(?:item\s+size|matching|tapestry|pillow|purchase)/i.test(label) && !isYesNoGroup(item);
  }
  function fontDropdownHtml(state, item) {
    const selected = item.options.find((font) => font.id === state.fonts[item.id]) || item.options[0] || {};
    return `<details class="amzcustom-font-dropdown"><summary style="font-family:${escapeHtml(cssFontFamily(selected.family || "Arial"))}"><span>${escapeHtml(selected.family || "Select font")}</span></summary><div class="amzcustom-fonts">${item.options.map((font) => { ensureFontLoaded(font); return `<button type="button" class="amzcustom-font ${state.fonts[item.id] === font.id ? "is-selected" : ""}" data-font="${escapeHtml(font.id)}" style="font-family:${escapeHtml(cssFontFamily(font.family))}">${escapeHtml(font.family)}</button>`; }).join("")}</div></details>`;
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
  function optionChoicesHtml(state, item) {
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
      return `<button type="button" class="amzcustom-choice ${state.options[item.id] === option.id ? "is-selected" : ""} ${option.outOfStock ? "is-out" : ""}" data-option="${escapeHtml(option.id)}" data-option-source="primary" ${option.outOfStock ? "disabled" : ""}>${img ? `<img src="${escapeHtml(img.url)}" alt="">` : `<span class="amzcustom-stock-icon"></span>`}<span>${escapeHtml(option.label)}</span>${option.outOfStock ? "<small>Out of stock</small>" : option.cost ? `<small>+${formatMoney(option.cost)}</small>` : ""}</button>`;
    }).join("");
    const toggle = shouldCollapse ? `<button type="button" class="amzcustom-options-toggle" data-options-toggle="${escapeHtml(item.id)}">${expanded ? "See less" : `See all ${item.options.length} options`}</button>` : "";
    const primaryIds = new Set(primaryOptions.map((option) => option.id));
    const overflowOptions = shouldCollapse ? item.options.filter((option) => !primaryIds.has(option.id)) : [];
    const overflow = shouldCollapse && expanded ? `<div class="amzcustom-options-list">${overflowOptions.map((option) => { const img = option.thumbnailImage || option.overlayImage; return `<button type="button" class="amzcustom-option-row ${state.options[item.id] === option.id ? "is-selected" : ""} ${option.outOfStock ? "is-out" : ""}" data-option="${escapeHtml(option.id)}" data-option-source="overflow" ${option.outOfStock ? "disabled" : ""}>${img ? `<img src="${escapeHtml(img.url)}" alt="">` : `<span class="amzcustom-row-icon"></span>`}<span>${escapeHtml(option.label)}</span></button>`; }).join("")}</div>` : "";
    return `<div class="amzcustom-choices ${isYesNoGroup(item) ? "is-yes-no" : ""} ${isInlineChoiceGroup(item) ? "is-inline-choice" : ""} ${isTextChoiceGroup(item) ? "is-text-choice" : ""} ${shouldCollapse ? "is-collapsed" : ""} ${expanded ? "is-expanded" : ""}">${choices}</div>${toggle}${overflow}`;
  }
  function controlHtml(instance, type, item) {
    if (!visible(instance, item)) return "";
    const state = instance.state;
    if (type === "option") {
      const hasImages = item.options.some((option) => option.thumbnailImage || option.overlayImage);
      const selectedValue = item.options.find((option) => option.id === state.options[item.id])?.label || "";
      if (item.displayHint === "choice-grid" || hasImages || isTextChoiceGroup(item) || isInlineChoiceGroup(item)) return `<section class="amzcustom-control" data-id="${item.id}">${controlHeader(item, selectedValue)}${optionChoicesHtml(state, item)}<span class="amzcustom-error">${escapeHtml(state.errors[item.id] || "")}</span></section>`;
      return `<section class="amzcustom-control" data-id="${item.id}">${controlHeader(item, selectedValue)}<select>${!item.required ? '<option value="">No selection</option>' : ""}${item.options.map((option) => `<option value="${escapeHtml(option.id)}" ${state.options[item.id] === option.id ? "selected" : ""} ${option.outOfStock ? "disabled" : ""}>${escapeHtml(option.label)}${option.outOfStock ? " - Out of stock" : option.cost ? ` (+${formatMoney(option.cost)})` : ""}</option>`).join("")}</select><span class="amzcustom-error">${escapeHtml(state.errors[item.id] || "")}</span></section>`;
    }
    if (type === "text") {
      const value = state.texts[item.id] || "";
      return `<section class="amzcustom-control" data-id="${item.id}">${controlHeader(item)}${item.maxLines > 1 ? `<textarea maxlength="${item.maxLength || ""}" rows="${Math.min(item.maxLines || 3, 5)}">${escapeHtml(value)}</textarea>` : `<input type="text" maxlength="${item.maxLength || ""}" value="${escapeHtml(value)}" placeholder="${escapeHtml(item.placeholder || "")}">`}<div class="amzcustom-meta"><span>${value.length}${item.maxLength ? `/${item.maxLength}` : ""}</span></div><span class="amzcustom-error">${escapeHtml(state.errors[item.id] || "")}</span></section>`;
    }
    if (type === "image") { const active = state.activeEdit === `image:${item.id}`; return `<section class="amzcustom-control ${active ? "is-editing" : ""}" data-id="${item.id}">${controlHeader(item)}<input class="amzcustom-file ${state.images[item.id] ? "is-hidden" : ""}" type="file" accept="image/png,image/jpeg,image/webp">${state.images[item.id] ? `<div class="amzcustom-upload-row"><img src="${escapeHtml(state.images[item.id].dataUrl)}" alt=""><div class="amzcustom-actions">${imageActionButton(active ? "done" : "edit", active ? "Done" : "Edit", active ? "done" : "edit")}${imageActionButton("replace", "Replace", "replace")}${imageActionButton("delete", "Delete", "delete")}</div></div>` : ""}<span class="amzcustom-error">${escapeHtml(state.errors[item.id] || "")}</span></section>`; }
    if (type === "font") return `<section class="amzcustom-control" data-id="${item.id}">${controlHeader(item)}${fontDropdownHtml(state, item)}</section>`;
    if (type === "color") return `<section class="amzcustom-control" data-id="${item.id}">${controlHeader(item)}<div class="amzcustom-swatches">${item.options.map((color) => `<button type="button" class="amzcustom-swatch ${state.colors[item.id] === color.id ? "is-selected" : ""}" data-color="${escapeHtml(color.id)}" style="--swatch:${escapeHtml(color.value || "#fff")}" title="${escapeHtml(color.name)}"><span>${escapeHtml(color.name)}</span></button>`).join("")}</div></section>`;
    return "";
  }
  function renderControls(instance) {
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
  function fileData(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = reject; reader.onload = () => { const image = new Image(); image.onload = () => resolve({ file, dataUrl: reader.result, width: image.naturalWidth || 1, height: image.naturalHeight || 1 }); image.onerror = () => resolve({ file, dataUrl: reader.result, width: 1, height: 1 }); image.src = reader.result; }; reader.readAsDataURL(file); }); }
  function bindControls(instance) {
    if (instance.controlsBound) return;
    instance.controlsBound = true;
    q(instance.modal, ".amzcustom-controls").addEventListener("click", (event) => {
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
        if (imageAction.dataset.imageAction === "edit") return startEdit(instance, `image:${id}`);
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
        ensureFontLoaded(group?.options.find((item) => item.id === font.dataset.font));
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
      if (event.target.matches('input[type="file"]') && event.target.files[0]) { instance.state.images[id] = await fileData(event.target.files[0]); instance.state.imageTransforms[id] = { x:0, y:0, scale:1, rotation:0 }; if (instance.state.activeEdit === `image:${id}`) instance.state.activeEdit = ""; }
      if (event.target.matches("select")) { if (instance.config.optionGroups.some((x)=>x.id===id)) instance.state.options[id] = event.target.value; else if (instance.config.fontGroups.some((x)=>x.id===id)) { instance.state.fonts[id] = event.target.value; const group = instance.config.fontGroups.find((x)=>x.id===id); ensureFontLoaded(group?.options.find((item)=>item.id===event.target.value)); } else instance.state.colors[id] = event.target.value; }
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
    instance.state.errors = errors; return !Object.keys(errors).length;
  }
  async function upload(instance, dataUrl) {
    if (!instance.root.dataset.uploadUrl) throw new Error("Theme block chưa cấu hình upload URL.");
    const response = await fetch(instance.root.dataset.uploadUrl, { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ dataUrl }) });
    const json = await response.json();
    if (!response.ok || !json.ok) throw new Error(json.error || "Upload thất bại");
    return json.file;
  }
  async function loadCanvasImage(url) {
    const response = await fetch(url);
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
  }
  async function previewDataUrl(instance) {
    const stage=q(instance.modal,".amzcustom-stage"), rect=stage.getBoundingClientRect(), size=1000;
    const canvas=document.createElement("canvas"); canvas.width=canvas.height=size; const context=canvas.getContext("2d"); context.fillStyle="#fff"; context.fillRect(0,0,size,size);
    for (const child of stage.children) {
      const childRect=child.getBoundingClientRect(), x=(childRect.left-rect.left)/rect.width*size, y=(childRect.top-rect.top)/rect.height*size, width=childRect.width/rect.width*size, height=childRect.height/rect.height*size;
      if (child.tagName === "IMG") {
        const image=await loadCanvasImage(child.src);
        context.drawImage(image,x,y,width,height);
        continue;
      }
      const inner=child.querySelector("img");
      if (inner) {
        const image=await loadCanvasImage(inner.src);
        const transform=(child.querySelector(".amzcustom-transform-box") || inner).style.transform.match(/translate\(([-\d.]+)%.*,([-\d.]+)%\).*scale\(([^)]+)\).*rotate\(([-\d.]+)deg\)/); const tx=Number(transform?.[1]||0)/100*width, ty=Number(transform?.[2]||0)/100*height, scale=Number(transform?.[3]||1), rotation=Number(transform?.[4]||0)*Math.PI/180; context.save(); context.beginPath(); context.rect(x,y,width,height); context.clip(); context.translate(x+width/2+tx,y+height/2+ty); context.rotate(rotation); context.drawImage(image,-width*scale/2,-height*scale/2,width*scale,height*scale); context.restore();
      }
      else {
        const textNode=child.querySelector("span") || child; const style=getComputedStyle(child); const textRect=textNode.getBoundingClientRect(); const tx=(textRect.left-childRect.left)/rect.width*size, ty=(textRect.top-childRect.top)/rect.height*size; context.fillStyle=style.color; context.font=`${Math.max(12,parseFloat(style.fontSize)/rect.width*size)}px ${style.fontFamily}`; context.textAlign="center"; context.textBaseline="middle"; const lines=textNode.textContent.split(/\r?\n/); lines.forEach((line,index)=>context.fillText(line,x+tx+width/2,y+ty+height/2+(index-(lines.length-1)/2)*32,width));
      }
    }
    const dataUrl = canvas.toDataURL("image/png",.92);
    return dataUrl;
  }
  async function finish(instance) {
    if (!validate(instance)) {
      return renderControls(instance);
    }
    const add = q(instance.modal, ".amzcustom-add"); add.disabled = true; add.textContent = "Đang lưu…";
    try {
      const uploadedImages = {};
      for (const [id, value] of Object.entries(instance.state.images)) {
        uploadedImages[id] = await upload(instance, value.dataUrl);
      }
      
      const pDataUrl = await previewDataUrl(instance);
      const previewFile=await upload(instance, pDataUrl);
      
      const customizationId = crypto.randomUUID();
      
      const manifest = { customizationId, schemaVersion:instance.config.schemaVersion, productId:instance.root.dataset.productId, variantId:instance.root.dataset.variantId, preview:previewFile, selections:{ options:instance.state.options, texts:instance.state.texts, fonts:instance.state.fonts, colors:instance.state.colors, images:uploadedImages, imageTransforms:instance.state.imageTransforms, textTransforms:instance.state.textTransforms, placementOffsets:instance.state.placementOffsets }, surcharge:surcharge(instance), createdAt:new Date().toISOString() };
      const manifestUrl = `data:application/json;base64,${btoa(unescape(encodeURIComponent(JSON.stringify(manifest))))}`;
      
      const manifestFile = await upload(instance, manifestUrl);
      
      const summary = Object.values(instance.state.texts).filter(Boolean).join(" | ").slice(0, 220) || "Customized product";
      try {
        localStorage.setItem("amzcustom_preview_" + instance.root.dataset.variantId, previewFile.url);
        const surchargeCents = Math.round(surcharge(instance) * 100);
        localStorage.setItem("amzcustom_surcharge_" + instance.root.dataset.variantId, String(surchargeCents));
      } catch (e) {
        console.warn("localStorage write failed", e);
      }
      
      const properties={ Customization:summary, "_customization_id":customizationId, "_customization_preview":previewFile.url, "_customization_manifest":manifestFile.url, "_customization_fee":String(manifest.surcharge), "_customization_options":JSON.stringify(instance.state.options), "_customization_schema":String(instance.config.schemaVersion) };
      const items = [{ id:Number(instance.root.dataset.variantId), quantity:1, properties }];
      
      const feeCounts={}; for(const group of instance.config.optionGroups){const option=selected(group,instance.state);if(option?.cost>0)feeCounts[option.cost]=(feeCounts[option.cost]||0)+1;}
      for(const [amount,quantity] of Object.entries(feeCounts)){const gid=instance.config.pricing.variantIds?.[amount];if(!gid)throw new Error(`Thiếu add-on variant cho phụ phí ${amount} VND. Hãy Sync lại product.`);items.push({id:Number(String(gid).split("/").pop()),parent_id:Number(instance.root.dataset.variantId),quantity,properties:{"_customization_id":customizationId,"_customization_parent_variant":instance.root.dataset.variantId,"_customization_fee_component":amount}});}
      
      const addResponse = await fetch(`${window.Shopify.routes.root}cart/add.js`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({items}) });
      
      if (!addResponse.ok) {
        const errorJson = await addResponse.json();
        throw new Error(errorJson.description || "Không thể thêm vào giỏ hàng.");
      }
      
      window.location.href = `${window.Shopify.routes.root}cart`;
    } catch (error) {
      alert(error.message);
      add.disabled = false;
      add.textContent = "Add customized item";
    }
  }
  function create(root) {
    const config = parseConfig(root); if (!config || instances.has(root)) return;
    for(const group of config.fontGroups||[])for(const font of group.options||[])ensureFontLoaded(font);
    const modal = document.createElement("div"); modal.className="amzcustom-modal"; modal.hidden=true;
    modal.innerHTML = `<div class="amzcustom-backdrop"></div><section class="amzcustom-dialog" role="dialog" aria-modal="true"><header class="amzcustom-head"><h2>Customize your product</h2><button class="amzcustom-close" aria-label="Close">×</button></header><div class="amzcustom-body"><div class="amzcustom-preview"><div class="amzcustom-stage"></div></div><div class="amzcustom-controls"></div></div><footer class="amzcustom-foot"><strong class="amzcustom-price"></strong><button class="amzcustom-add">Add customized item</button></footer></section>`;
    document.body.appendChild(modal); const instance={root,modal,config,state:initialState(config)}; instances.set(root,instance);
    q(root,".amzcustom-open").addEventListener("click",()=>{ modal.hidden=false; document.body.classList.add("amzcustom-locked"); renderControls(instance); scheduleFontReadyRender(instance); });
    const close=()=>{modal.hidden=true;document.body.classList.remove("amzcustom-locked");}; q(modal,".amzcustom-close").addEventListener("click",close); q(modal,".amzcustom-backdrop").addEventListener("click",close); q(modal,".amzcustom-add").addEventListener("click",()=>finish(instance));
    const form = root.closest('form[action*="/cart/add"]');
    if (form) {
      form.addEventListener("submit", () => {
        const variantId = form.querySelector('[name="id"]')?.value || root.dataset.variantId;
        if (variantId) {
          try {
            localStorage.removeItem("amzcustom_preview_" + variantId);
            localStorage.removeItem("amzcustom_surcharge_" + variantId);
            localStorage.removeItem("amzcustom_unit_price_" + variantId);
          } catch (e) {}
        }
      });
    }
  }
  document.querySelectorAll("[data-amzcustom-root]").forEach(create);
})();
