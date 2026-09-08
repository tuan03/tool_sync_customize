(function () {
  "use strict";

  const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"]);
  const runtime = window.EtsyProductPersonalizer = window.EtsyProductPersonalizer || {
    instances: new Set(),
    initializedRoots: new WeakSet(),
    listenersInstalled: false,
    observer: null
  };
  const instances = runtime.instances;
  const initializedRoots = runtime.initializedRoots;

  function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
  function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
  function money(amount, currency = "USD") { return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Number(amount || 0)); }
  function formControl(form, name) {
    const control = form?.elements?.namedItem?.(name);
    return typeof RadioNodeList !== "undefined" && control instanceof RadioNodeList ? control[0] : control;
  }
  function productForm(root) {
    const explicitId = root.dataset.productFormId;
    const explicitForm = explicitId ? document.getElementById(explicitId) : null;
    if (explicitForm?.matches?.('form[action*="/cart/add"]')) return explicitForm;
    return root.closest('form[action*="/cart/add"]');
  }
  function currentVariantId(root) { return String(formControl(productForm(root), "id")?.value || root.dataset.variantId || ""); }
  function currentQuantity(root) {
    const value = Number(formControl(productForm(root), "quantity")?.value || root.dataset.quantity || 1);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
  }
  function variantData(instance) { const id = currentVariantId(instance.root); return instance.variants.find((variant) => String(variant.id) === id) || null; }
  function basePrice(instance) { const price = Number(variantData(instance)?.price); return Number.isFinite(price) ? price / 100 : Number(instance.root.dataset.basePrice || 0); }
  function variantImage(instance) {
    const variant = variantData(instance);
    return variant?.featured_image?.src || variant?.featured_media?.preview_image?.src || instance.root.dataset.productImage || "";
  }
  function productAvailable(instance) {
    const variant = variantData(instance);
    if (variant && variant.available === false) return false;
    return instance.root.dataset.available !== "false" && Boolean(currentVariantId(instance.root));
  }
  function uploadSlots(question) {
    if (question.type === "labeled_upload") return question.options.map((option, index) => ({ id: `${question.id}:${option.id || index}`, label: option.label }));
    return Array.from({ length: Number(question.maxFiles || 1) }, (_, index) => ({ id: `${question.id}:${index}`, label: `File ${index + 1}` }));
  }
  function questionHtml(question) {
    const id = `personalizer-${question.id}`;
    const required = question.required ? '<span class="etsy-personalizer-required">Required</span>' : '<span class="etsy-personalizer-optional">Optional</span>';
    const fee = question.addOnPrice ? `<span class="etsy-personalizer-fee">+${escapeHtml(money(question.addOnPrice.amount, question.addOnPrice.currencyCode))}</span>` : "";
    let control = "";
    if (question.type === "text_input") control = `<textarea id="${escapeHtml(id)}" rows="3" maxlength="${Number(question.maxCharacters || 1024)}" data-personalizer-text="${escapeHtml(question.id)}"></textarea><div class="etsy-personalizer-counter"><span data-personalizer-count="${escapeHtml(question.id)}">0</span>/${Number(question.maxCharacters || 1024)}</div>`;
    else if (question.type === "dropdown") control = `<select id="${escapeHtml(id)}" data-personalizer-select="${escapeHtml(question.id)}"><option value="">Select an option</option>${question.options.map((option) => `<option value="${escapeHtml(option.label)}">${escapeHtml(option.label)}</option>`).join("")}</select>`;
    else control = `<div class="etsy-personalizer-uploads">${uploadSlots(question).map((slot) => `<label class="etsy-personalizer-upload"><span>${escapeHtml(slot.label)}</span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" data-personalizer-file="${escapeHtml(question.id)}" data-slot-id="${escapeHtml(slot.id)}"></label>`).join("")}</div>`;
    return `<div class="etsy-personalizer-question" data-question-id="${escapeHtml(question.id)}"><div class="etsy-personalizer-question-head"><label for="${escapeHtml(id)}">${escapeHtml(question.label)}</label><div>${required}${fee}</div></div>${question.instructions ? `<p>${escapeHtml(question.instructions)}</p>` : ""}${control}<div class="etsy-personalizer-error" data-question-error="${escapeHtml(question.id)}" hidden></div></div>`;
  }

  async function uploadFile(root, file) {
    if (!ACCEPTED_TYPES.has(file.type)) throw new Error(`${file.name}: unsupported file type.`);
    if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name}: file exceeds 10 MB.`);
    const prepare = await fetch(root.dataset.uploadUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "prepare", mimeType: file.type, fileSize: file.size }) });
    const prepared = await prepare.json();
    if (!prepare.ok || !prepared.ok) throw new Error(prepared.error || "Upload preparation failed.");
    const target = prepared.upload;
    const form = new FormData();
    for (const parameter of target.parameters || []) form.append(parameter.name, parameter.value);
    form.append("file", file, target.filename || file.name);
    const staged = await fetch(target.url, { method: "POST", body: form });
    if (!staged.ok) throw new Error(`File upload failed (${staged.status}).`);
    const complete = await fetch(root.dataset.uploadUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "complete", resourceUrl: target.resourceUrl, filename: target.filename, mimeType: file.type }) });
    const completed = await complete.json();
    if (!complete.ok || !completed.ok) throw new Error(completed.error || "Upload completion failed.");
    return completed.file;
  }

  function encodePayload(value) { return btoa(unescape(encodeURIComponent(value))); }
  function randomId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    const bytes = new Uint8Array(16); window.crypto?.getRandomValues?.(bytes);
    return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("") || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  function payloadProperties(payload) {
    const chunks = encodePayload(JSON.stringify(payload)).match(/.{1,18000}/g) || [];
    const properties = { _customization_id: payload.id, _customization_schema: String(payload.schemaVersion), _customization_payload_encoding: "base64-json", _customization_payload_count: String(chunks.length), _personalization_source: "etsy", _personalization_listing_id: String(payload.source.listingId || "") };
    chunks.forEach((chunk, index) => { properties[`_customization_payload_${index + 1}`] = chunk; });
    return properties;
  }
  function questionValue(instance, question) {
    if (question.type === "text_input") return instance.modal.querySelector(`[data-personalizer-text="${CSS.escape(question.id)}"]`)?.value.trim() || "";
    if (question.type === "dropdown") return instance.modal.querySelector(`[data-personalizer-select="${CSS.escape(question.id)}"]`)?.value || "";
    return [...instance.modal.querySelectorAll(`[data-personalizer-file="${CSS.escape(question.id)}"]`)].map((input) => input.files?.[0]).filter(Boolean);
  }
  function surcharge(instance) {
    return Math.round(instance.config.questions.reduce((total, question) => {
      const value = questionValue(instance, question);
      return total + ((Array.isArray(value) ? value.length > 0 : Boolean(value)) ? Number(question.addOnPrice?.amount || 0) : 0);
    }, 0) * 100) / 100;
  }
  function updateProductContext(instance) {
    const image = instance.modal.querySelector(".etsy-personalizer-product-image");
    const imageUrl = variantImage(instance);
    image.src = imageUrl; image.hidden = !imageUrl;
    const base = basePrice(instance), fee = surcharge(instance), currency = instance.config.pricing?.currencyCode || instance.root.dataset.currencyCode || "USD";
    instance.modal.querySelector(".etsy-personalizer-base-price").textContent = `Product: ${money(base, currency)}`;
    const feeNode = instance.modal.querySelector(".etsy-personalizer-surcharge");
    feeNode.textContent = fee > 0 ? `Customization: +${money(fee, currency)}` : ""; feeNode.hidden = fee <= 0;
    instance.modal.querySelector(".etsy-personalizer-total-price").textContent = `Total: ${money(base + fee, currency)}`;
    const available = productAvailable(instance);
    instance.root.querySelector(".amzcustom-open")?.toggleAttribute("disabled", !available);
    instance.modal.querySelectorAll(".etsy-personalizer-add,.etsy-personalizer-buy-now").forEach((button) => { button.disabled = instance.busy || !available; });
    const status = instance.modal.querySelector(".etsy-personalizer-status");
    if (!available && !instance.busy) status.textContent = "This variant is sold out.";
    else if (status.textContent === "This variant is sold out.") status.textContent = "";
  }
  function validate(instance) {
    let valid = true, firstInvalid = null;
    for (const question of instance.config.questions) {
      const error = instance.modal.querySelector(`[data-question-error="${CSS.escape(question.id)}"]`), value = questionValue(instance, question);
      let message = "";
      if (question.required && question.type === "text_input" && !value) message = "Enter a response.";
      if (question.required && question.type === "dropdown" && !value) message = "Select an option.";
      if (question.required && question.type.endsWith("_upload") && !value.length) message = "Upload the required file(s).";
      if (question.required && question.type === "labeled_upload" && value.length !== Number(question.maxFiles || 0)) message = "Upload a file for every label.";
      error.hidden = !message; error.textContent = message;
      if (message) { valid = false; firstInvalid ||= instance.modal.querySelector(`[data-question-id="${CSS.escape(question.id)}"]`); }
    }
    firstInvalid?.scrollIntoView({ behavior: "smooth", block: "center" });
    return valid;
  }
  function setBusy(instance, busy, activeButton, label) {
    instance.busy = busy;
    instance.modal.querySelectorAll(".etsy-personalizer-add,.etsy-personalizer-buy-now").forEach((button) => { button.disabled = busy; button.classList.toggle("is-loading", busy && button === activeButton); });
    if (activeButton) { activeButton.dataset.originalLabel ||= activeButton.textContent; activeButton.textContent = busy ? label : activeButton.dataset.originalLabel; }
  }
  function getCartDrawer() { const drawer = document.querySelector("cart-drawer"); return drawer instanceof HTMLElement ? drawer : null; }
  function cartSectionIds(drawer) {
    const ids = typeof drawer?.getSectionsToRender === "function" ? (drawer.getSectionsToRender() || []).map((section) => String(section?.id || "")).filter(Boolean) : [];
    if (!ids.includes("cart-icon-bubble")) ids.push("cart-icon-bubble");
    if (drawer && !ids.includes("cart-drawer")) ids.push("cart-drawer");
    return [...new Set(ids)];
  }
  function sectionInnerHtml(html) { return typeof html === "string" ? new DOMParser().parseFromString(html, "text/html").querySelector(".shopify-section")?.innerHTML || "" : ""; }
  function applyCartSections(result) {
    const sections = result?.sections || {}, drawer = getCartDrawer();
    if (drawer && typeof drawer.renderContents === "function" && typeof sections["cart-drawer"] === "string") {
      drawer.renderContents({ id: drawer.productId || null, sections }, { openDrawer: true });
      drawer.open?.();
    } else {
      const bubble = document.getElementById("cart-icon-bubble");
      if (bubble && typeof sections["cart-icon-bubble"] === "string") bubble.innerHTML = sectionInnerHtml(sections["cart-icon-bubble"]);
      drawer?.open?.();
    }
    document.dispatchEvent(new CustomEvent("cart:updated", { detail: { source: "etsy-personalizer", result } }));
  }
  function close(instance, { reset = false } = {}) {
    instance.modal.hidden = true; document.body.classList.remove("amzcustom-locked");
    if (reset) {
      instance.modal.querySelectorAll("textarea,select,input[type=file]").forEach((control) => { control.value = ""; });
      instance.modal.querySelectorAll("[data-personalizer-count]").forEach((node) => { node.textContent = "0"; });
      instance.modal.querySelectorAll(".etsy-personalizer-error").forEach((node) => { node.hidden = true; node.textContent = ""; });
      instance.modal.querySelector(".etsy-personalizer-status").textContent = "";
      updateProductContext(instance);
    }
    instance.root.querySelector(".amzcustom-open")?.focus();
  }
  function open(instance) {
    if (!productAvailable(instance)) return;
    updateProductContext(instance); instance.modal.hidden = false; document.body.classList.add("amzcustom-locked");
    requestAnimationFrame(() => instance.modal.querySelector("textarea,select,input,.etsy-personalizer-close")?.focus());
  }

  async function finish(instance, { redirectToCheckout = false, button } = {}) {
    if (instance.busy || !productAvailable(instance) || !validate(instance)) return;
    const status = instance.modal.querySelector(".etsy-personalizer-status");
    setBusy(instance, true, button, redirectToCheckout ? "Redirecting..." : "Saving...");
    status.textContent = "Uploading and adding your customized item...";
    try {
      const answers = [], visible = {}; let fee = 0;
      for (const question of instance.config.questions) {
        const value = questionValue(instance, question);
        if (question.type === "text_input" || question.type === "dropdown") {
          if (value) { answers.push({ questionId: question.id, label: question.label, type: question.type, value }); visible[question.label] = value; fee += Number(question.addOnPrice?.amount || 0); }
          continue;
        }
        const uploads = [];
        for (const input of instance.modal.querySelectorAll(`[data-personalizer-file="${CSS.escape(question.id)}"]`)) {
          const file = input.files?.[0]; if (!file) continue;
          const saved = await uploadFile(instance.root, file); uploads.push({ slotId: input.dataset.slotId, fileId: saved.id, url: saved.url });
        }
        if (uploads.length) { answers.push({ questionId: question.id, label: question.label, type: question.type, uploads }); visible[question.label] = uploads.map((upload) => upload.url).join(", "); }
      }
      fee = Math.round(fee * 100) / 100;
      const customizationId = randomId(), selectedVariantId = currentVariantId(instance.root);
      if (!selectedVariantId) throw new Error("Choose a product variant before customizing.");
      const payload = { id: customizationId, schemaVersion: instance.config.schemaVersion, source: instance.config.source, productId: instance.root.dataset.productId, variantId: selectedVariantId, createdAt: new Date().toISOString(), answers, surcharge: fee };
      const properties = { Customization: answers.map((answer) => `${answer.label}: ${answer.value || `${answer.uploads?.length || 0} file(s)`}`).join(" | "), ...visible, ...payloadProperties(payload) };
      const quantity = currentQuantity(instance.root), items = [{ id: Number(selectedVariantId), quantity, properties }];
      if (fee > 0) {
        const feeVariantId = instance.config.pricing?.addonProduct?.variants?.[fee.toFixed(2)];
        if (!feeVariantId) throw new Error(`Personalization fee ${money(fee, instance.config.pricing.currencyCode)} is not configured. Sync personalization again.`);
        properties._personalization_fee_variant_id = String(feeVariantId).split("/").pop(); properties._personalization_fee_amount = fee.toFixed(2);
        items.push({ id: Number(String(feeVariantId).split("/").pop()), quantity, properties: { "Personalization fee": money(fee, instance.config.pricing.currencyCode), _customization_id: customizationId, _personalization_fee: "true", _personalization_parent_variant_id: String(selectedVariantId) } });
      }
      const drawer = getCartDrawer(), sections = cartSectionIds(drawer);
      const response = await fetch(`${window.Shopify.routes.root}cart/add.js`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ items, sections, sections_url: window.location.pathname }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.description || "Could not add customized item to cart.");
      if (redirectToCheckout) { window.location.assign(`${window.Shopify.routes.root}checkout`); return; }
      close(instance, { reset: true }); applyCartSections(result);
    } catch (error) { status.textContent = error.message || "Could not add customized item."; }
    finally { setBusy(instance, false, button, ""); }
  }

  function matchingForms(instance) {
    const form = productForm(instance.root);
    return form ? [form] : [];
  }
  function applyRequiredPurchaseMode(instance) {
    if (!instance.requiresCustomization) return;
    matchingForms(instance).forEach((form) => { form.classList.add("etsy-personalizer-required-form"); form.dataset.etsyPersonalizerProductId = String(instance.root.dataset.productId || ""); });
  }
  function matchingRequiredInstance(form) {
    return [...instances].find((instance) => instance.root.isConnected && instance.requiresCustomization && form === productForm(instance.root));
  }
  function init(root) {
    if (initializedRoots.has(root)) return;
    const config = parseJson(root.dataset.config, null);
    if (!config || config.mode !== "personalization_form" || !Array.isArray(config.questions) || !config.questions.length) return;
    initializedRoots.add(root);
    const variants = parseJson(root.dataset.productVariants, []);
    const modal = document.createElement("div"); modal.className = "etsy-personalizer-modal"; modal.hidden = true;
    modal.innerHTML = `<div class="etsy-personalizer-backdrop"></div><section class="etsy-personalizer-dialog" role="dialog" aria-modal="true" aria-label="Customize your product"><header><div><h2>Customize your product</h2><p>${escapeHtml(root.dataset.productTitle || "")}</p></div><button type="button" class="etsy-personalizer-close" aria-label="Close">&times;</button></header><div class="etsy-personalizer-body"><div class="etsy-personalizer-preview"><div class="etsy-personalizer-image-frame"><img class="etsy-personalizer-product-image" alt="${escapeHtml(root.dataset.productTitle || "Product image")}"></div><p>Your details will be saved with this item. The image is a product reference and does not preview placement.</p></div><div class="etsy-personalizer-questions">${config.questions.map(questionHtml).join("")}</div></div><footer><div class="etsy-personalizer-price-summary"><span class="etsy-personalizer-base-price"></span><span class="etsy-personalizer-surcharge" hidden></span><strong class="etsy-personalizer-total-price"></strong></div><span class="etsy-personalizer-status" role="status"></span><div class="etsy-personalizer-actions"><button type="button" class="etsy-personalizer-buy-now">Buy now</button><button type="button" class="etsy-personalizer-add">Add to cart</button></div></footer></section>`;
    document.body.appendChild(modal);
    const instance = { root, config, variants: Array.isArray(variants) ? variants : [], variantIds: new Set((Array.isArray(variants) ? variants : []).map((variant) => String(variant.id))), modal, busy: false, requiresCustomization: config.questions.some((question) => question.required) };
    instances.add(instance); root.dataset.personalizationRequired = instance.requiresCustomization ? "true" : "false";
    root.querySelector(".amzcustom-open")?.addEventListener("click", () => open(instance));
    modal.querySelector(".etsy-personalizer-close")?.addEventListener("click", () => close(instance));
    modal.querySelector(".etsy-personalizer-backdrop")?.addEventListener("click", () => close(instance));
    modal.querySelector(".etsy-personalizer-add")?.addEventListener("click", (event) => finish(instance, { button: event.currentTarget }));
    modal.querySelector(".etsy-personalizer-buy-now")?.addEventListener("click", (event) => finish(instance, { redirectToCheckout: true, button: event.currentTarget }));
    modal.querySelectorAll("textarea,select,input[type=file]").forEach((control) => control.addEventListener("input", () => updateProductContext(instance)));
    modal.querySelectorAll("select,input[type=file]").forEach((control) => control.addEventListener("change", () => updateProductContext(instance)));
    modal.querySelectorAll("[data-personalizer-text]").forEach((input) => input.addEventListener("input", () => { const count = modal.querySelector(`[data-personalizer-count="${CSS.escape(input.dataset.personalizerText)}"]`); if (count) count.textContent = String(input.value.length); }));
    root.addEventListener("hc:product-context", (event) => {
      const detail = event.detail || {};
      if (detail.variantId != null) root.dataset.variantId = String(detail.variantId);
      if (detail.quantity != null) root.dataset.quantity = String(detail.quantity);
      if (detail.price != null) root.dataset.basePrice = String(detail.price);
      if (detail.image) root.dataset.productImage = String(detail.image);
      if (detail.available != null) root.dataset.available = detail.available ? "true" : "false";
      updateProductContext(instance);
      applyRequiredPurchaseMode(instance);
    });
    root.dataset.personalizerReady = "true";
    root.dispatchEvent(new CustomEvent("etsy-personalizer:ready", { bubbles: true, detail: { required: instance.requiresCustomization } }));
    updateProductContext(instance); applyRequiredPurchaseMode(instance);
  }

  document.querySelectorAll("[data-product-personalizer-root]").forEach(init);
  if (runtime.listenersInstalled) return;
  runtime.listenersInstalled = true;
  document.addEventListener("submit", (event) => {
    const form = event.target.closest?.('form[action*="/cart/add"]'); if (!form) return;
    const instance = matchingRequiredInstance(form); if (!instance) return;
    event.preventDefault(); event.stopImmediatePropagation(); open(instance);
  }, true);
  document.addEventListener("change", (event) => {
    if (!event.target.matches?.('form[action*="/cart/add"] [name="id"]')) return;
    instances.forEach((instance) => { applyRequiredPurchaseMode(instance); updateProductContext(instance); });
  }, true);
  document.addEventListener("keydown", (event) => {
    const instance = [...instances].find((item) => !item.modal.hidden); if (!instance) return;
    if (event.key === "Escape" && !instance.busy) { event.preventDefault(); close(instance); return; }
    if (event.key !== "Tab") return;
    const focusable = [...instance.modal.querySelectorAll('button:not([disabled]),textarea:not([disabled]),select:not([disabled]),input:not([disabled])')].filter((node) => node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  runtime.observer = new MutationObserver(() => {
    instances.forEach((instance) => {
      if (instance.root.isConnected) applyRequiredPurchaseMode(instance);
      else { instance.modal.remove(); instances.delete(instance); initializedRoots.delete(instance.root); }
    });
    document.querySelectorAll("[data-product-personalizer-root]").forEach(init);
  });
  runtime.observer.observe(document.body, { childList: true, subtree: true });
})();
