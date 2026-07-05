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
      const transform = state.imageTransforms[input.id] || { scale: 1, rotation: 0 };
      layer.innerHTML = `<img alt="" src="${escapeHtml(state.images[input.id].dataUrl)}" style="transform:scale(${transform.scale}) rotate(${transform.rotation}deg)">`;
      stage.appendChild(layer);
    }
    for (const input of config.textInputs || []) {
      if (!visible(instance, input) || !state.texts[input.id]) continue;
      const layer = document.createElement("div"); layer.className = "amzcustom-layer"; layer.dataset.placementId=input.placementId||""; setBox(layer, box(config, input.placementId, state));
      const fontGroup = (config.fontGroups || []).find((group) => group.groupId && group.groupId === input.groupId) || config.fontGroups?.[0];
      const colorGroup = (config.colorGroups || []).find((group) => group.groupId && group.groupId === input.groupId) || config.colorGroups?.[0];
      const font = fontGroup?.options.find((item) => item.id === state.fonts[fontGroup.id]);
      const color = colorGroup?.options.find((item) => item.id === state.colors[colorGroup.id]);
      layer.textContent = state.texts[input.id]; layer.style.fontFamily = font?.family || "Arial"; layer.style.color = color?.value || "#000";
      layer.style.fontSize = `${Math.max(10, 28 - Math.max(0, state.texts[input.id].length - 10) * .55)}px`;
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
  function controlHtml(instance, type, item) {
    if (!visible(instance, item)) return "";
    const state = instance.state;
    if (type === "option") {
      if (item.displayHint === "choice-grid") return `<fieldset class="amzcustom-control" data-id="${item.id}"><legend>${escapeHtml(item.label)}</legend><div class="amzcustom-choices">${item.options.map((option) => `<button type="button" class="amzcustom-choice ${state.options[item.id] === option.id ? "is-selected" : ""}" data-option="${escapeHtml(option.id)}">${option.thumbnailImage ? `<img src="${escapeHtml(option.thumbnailImage.url)}" alt="">` : ""}<span>${escapeHtml(option.label)}${option.cost ? ` (+${option.cost.toLocaleString()} VND)` : ""}</span></button>`).join("")}</div></fieldset>`;
      return `<div class="amzcustom-control" data-id="${item.id}"><label>${escapeHtml(item.label)}<select>${!item.required ? '<option value="">—</option>' : ""}${item.options.map((option) => `<option value="${escapeHtml(option.id)}" ${state.options[item.id] === option.id ? "selected" : ""}>${escapeHtml(option.label)}${option.cost ? ` (+${option.cost.toLocaleString()} VND)` : ""}</option>`).join("")}</select></label></div>`;
    }
    if (type === "text") return `<div class="amzcustom-control" data-id="${item.id}"><label>${escapeHtml(item.label)}${item.maxLines > 1 ? `<textarea maxlength="${item.maxLength || ""}">${escapeHtml(state.texts[item.id] || "")}</textarea>` : `<input type="text" maxlength="${item.maxLength || ""}" value="${escapeHtml(state.texts[item.id] || "")}">`}</label><span class="amzcustom-error">${escapeHtml(state.errors[item.id] || "")}</span></div>`;
    if (type === "image") return `<div class="amzcustom-control" data-id="${item.id}"><label>${escapeHtml(item.label)}<input type="file" accept="image/png,image/jpeg,image/webp"></label><label>Zoom <input class="zoom" type="range" min="1" max="3" step=".05" value="${state.imageTransforms[item.id]?.scale || 1}"></label><label>Rotate <input class="rotate" type="range" min="-180" max="180" step="1" value="${state.imageTransforms[item.id]?.rotation || 0}"></label><span class="amzcustom-error">${escapeHtml(state.errors[item.id] || "")}</span></div>`;
    if (type === "font") return `<div class="amzcustom-control" data-id="${item.id}"><label>${escapeHtml(item.label)}<select>${item.options.map((font) => `<option value="${escapeHtml(font.id)}" ${state.fonts[item.id] === font.id ? "selected" : ""} style="font-family:${escapeHtml(font.family)}">${escapeHtml(font.family)}</option>`).join("")}</select></label></div>`;
    if (type === "color") return `<div class="amzcustom-control" data-id="${item.id}"><label>${escapeHtml(item.label)}<select>${item.options.map((color) => `<option value="${escapeHtml(color.id)}" ${state.colors[item.id] === color.id ? "selected" : ""}>${escapeHtml(color.name)}</option>`).join("")}</select></label></div>`;
    return "";
  }
  function renderControls(instance) {
    evaluate(instance);
    const maps = { option:new Map(instance.config.optionGroups.map((x)=>[x.id,x])), text:new Map(instance.config.textInputs.map((x)=>[x.id,x])), image:new Map(instance.config.imageInputs.map((x)=>[x.id,x])), font:new Map(instance.config.fontGroups.map((x)=>[x.id,x])), color:new Map(instance.config.colorGroups.map((x)=>[x.id,x])) };
    q(instance.modal, ".amzcustom-controls").innerHTML = instance.config.controlOrder.map((entry) => maps[entry.type]?.get(entry.id) ? controlHtml(instance, entry.type, maps[entry.type].get(entry.id)) : "").join("");
    bindControls(instance); renderPreview(instance);
  }
  function fileData(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); }
  function bindControls(instance) {
    q(instance.modal, ".amzcustom-controls").addEventListener("click", (event) => { const button = event.target.closest("[data-option]"); if (!button) return; instance.state.options[button.closest("[data-id]").dataset.id] = button.dataset.option; renderControls(instance); });
    q(instance.modal, ".amzcustom-controls").addEventListener("input", async (event) => {
      const group = event.target.closest("[data-id]"); if (!group) return; const id = group.dataset.id;
      if (event.target.matches('input[type="text"],textarea')) instance.state.texts[id] = event.target.value.split(/\r?\n/).slice(0, instance.config.textInputs.find((x)=>x.id===id)?.maxLines || 99).join("\n");
      if (event.target.matches('input[type="file"]') && event.target.files[0]) instance.state.images[id] = { file:event.target.files[0], dataUrl:await fileData(event.target.files[0]) };
      if (event.target.matches(".zoom")) (instance.state.imageTransforms[id] ||= {}).scale = Number(event.target.value);
      if (event.target.matches(".rotate")) (instance.state.imageTransforms[id] ||= {}).rotation = Number(event.target.value);
      if (event.target.matches("select")) { if (instance.config.optionGroups.some((x)=>x.id===id)) instance.state.options[id] = event.target.value; else if (instance.config.fontGroups.some((x)=>x.id===id)) instance.state.fonts[id] = event.target.value; else instance.state.colors[id] = event.target.value; }
      evaluate(instance); renderPreview(instance);
    });
  }
  function validate(instance) {
    const errors = {};
    for (const group of instance.config.optionGroups) if (visible(instance, group) && group.required && !instance.state.options[group.id]) errors[group.id] = "Vui lòng chọn một tùy chọn.";
    for (const input of instance.config.textInputs) { const value = instance.state.texts[input.id] || ""; if (visible(instance,input) && input.required && !value.trim()) errors[input.id] = "Bắt buộc."; else if (value.length < input.minLength) errors[input.id] = `Tối thiểu ${input.minLength} ký tự.`; }
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
      if (inner) { const image=await loadCanvasImage(inner.src); const transform=inner.style.transform.match(/scale\(([^)]+)\).*rotate\(([-\d.]+)deg\)/); const scale=Number(transform?.[1]||1), rotation=Number(transform?.[2]||0)*Math.PI/180; context.save(); context.beginPath(); context.rect(x,y,width,height); context.clip(); context.translate(x+width/2,y+height/2); context.rotate(rotation); context.drawImage(image,-width*scale/2,-height*scale/2,width*scale,height*scale); context.restore(); }
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
    modal.innerHTML = `<div class="amzcustom-backdrop"></div><section class="amzcustom-dialog" role="dialog" aria-modal="true"><header class="amzcustom-head"><h2>Customize product</h2><button class="amzcustom-close" aria-label="Close">×</button></header><div class="amzcustom-body"><div class="amzcustom-preview"><div class="amzcustom-stage"></div></div><div class="amzcustom-controls"></div></div><footer class="amzcustom-foot"><strong class="amzcustom-price"></strong><button class="amzcustom-add">Add customized item</button></footer></section>`;
    document.body.appendChild(modal); const instance={root,modal,config,state:initialState(config)}; instances.set(root,instance);
    q(root,".amzcustom-open").addEventListener("click",()=>{ modal.hidden=false; document.body.classList.add("amzcustom-locked"); renderControls(instance); });
    const close=()=>{modal.hidden=true;document.body.classList.remove("amzcustom-locked");}; q(modal,".amzcustom-close").addEventListener("click",close); q(modal,".amzcustom-backdrop").addEventListener("click",close); q(modal,".amzcustom-add").addEventListener("click",()=>finish(instance));
  }
  document.querySelectorAll("[data-amzcustom-root]").forEach(create);
})();
