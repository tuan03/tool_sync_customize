(function () {
  "use strict";
  const instances = new WeakMap();
  const q = (root, selector) => root.querySelector(selector);
  const escapeHtml = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char]));

  function parseConfig(root) {
    try { return JSON.parse(root.dataset.config); }
    catch (error) { console.error("Invalid Amazon customizer metafield", error); return null; }
  }
  function initialState(config) {
    const options = {}, fonts = {}, colors = {};
    for (const group of config.optionGroups || []) options[group.id] = group.defaultOptionId || (group.required && group.options[0] && group.options[0].id) || "";
    for (const group of config.fontGroups || []) fonts[group.id] = group.defaultFontId || (group.options[0] && group.options[0].id) || "";
    for (const group of config.colorGroups || []) colors[group.id] = group.defaultColorId || (group.options[0] && group.options[0].id) || "";
    return { options, fonts, colors, texts: {}, images: {}, imageTransforms: {}, placementOffsets: {}, visible: {}, errors: {} };
  }
  function formatMoney(value) { return `${Number(value || 0).toLocaleString()} VND`; }
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
  function textFontSize(input, boxStyles, value) {
    const width = Number(String(boxStyles.width || "100").replace("%", "")) || 100;
    const height = Number(String(boxStyles.height || "20").replace("%", "")) || 20;
    const lines = String(value || "").split(/\r?\n/);
    const longest = lines.reduce((max, line) => Math.max(max, line.length), 1);
    return `${Math.max(10, Math.min(34, height * 2.7, width * 1.55 / Math.max(1, longest * 0.08)))}px`;
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

  function renderPreview(instance) {
    const stage = q(instance.modal, ".amzcustom-stage");
    stage.innerHTML = "";
    const config = instance.config, state = instance.state;
    const surface = (config.surfaces || [])[0];
    const base = surface?.baseImage?.url || config.product.productImageUrl;
    if (base) stage.insertAdjacentHTML("beforeend", `<img alt="" src="${escapeHtml(asset(base))}">`);
    for (const group of config.optionGroups || []) {
      if (!visible(instance, group)) continue;
      const overlay = selected(group, state)?.overlayImage?.url;
      if (overlay) stage.insertAdjacentHTML("beforeend", `<img alt="" src="${escapeHtml(asset(overlay))}">`);
    }
    for (const input of config.imageInputs || []) {
      if (!visible(instance, input) || !state.images[input.id]) continue;
      const layer = document.createElement("div"); layer.className = "amzcustom-layer"; layer.dataset.placementId=input.placementId||""; setBox(layer, box(config, input.placementId, state));
      layer.dataset.editId = `image:${input.id}`;
      const transform = state.imageTransforms[input.id] || { x: 0, y: 0, scale: 1, rotation: 0 };
      layer.innerHTML = `<img alt="" src="${escapeHtml(state.images[input.id].dataUrl)}" style="transform:translate(${transform.x || 0}%,${transform.y || 0}%) scale(${transform.scale || 1}) rotate(${transform.rotation || 0}deg)">`;
      stage.appendChild(layer);
    }
    for (const input of config.textInputs || []) {
      if (!visible(instance, input) || !state.texts[input.id]) continue;
      const boxStyles = box(config, input.placementId, state);
      const layer = document.createElement("div"); layer.className = "amzcustom-layer amzcustom-text-layer"; layer.dataset.placementId=input.placementId||""; layer.dataset.editId = `text:${input.id}`; setBox(layer, boxStyles);
      const fontGroup = activeStyleGroup(instance, input, config.fontGroups || []);
      const colorGroup = activeStyleGroup(instance, input, config.colorGroups || []);
      const font = fontGroup?.options.find((item) => item.id === state.fonts[fontGroup.id]);
      const color = colorGroup?.options.find((item) => item.id === state.colors[colorGroup.id]);
      layer.textContent = state.texts[input.id]; layer.style.fontFamily = font?.family || "Arial"; layer.style.color = color?.value || "#000";
      layer.style.fontSize = textFontSize(input, boxStyles, state.texts[input.id]);
      stage.appendChild(layer);
    }
    if (surface?.maskImage?.url) stage.insertAdjacentHTML("beforeend", `<img alt="" src="${escapeHtml(asset(surface.maskImage.url))}">`);
    bindPreviewDrag(instance);
    q(instance.modal, ".amzcustom-price").textContent = `Phụ phí: ${surcharge(instance).toLocaleString()} VND`;
  }
  function bindPreviewDrag(instance) {
    const stage=q(instance.modal,".amzcustom-stage"), size=instance.config.product.previewSize||400;
    stage.querySelectorAll(".amzcustom-layer[data-placement-id]").forEach((layer)=>{
      const placement=(instance.config.placements||[]).find((item)=>item.id===layer.dataset.placementId); if(!placement?.isFreePlacement)return;
      layer.style.cursor="move";
      layer.addEventListener("pointerdown",(event)=>{event.preventDefault();layer.setPointerCapture(event.pointerId);const start={x:event.clientX,y:event.clientY},original={...(instance.state.placementOffsets[placement.id]||{x:0,y:0})};
        const move=(next)=>{const scale=size/stage.getBoundingClientRect().width;const x=original.x+(next.clientX-start.x)*scale,y=original.y+(next.clientY-start.y)*scale;instance.state.placementOffsets[placement.id]={x,y};layer.style.transform=`translate(${next.clientX-start.x}px,${next.clientY-start.y}px)`;};
        const up=()=>{layer.removeEventListener("pointermove",move);layer.removeEventListener("pointerup",up);renderPreview(instance);};layer.addEventListener("pointermove",move);layer.addEventListener("pointerup",up);
      });
    });
  }
  function controlHeader(item) {
    return `<div class="amzcustom-title"><span>${escapeHtml(item.label)}</span>${item.required ? '<em>Required</em>' : ""}</div>${item.instructions ? `<p class="amzcustom-help">${escapeHtml(item.instructions)}</p>` : ""}`;
  }
  function controlHtml(instance, type, item) {
    if (!visible(instance, item)) return "";
    const state = instance.state;
    if (type === "option") {
      const hasImages = item.options.some((option) => option.thumbnailImage || option.overlayImage);
      if (item.displayHint === "choice-grid" || hasImages) return `<section class="amzcustom-control" data-id="${item.id}">${controlHeader(item)}<div class="amzcustom-choices">${item.options.map((option) => { const img = option.thumbnailImage || option.overlayImage; return `<button type="button" class="amzcustom-choice ${state.options[item.id] === option.id ? "is-selected" : ""}" data-option="${escapeHtml(option.id)}">${img ? `<img src="${escapeHtml(img.url)}" alt="">` : ""}<span>${escapeHtml(option.label)}</span>${option.cost ? `<small>+${formatMoney(option.cost)}</small>` : ""}</button>`; }).join("")}</div><span class="amzcustom-error">${escapeHtml(state.errors[item.id] || "")}</span></section>`;
      return `<section class="amzcustom-control" data-id="${item.id}">${controlHeader(item)}<select>${!item.required ? '<option value="">No selection</option>' : ""}${item.options.map((option) => `<option value="${escapeHtml(option.id)}" ${state.options[item.id] === option.id ? "selected" : ""}>${escapeHtml(option.label)}${option.cost ? ` (+${formatMoney(option.cost)})` : ""}</option>`).join("")}</select><span class="amzcustom-error">${escapeHtml(state.errors[item.id] || "")}</span></section>`;
    }
    if (type === "text") {
      const value = state.texts[item.id] || "";
      return `<section class="amzcustom-control" data-id="${item.id}">${controlHeader(item)}${item.maxLines > 1 ? `<textarea maxlength="${item.maxLength || ""}" rows="${Math.min(item.maxLines || 3, 5)}">${escapeHtml(value)}</textarea>` : `<input type="text" maxlength="${item.maxLength || ""}" value="${escapeHtml(value)}" placeholder="${escapeHtml(item.placeholder || "")}">`}<div class="amzcustom-meta"><span>${value.length}${item.maxLength ? `/${item.maxLength}` : ""}</span></div><span class="amzcustom-error">${escapeHtml(state.errors[item.id] || "")}</span></section>`;
    }
    if (type === "image") return `<section class="amzcustom-control" data-id="${item.id}">${controlHeader(item)}<input type="file" accept="image/png,image/jpeg,image/webp"><div class="amzcustom-range"><label>Zoom <input class="zoom" type="range" min=".5" max="3" step=".05" value="${state.imageTransforms[item.id]?.scale || 1}"></label><label>Rotate <input class="rotate" type="range" min="-180" max="180" step="1" value="${state.imageTransforms[item.id]?.rotation || 0}"></label></div><span class="amzcustom-error">${escapeHtml(state.errors[item.id] || "")}</span></section>`;
    if (type === "font") return `<section class="amzcustom-control" data-id="${item.id}">${controlHeader(item)}<div class="amzcustom-fonts">${item.options.map((font) => `<button type="button" class="amzcustom-font ${state.fonts[item.id] === font.id ? "is-selected" : ""}" data-font="${escapeHtml(font.id)}" style="font-family:${escapeHtml(font.family)}">${escapeHtml(font.family)}</button>`).join("")}</div></section>`;
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
    bindControls(instance); renderPreview(instance);
  }
  function fileData(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); }
  function bindControls(instance) {
    if (instance.controlsBound) return;
    instance.controlsBound = true;
    q(instance.modal, ".amzcustom-controls").addEventListener("click", (event) => {
      const option = event.target.closest("[data-option]"), font = event.target.closest("[data-font]"), color = event.target.closest("[data-color]");
      const button = option || font || color; if (!button) return;
      const id = button.closest("[data-id]").dataset.id;
      if (option) instance.state.options[id] = option.dataset.option;
      if (font) instance.state.fonts[id] = font.dataset.font;
      if (color) instance.state.colors[id] = color.dataset.color;
      renderControls(instance);
    });
    q(instance.modal, ".amzcustom-controls").addEventListener("input", async (event) => {
      const group = event.target.closest("[data-id]"); if (!group) return; const id = group.dataset.id;
      const textInput = instance.config.textInputs.find((x)=>x.id===id);
      if (event.target.matches('input[type="text"],textarea')) { instance.state.texts[id] = normalizeText(event.target.value, textInput || {}); event.target.value = instance.state.texts[id]; }
      if (event.target.matches('input[type="file"]') && event.target.files[0]) { instance.state.images[id] = { file:event.target.files[0], dataUrl:await fileData(event.target.files[0]) }; instance.state.imageTransforms[id] ||= { x:0, y:0, scale:1, rotation:0 }; }
      if (event.target.matches(".zoom")) (instance.state.imageTransforms[id] ||= {}).scale = Number(event.target.value);
      if (event.target.matches(".rotate")) (instance.state.imageTransforms[id] ||= {}).rotation = Number(event.target.value);
      if (event.target.matches("select")) { if (instance.config.optionGroups.some((x)=>x.id===id)) instance.state.options[id] = event.target.value; else if (instance.config.fontGroups.some((x)=>x.id===id)) instance.state.fonts[id] = event.target.value; else instance.state.colors[id] = event.target.value; }
      evaluate(instance); renderPreview(instance);
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
    const json = await response.json(); if (!response.ok || !json.ok) throw new Error(json.error || "Upload thất bại"); return json.file;
  }
  async function loadCanvasImage(url) {
    const response = await fetch(url); if (!response.ok) throw new Error(`Không tải được preview asset (${response.status}).`);
    const objectUrl = URL.createObjectURL(await response.blob());
    try { return await new Promise((resolve, reject) => { const image = new Image(); image.onload=()=>resolve(image); image.onerror=reject; image.src=objectUrl; }); }
    finally { setTimeout(()=>URL.revokeObjectURL(objectUrl),0); }
  }
  async function previewDataUrl(instance) {
    const stage=q(instance.modal,".amzcustom-stage"), rect=stage.getBoundingClientRect(), size=1000;
    const canvas=document.createElement("canvas"); canvas.width=canvas.height=size; const context=canvas.getContext("2d"); context.fillStyle="#fff"; context.fillRect(0,0,size,size);
    for (const child of stage.children) {
      const childRect=child.getBoundingClientRect(), x=(childRect.left-rect.left)/rect.width*size, y=(childRect.top-rect.top)/rect.height*size, width=childRect.width/rect.width*size, height=childRect.height/rect.height*size;
      if (child.tagName === "IMG") { const image=await loadCanvasImage(child.src); context.drawImage(image,x,y,width,height); continue; }
      const inner=child.querySelector("img");
      if (inner) { const image=await loadCanvasImage(inner.src); const transform=inner.style.transform.match(/translate\(([-\d.]+)%.*,([-\d.]+)%\).*scale\(([^)]+)\).*rotate\(([-\d.]+)deg\)/); const tx=Number(transform?.[1]||0)/100*width, ty=Number(transform?.[2]||0)/100*height, scale=Number(transform?.[3]||1), rotation=Number(transform?.[4]||0)*Math.PI/180; context.save(); context.beginPath(); context.rect(x,y,width,height); context.clip(); context.translate(x+width/2+tx,y+height/2+ty); context.rotate(rotation); context.drawImage(image,-width*scale/2,-height*scale/2,width*scale,height*scale); context.restore(); }
      else { const style=getComputedStyle(child); context.fillStyle=style.color; context.font=`${Math.max(12,parseFloat(style.fontSize)/rect.width*size)}px ${style.fontFamily}`; context.textAlign="center"; context.textBaseline="middle"; const lines=child.textContent.split(/\r?\n/); lines.forEach((line,index)=>context.fillText(line,x+width/2,y+height/2+(index-(lines.length-1)/2)*32,width)); }
    }
    return canvas.toDataURL("image/png",.92);
  }
  async function finish(instance) {
    if (!validate(instance)) return renderControls(instance);
    const add = q(instance.modal, ".amzcustom-add"); add.disabled = true; add.textContent = "Đang lưu…";
    try {
      const uploadedImages = {};
      for (const [id, value] of Object.entries(instance.state.images)) uploadedImages[id] = await upload(instance, value.dataUrl);
      const previewFile=await upload(instance,await previewDataUrl(instance));
      const customizationId = crypto.randomUUID();
      const manifest = { customizationId, schemaVersion:instance.config.schemaVersion, productId:instance.root.dataset.productId, variantId:instance.root.dataset.variantId, preview:previewFile, selections:{ options:instance.state.options, texts:instance.state.texts, fonts:instance.state.fonts, colors:instance.state.colors, images:uploadedImages, imageTransforms:instance.state.imageTransforms, placementOffsets:instance.state.placementOffsets }, surcharge:surcharge(instance), createdAt:new Date().toISOString() };
      const manifestUrl = `data:application/json;base64,${btoa(unescape(encodeURIComponent(JSON.stringify(manifest))))}`;
      const manifestFile = await upload(instance, manifestUrl);
      const summary = Object.values(instance.state.texts).filter(Boolean).join(" | ").slice(0, 220) || "Customized product";
      const properties={ Customization:summary, "_customization_id":customizationId, "_customization_preview":previewFile.url, "_customization_manifest":manifestFile.url, "_customization_fee":String(manifest.surcharge), "_customization_options":JSON.stringify(instance.state.options), "_customization_schema":String(instance.config.schemaVersion) };
      const items = [{ id:Number(instance.root.dataset.variantId), quantity:1, properties }];
      const feeCounts={}; for(const group of instance.config.optionGroups){const option=selected(group,instance.state);if(option?.cost>0)feeCounts[option.cost]=(feeCounts[option.cost]||0)+1;}
      for(const [amount,quantity] of Object.entries(feeCounts)){const gid=instance.config.pricing.variantIds?.[amount];if(!gid)throw new Error(`Thiếu add-on variant cho phụ phí ${amount} VND. Hãy Sync lại product.`);items.push({id:Number(String(gid).split("/").pop()),parent_id:Number(instance.root.dataset.variantId),quantity,properties:{"_customization_id":customizationId,"_customization_parent_variant":instance.root.dataset.variantId,"_customization_fee_component":amount}});}
      const addResponse = await fetch(`${window.Shopify.routes.root}cart/add.js`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({items}) });
      if (!addResponse.ok) throw new Error((await addResponse.json()).description || "Không thể thêm vào giỏ hàng.");
      window.location.href = `${window.Shopify.routes.root}cart`;
    } catch (error) { alert(error.message); add.disabled = false; add.textContent = "Add customized item"; }
  }
  function create(root) {
    const config = parseConfig(root); if (!config || instances.has(root)) return;
    for(const group of config.fontGroups||[])for(const font of group.options||[]){if(!font.fontUrl)continue;const style=document.createElement("style");style.textContent=`@font-face{font-family:${JSON.stringify(font.family)};src:url(${JSON.stringify(font.fontUrl)});font-display:swap}`;document.head.appendChild(style);}
    const modal = document.createElement("div"); modal.className="amzcustom-modal"; modal.hidden=true;
    modal.innerHTML = `<div class="amzcustom-backdrop"></div><section class="amzcustom-dialog" role="dialog" aria-modal="true"><header class="amzcustom-head"><h2>Customize your product</h2><button class="amzcustom-close" aria-label="Close">×</button></header><div class="amzcustom-body"><div class="amzcustom-preview"><div class="amzcustom-stage"></div></div><div class="amzcustom-controls"></div></div><footer class="amzcustom-foot"><strong class="amzcustom-price"></strong><button class="amzcustom-add">Add customized item</button></footer></section>`;
    document.body.appendChild(modal); const instance={root,modal,config,state:initialState(config)}; instances.set(root,instance);
    q(root,".amzcustom-open").addEventListener("click",()=>{ modal.hidden=false; document.body.classList.add("amzcustom-locked"); renderControls(instance); });
    const close=()=>{modal.hidden=true;document.body.classList.remove("amzcustom-locked");}; q(modal,".amzcustom-close").addEventListener("click",close); q(modal,".amzcustom-backdrop").addEventListener("click",close); q(modal,".amzcustom-add").addEventListener("click",()=>finish(instance));
  }
  document.querySelectorAll("[data-amzcustom-root]").forEach(create);
})();
