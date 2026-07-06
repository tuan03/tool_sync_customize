(function () {
  const $ = (selector) => document.querySelector(selector);

  const elements = {
    form: $("#load-form"),
    url: $("#custom-url"),
    status: $("#status"),
    workspace: $("#workspace"),
    title: $("#product-title"),
    meta: $("#product-meta"),
    price: $("#price-delta"),
    stage: $("#preview-stage"),
    controls: $("#controls"),
    warnings: $("#warnings"),
    validationSummary: $("#validation-summary"),
    exportJson: $("#export-json"),
    exportPng: $("#export-png"),
    exportOutput: $("#export-output"),
  };

  const state = {
    sourceUrl: "",
    config: null,
    selectedSurfaceId: null,
    selectedOptions: {},
    textValues: {},
    imageValues: {},
    imageTransforms: {},
    textTransforms: {},
    selectedFonts: {},
    selectedColors: {},
    placementOverrides: {},
    visibleComponents: {},
    validationErrors: {},
    activeEditId: "",
    expandedOptionGroups: {},
    promotedOptionIds: {},
    priceDeltaTotal: 0,
    exportedPersonalization: null,
  };
  const loadedFontFamilies = new Set();
  const TEXT_LINE_HEIGHT = 1.18;
  const textMeasureCanvas = document.createElement("canvas");
  const textMeasureContext = textMeasureCanvas.getContext("2d");

  function setStatus(message, isError) {
    elements.status.textContent = message || "";
    elements.status.classList.toggle("is-error", Boolean(isError));
  }

  function assetUrl(url) {
    if (!url) return "";
    return `/api/asset?url=${encodeURIComponent(url)}`;
  }

  function formatMoney(value) {
    return `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(2)}`;
  }

  function placementById(id) {
    return state.config.placements.find((placement) => placement.id === id);
  }

  function optionGroupById(id) {
    return state.config.optionGroups.find((group) => group.id === id);
  }

  function orderedOptionGroups() {
    const byId = new Map(state.config.optionGroups.map((group) => [group.id, group]));
    const ordered = [];
    const seen = new Set();
    for (const entry of state.config.controlOrder || []) {
      if (entry.type !== "option" || seen.has(entry.id)) continue;
      const group = byId.get(entry.id);
      if (group) {
        ordered.push(group);
        seen.add(entry.id);
      }
    }
    for (const group of state.config.optionGroups) {
      if (!seen.has(group.id)) ordered.push(group);
    }
    return ordered;
  }

  function orderedRenderableControls() {
    const maps = {
      option: new Map(state.config.optionGroups.map((item) => [item.id, item])),
      image: new Map(state.config.imageInputs.map((item) => [item.id, item])),
      text: new Map(state.config.textInputs.map((item) => [item.id, item])),
    };
    const seen = new Set();
    const ordered = [];
    for (const entry of state.config.controlOrder || []) {
      if (!maps[entry.type]) continue;
      const key = `${entry.type}:${entry.id}`;
      if (seen.has(key)) continue;
      const item = maps[entry.type].get(entry.id);
      if (item) {
        ordered.push({ type: entry.type, item });
        seen.add(key);
      }
    }
    for (const type of ["option", "image", "text"]) {
      for (const item of maps[type].values()) {
        const key = `${type}:${item.id}`;
        if (!seen.has(key)) ordered.push({ type, item });
      }
    }
    return ordered;
  }

  function selectedOption(group) {
    return group.options.find((option) => option.id === state.selectedOptions[group.id]);
  }

  function defaultOptionId(group) {
    if (group.defaultOptionId) return group.defaultOptionId;
    if (!group.options.length) return "";
    const first = group.options[0];
    if (group.required || Number(first.cost || 0) === 0) return first.id;
    return "";
  }

  function cssFontFamily(family) {
    return `"${String(family || "").replace(/"/g, '\\"')}", Arial, Helvetica, sans-serif`;
  }

  function ensureFontLoaded(font) {
    if (!font || !font.family || loadedFontFamilies.has(font.family)) return;
    loadedFontFamilies.add(font.family);
    if (font.fontUrl) {
      const style = document.createElement("style");
      style.textContent = `@font-face{font-family:${JSON.stringify(font.family)};src:url("${assetUrl(font.fontUrl)}");font-display:swap;}`;
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

  function loadConfiguredFonts(config) {
    for (const group of config.fontGroups || []) {
      for (const font of group.options || []) ensureFontLoaded(font);
    }
  }

  function fieldError(id) {
    return state.validationErrors[id] || "";
  }

  function setActiveEdit(editId) {
    state.activeEditId = editId || "";
    document.querySelectorAll(".placement-layer.is-active-edit").forEach((item) => {
      item.classList.toggle("is-active-edit", item.dataset.editId === state.activeEditId);
    });
    document.querySelectorAll(".control-group.is-active-edit").forEach((item) => {
      item.classList.remove("is-active-edit");
    });
    if (state.activeEditId) {
      const [, id] = state.activeEditId.split(":");
      const control = elements.controls.querySelector(`[data-control-id="${CSS.escape(id)}"]`);
      if (control) control.classList.add("is-active-edit");
    }
  }

  function ancestorIds(id) {
    const ids = [];
    let current = id;
    const parentMap = state.config.componentParent || {};
    while (parentMap[current]) {
      current = parentMap[current];
      ids.push(current);
    }
    return ids;
  }

  function isComponentVisible(id) {
    if (!id) return true;
    if (state.visibleComponents[id] === false) return false;
    return ancestorIds(id).every((ancestorId) => state.visibleComponents[ancestorId] !== false);
  }

  function isControlVisible(control) {
    if (!isComponentVisible(control.id)) return false;
    if (control.placementId && !isComponentVisible(control.placementId)) return false;
    if (control.groupId && !isComponentVisible(control.groupId)) return false;
    return true;
  }

  function evaluateConditionals() {
    state.visibleComponents = {};
    const rulesByDependent = new Map();

    for (const rule of state.config.conditionalRules || []) {
      if (!rule.dependentId) continue;
      if (!rulesByDependent.has(rule.dependentId)) rulesByDependent.set(rule.dependentId, []);
      rulesByDependent.get(rule.dependentId).push(rule);
    }

    for (const [dependentId, rules] of rulesByDependent.entries()) {
      let visible = false;
      for (const rule of rules) {
        const matcher = rule.matcher || {};
        let matches = true;

        if (matcher.matcherType === "ChoiceMatcher") {
          const selectedId = state.selectedOptions[matcher.componentIdentifier];
          matches = (matcher.choiceIds || []).includes(selectedId);
        }

        if (matches) {
          visible = true;
          break;
        }
      }
      state.visibleComponents[dependentId] = visible;
    }
  }

  function initializeState(config, sourceUrl) {
    state.sourceUrl = sourceUrl;
    state.config = config;
    state.selectedSurfaceId = config.surfaces[0] && config.surfaces[0].id;
    state.selectedOptions = {};
    state.textValues = {};
    state.imageValues = {};
    state.imageTransforms = {};
    state.textTransforms = {};
    state.selectedFonts = {};
    state.selectedColors = {};
    state.placementOverrides = {};
    state.validationErrors = {};
    state.activeEditId = "";
    state.expandedOptionGroups = {};
    state.promotedOptionIds = {};
    state.exportedPersonalization = null;
    loadConfiguredFonts(config);

    for (const group of config.optionGroups) {
      state.selectedOptions[group.id] = defaultOptionId(group);
    }

    for (const input of config.textInputs) {
      state.textValues[input.id] = "";
    }

    for (const fontGroup of config.fontGroups) {
      state.selectedFonts[fontGroup.id] =
        fontGroup.defaultFontId || (fontGroup.options[0] && fontGroup.options[0].id) || "";
    }

    for (const colorGroup of config.colorGroups) {
      state.selectedColors[colorGroup.id] =
        colorGroup.defaultColorId || (colorGroup.options[0] && colorGroup.options[0].id) || "";
    }

    for (const placement of config.placements) {
      state.placementOverrides[placement.id] = {
        x: placement.position.x || 0,
        y: placement.position.y || 0,
        width: placement.dimension.width || config.product.previewSize,
        height: placement.dimension.height || config.product.previewSize,
      };
    }

    evaluateConditionals();
    calculatePrice();
  }

  function calculatePrice() {
    let total = 0;
    for (const group of orderedOptionGroups()) {
      if (!isComponentVisible(group.id)) continue;
      const option = selectedOption(group);
      if (option && option.cost) total += Number(option.cost);
    }
    state.priceDeltaTotal = total;
    elements.price.textContent = formatMoney(total);
  }

  function commonAncestorScore(control, group) {
    const controlAncestors = new Set(control.ancestors || []);
    return (group.ancestors || []).reduce((score, id, index) => {
      return controlAncestors.has(id) ? score + index + 1 : score;
    }, 0);
  }

  function bestStyleGroup(control, groups) {
    let best = null;
    let bestScore = -1;
    for (const group of groups) {
      if (!isControlVisible(group)) continue;
      const score = commonAncestorScore(control, group);
      if (score > bestScore) {
        best = group;
        bestScore = score;
      }
    }
    return best;
  }

  function activeFont(control) {
    const group = bestStyleGroup(control || {}, state.config.fontGroups) || state.config.fontGroups[0];
    if (!group) return "Arial, Helvetica, sans-serif";
    const selected = group.options.find((font) => font.id === state.selectedFonts[group.id]);
    if (selected) ensureFontLoaded(selected);
    return selected ? cssFontFamily(selected.family) : "Arial, Helvetica, sans-serif";
  }

  function activeColor(control) {
    const group = bestStyleGroup(control || {}, state.config.colorGroups) || state.config.colorGroups[0];
    if (!group) return "#111111";
    const selected = group.options.find((color) => color.id === state.selectedColors[group.id]);
    return selected ? selected.value : "#111111";
  }

  function stageScale() {
    const size = state.config.product.previewSize || 400;
    return elements.stage.clientWidth / size;
  }

  function placeStyle(placementId) {
    const placement = placementById(placementId);
    const box = state.placementOverrides[placementId] || {
      x: 0,
      y: 0,
      width: state.config.product.previewSize,
      height: state.config.product.previewSize,
    };
    const scale = stageScale();
    return {
      placement,
      box,
      css: {
        left: `${box.x * scale}px`,
        top: `${box.y * scale}px`,
        width: `${box.width * scale}px`,
        height: `${box.height * scale}px`,
      },
    };
  }

  function textScaleFor(inputId) {
    return (state.textTransforms[inputId] && state.textTransforms[inputId].scale) || 1;
  }

  function isSingleLineText(input) {
    return Number(input && input.maxLines || 1) <= 1;
  }

  function textLines(input, value) {
    const text = String(value || "");
    if (isSingleLineText(input)) return [text.replace(/\r?\n/g, " ")];
    return text.split(/\r?\n/);
  }

  function textFontSize(input, cssOrBox, textValue, fontFamily) {
    const rawHeight =
      typeof cssOrBox.height === "string" ? Number(cssOrBox.height.replace("px", "")) : Number(cssOrBox.height);
    const rawWidth =
      typeof cssOrBox.width === "string" ? Number(cssOrBox.width.replace("px", "")) : Number(cssOrBox.width);
    const lines = textLines(input, textValue);
    const maxFont = Math.max(4, Math.min(48, ((rawHeight || 24) / Math.max(1, lines.length * TEXT_LINE_HEIGHT)) * textScaleFor(input.id)));
    let size = maxFont;
    if (textMeasureContext) {
      textMeasureContext.font = `${size}px ${fontFamily || activeFont(input)}`;
      const measured = Math.max(1, ...lines.map((line) => textMeasureContext.measureText(line || " ").width));
      size = Math.min(size, size * ((rawWidth || 120) * 0.98) / measured);
    } else {
      const longestLine = lines.reduce((longest, line) => Math.max(longest, line.length), 1);
      size = Math.min(size, (rawWidth || 120) / Math.max(1, longestLine * 0.58));
    }
    return Math.max(4, Math.min(48, size));
  }

  function normalizeTextValue(value, input) {
    let next = String(value || "");
    if (input.maxLines && input.maxLines > 0) {
      next = next.split(/\r?\n/).slice(0, input.maxLines).join("\n");
    }
    if (input.maxLength && next.length > input.maxLength) {
      next = next.slice(0, input.maxLength);
    }
    return next;
  }

  function applyBoxStyle(element, css) {
    element.style.left = css.left;
    element.style.top = css.top;
    element.style.width = css.width;
    element.style.height = css.height;
  }

  function renderWarnings() {
    elements.warnings.innerHTML = "";
    const visibleWarnings = (state.config.warnings || []).filter(
      (warning) => !["LOCAL_HAR_FALLBACK", "UNRESOLVED_REGEX_CHOICES"].includes(warning.code)
    );
    for (const warning of visibleWarnings) {
      const item = document.createElement("div");
      item.className = "warning";
      item.textContent = warning.message || warning.code;
      elements.warnings.appendChild(item);
    }
  }

  function createControlGroup(title, required, instructions, value) {
    const section = document.createElement("section");
    section.className = "control-group";
    const header = document.createElement("div");
    header.className = "control-title";
    const suffix = value ? `: ${value}` : "";
    header.innerHTML = `<h3>${escapeHtml(title)}${escapeHtml(suffix)}${required ? "" : ' <span class="optional">(optional)</span>'}</h3>`;
    section.appendChild(header);
    const help = visibleInstructions(instructions);
    if (help) {
      const p = document.createElement("p");
      p.className = "instructions";
      p.textContent = help;
      section.appendChild(p);
    }
    return section;
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
  function isYesNoGroup(group) {
    const labels = (group.options || []).map((option) => String(option.label || "").trim().toUpperCase()).sort();
    return labels.length === 2 && labels[0] === "NO" && labels[1] === "YES";
  }
  function isTextChoiceGroup(group) {
    const label = String(group.label || "");
    return /(?:item\s+size|matching|tapestry|pillow|purchase)/i.test(label) && !isYesNoGroup(group);
  }
  function isBackgroundOptionGroup(group) {
    return /background\s*color/i.test(`${group.label || ""} ${group.instructions || ""}`);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const COLLAPSED_OPTION_LIMIT = 10;

  function renderOptionGroup(group) {
    if (!isComponentVisible(group.id)) return null;

    const selectedValue = group.options.find((option) => option.id === state.selectedOptions[group.id])?.label || "";
    const section = createControlGroup(group.label, group.required, group.instructions, selectedValue);
    section.dataset.controlId = group.id;
    const hasImages = group.options.some((option) => option.thumbnailImage || option.overlayImage);
    const renderAsGrid = group.displayHint !== "select" || hasImages || isTextChoiceGroup(group);

    if (renderAsGrid) {
      const grid = document.createElement("div");
      grid.className = "option-grid";
      if (isYesNoGroup(group)) grid.classList.add("is-yes-no");
      if (isTextChoiceGroup(group)) grid.classList.add("is-text-choice");
      const isMobile = window.matchMedia && window.matchMedia("(max-width: 560px)").matches;
      const shouldCollapse = !isMobile && group.options.length > COLLAPSED_OPTION_LIMIT;
      const expanded = state.expandedOptionGroups[group.id] === true;
      if (shouldCollapse && !expanded) grid.classList.add("is-collapsed");
      if (expanded) grid.classList.add("is-expanded");

      const promotedOption = group.options.find((option) => option.id === state.promotedOptionIds[group.id]);
      const primaryOptions = shouldCollapse
        ? [...(promotedOption ? [promotedOption] : []), ...group.options.filter((option) => option.id !== promotedOption?.id)].slice(0, COLLAPSED_OPTION_LIMIT)
        : group.options;
      const visibleOptions = shouldCollapse ? primaryOptions : group.options;
      const optionItems = !group.required ? [{ id: "", label: "No selection", cost: 0, noSelection: true }, ...visibleOptions] : visibleOptions;
      for (const option of optionItems) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "option-card";
        button.classList.toggle("is-selected", state.selectedOptions[group.id] === option.id);
        const image = option.thumbnailImage || option.overlayImage;
        if (!image) button.classList.add("has-no-image");
        button.innerHTML = `
          ${
            image
              ? `<img class="option-thumb" src="${assetUrl(image.url)}" alt="">`
              : ""
          }
          <span class="option-name">${escapeHtml(option.label)}</span>
          ${option.cost ? `<span class="option-cost">${formatMoney(option.cost)}</span>` : ""}
        `;
        button.addEventListener("click", () => {
          const scrollTop = window.scrollY;
          const scrollLeft = grid.scrollLeft;
          state.selectedOptions[group.id] = option.id;
          delete state.promotedOptionIds[group.id];
          evaluateConditionals();
          calculatePrice();
          renderAll();
          requestAnimationFrame(() => {
            window.scrollTo(0, scrollTop);
            const nextGrid = elements.controls.querySelector(`[data-control-id="${CSS.escape(group.id)}"] .option-grid`);
            if (nextGrid) nextGrid.scrollLeft = scrollLeft;
            setTimeout(() => {
              window.scrollTo(0, scrollTop);
              const nextGrid = elements.controls.querySelector(`[data-control-id="${CSS.escape(group.id)}"] .option-grid`);
              if (nextGrid) nextGrid.scrollLeft = scrollLeft;
            }, 0);
          });
        });
        grid.appendChild(button);
      }

      section.appendChild(grid);
      if (shouldCollapse) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "option-toggle secondary-button";
        toggle.textContent = expanded ? "See less" : `See all ${group.options.length} options`;
        toggle.addEventListener("click", () => {
          const scrollTop = window.scrollY;
          state.expandedOptionGroups[group.id] = !state.expandedOptionGroups[group.id];
          renderAll();
          requestAnimationFrame(() => {
            window.scrollTo(0, scrollTop);
            positionOptionLists();
            setTimeout(() => { window.scrollTo(0, scrollTop); positionOptionLists(); }, 0);
          });
        });
        section.appendChild(toggle);
        if (expanded) {
          const list = document.createElement("div");
          list.className = "option-list";
          const primaryIds = new Set(primaryOptions.map((option) => option.id));
          for (const option of group.options.filter((option) => !primaryIds.has(option.id))) {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "option-row";
            row.classList.toggle("is-selected", state.selectedOptions[group.id] === option.id);
            const image = option.thumbnailImage || option.overlayImage;
            row.innerHTML = `${image ? `<img src="${assetUrl(image.url)}" alt="">` : '<span class="option-row-icon"></span>'}<span>${escapeHtml(option.label)}</span>`;
            row.addEventListener("click", () => {
              const scrollTop = window.scrollY;
              const scrollLeft = grid.scrollLeft;
              state.selectedOptions[group.id] = option.id;
              state.promotedOptionIds[group.id] = option.id;
              state.expandedOptionGroups[group.id] = false;
              evaluateConditionals();
              calculatePrice();
              renderAll();
              requestAnimationFrame(() => {
                window.scrollTo(0, scrollTop);
                const nextGrid = elements.controls.querySelector(`[data-control-id="${CSS.escape(group.id)}"] .option-grid`);
                if (nextGrid) nextGrid.scrollLeft = scrollLeft;
                setTimeout(() => {
                  window.scrollTo(0, scrollTop);
                  const nextGrid = elements.controls.querySelector(`[data-control-id="${CSS.escape(group.id)}"] .option-grid`);
                  if (nextGrid) nextGrid.scrollLeft = scrollLeft;
                }, 0);
              });
            });
            list.appendChild(row);
          }
          section.appendChild(list);
        }
      }
    } else {
      const field = document.createElement("div");
      field.className = "control-field";
      const select = document.createElement("select");
      if (!group.required && !state.selectedOptions[group.id]) {
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "No selection";
        placeholder.selected = !state.selectedOptions[group.id];
        select.appendChild(placeholder);
      }
      for (const option of group.options) {
        const opt = document.createElement("option");
        opt.value = option.id;
        opt.textContent = option.cost ? `${option.label} (${formatMoney(option.cost)})` : option.label;
        opt.selected = state.selectedOptions[group.id] === option.id;
        select.appendChild(opt);
      }
      select.addEventListener("change", () => {
        state.selectedOptions[group.id] = select.value;
        evaluateConditionals();
        calculatePrice();
        renderAll();
      });
      field.appendChild(select);
      section.appendChild(field);
    }

    const error = document.createElement("div");
    error.className = "field-error";
    error.textContent = fieldError(group.id);
    section.appendChild(error);
    return section;
  }

  function renderTextInput(input) {
    if (!isControlVisible(input)) return null;

    const section = createControlGroup(input.label, input.required, input.instructions);
    section.dataset.controlId = input.id;
    section.classList.toggle("is-active-edit", state.activeEditId === `text:${input.id}`);
    const field = document.createElement("div");
    field.className = "control-field";
    const control = input.maxLines > 1 ? document.createElement("textarea") : document.createElement("input");

    if (control.tagName === "INPUT") control.type = "text";
    control.value = state.textValues[input.id] || "";
    control.placeholder = input.placeholder || "";
    if (input.maxLength) control.maxLength = input.maxLength;
    if (input.maxLines > 1) control.rows = Math.min(input.maxLines, 6);

    control.addEventListener("focus", () => {
      setActiveEdit(`text:${input.id}`);
    });

    control.addEventListener("input", () => {
      const normalized = normalizeTextValue(control.value, input);
      if (control.value !== normalized) control.value = normalized;
      state.textValues[input.id] = normalized;
      validate();
      renderPreview();
      renderValidationSummary();
      updateExportOutput(false);
      const error = section.querySelector(".field-error");
      error.textContent = fieldError(input.id);
      const counter = section.querySelector(".field-meta span:last-child");
      if (counter) counter.textContent = `${normalized.length}${input.maxLength ? `/${input.maxLength}` : ""}`;
    });

    field.appendChild(control);
    const meta = document.createElement("div");
    meta.className = "field-meta";
    meta.innerHTML = `<span>${input.maxLines > 1 ? `${input.maxLines} lines max` : "Single line"}</span><span>${
      control.value.length
    }${input.maxLength ? `/${input.maxLength}` : ""}</span>`;
    field.appendChild(meta);
    const placement = input.placementId && placementById(input.placementId);
    if (placement && placement.isFreePlacement) {
      const scaleWrap = document.createElement("div");
      scaleWrap.className = "zoom-control";
      const label = document.createElement("span");
      label.textContent = "Text size";
      const range = document.createElement("input");
      range.type = "range";
      range.min = "0.5";
      range.max = "2";
      range.step = "0.01";
      range.value = String(textScaleFor(input.id));
      range.addEventListener("input", () => {
        state.textTransforms[input.id] = {
          ...(state.textTransforms[input.id] || {}),
          scale: Number(range.value),
        };
        renderPreview();
        updateExportOutput(false);
      });
      scaleWrap.append(label, range);
      field.appendChild(scaleWrap);

      const actions = document.createElement("div");
      actions.className = "edit-actions";
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "secondary-button";
      reset.textContent = "Reset text";
      reset.addEventListener("click", () => {
        delete state.textTransforms[input.id];
        const placement = placementById(input.placementId);
        if (placement) {
          state.placementOverrides[input.placementId] = {
            x: placement.position.x || 0,
            y: placement.position.y || 0,
            width: placement.dimension.width || state.config.product.previewSize,
            height: placement.dimension.height || state.config.product.previewSize,
          };
        }
        renderAll();
      });
      actions.append(reset);
      field.appendChild(actions);
    }
    const error = document.createElement("div");
    error.className = "field-error";
    error.textContent = fieldError(input.id);
    field.appendChild(error);
    section.appendChild(field);
    return section;
  }

  function renderImageInput(input) {
    if (!isControlVisible(input)) return null;

    const section = createControlGroup(input.label, input.required, input.instructions);
    section.dataset.controlId = input.id;
    section.classList.toggle("is-active-edit", state.activeEditId === `image:${input.id}`);
    const field = document.createElement("div");
    field.className = "control-field";
    const control = document.createElement("input");
    control.type = "file";
    control.accept = "image/*";
    control.addEventListener("focus", () => {
      setActiveEdit(`image:${input.id}`);
    });
    control.addEventListener("change", () => {
      const file = control.files && control.files[0];
      if (!file) return;
      if (state.imageValues[input.id] && state.imageValues[input.id].objectUrl) {
        URL.revokeObjectURL(state.imageValues[input.id].objectUrl);
      }
      state.imageValues[input.id] = {
        file,
        fileName: file.name,
        objectUrl: URL.createObjectURL(file),
        placement: state.placementOverrides[input.placementId],
      };
      state.imageTransforms[input.id] = { x: 0, y: 0, scale: 1.18, rotation: 0 };
      renderAll();
    });
    field.appendChild(control);

    const value = state.imageValues[input.id];
    const placement = input.placementId && placementById(input.placementId);
    if (value && placement && placement.isFreePlacement) {
      const zoomWrap = document.createElement("div");
      zoomWrap.className = "zoom-control";
      const label = document.createElement("span");
      label.textContent = "Zoom";
      const range = document.createElement("input");
      range.type = "range";
      range.min = "1";
      range.max = "3";
      range.step = "0.01";
      range.value = String((state.imageTransforms[input.id] && state.imageTransforms[input.id].scale) || 1.18);
      range.addEventListener("input", () => {
        state.imageTransforms[input.id] = {
          ...(state.imageTransforms[input.id] || { x: 0, y: 0 }),
          scale: Number(range.value),
        };
        renderPreview();
        updateExportOutput(false);
      });
      zoomWrap.append(label, range);
      field.appendChild(zoomWrap);

      const rotateWrap = document.createElement("div");
      rotateWrap.className = "zoom-control";
      const rotateLabel = document.createElement("span");
      rotateLabel.textContent = "Rotate";
      const rotate = document.createElement("input");
      rotate.type = "range";
      rotate.min = "-180";
      rotate.max = "180";
      rotate.step = "1";
      rotate.value = String((state.imageTransforms[input.id] && state.imageTransforms[input.id].rotation) || 0);
      rotate.addEventListener("input", () => {
        state.imageTransforms[input.id] = {
          ...(state.imageTransforms[input.id] || { x: 0, y: 0, scale: 1.18 }),
          rotation: Number(rotate.value),
        };
        renderPreview();
        updateExportOutput(false);
      });
      rotateWrap.append(rotateLabel, rotate);
      field.appendChild(rotateWrap);

      const actions = document.createElement("div");
      actions.className = "edit-actions";
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "secondary-button";
      reset.textContent = "Reset position";
      reset.addEventListener("click", () => {
        state.imageTransforms[input.id] = { x: 0, y: 0, scale: 1.18, rotation: 0 };
        renderAll();
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary-button";
      remove.textContent = "Remove image";
      remove.addEventListener("click", () => {
        if (state.imageValues[input.id] && state.imageValues[input.id].objectUrl) {
          URL.revokeObjectURL(state.imageValues[input.id].objectUrl);
        }
        delete state.imageValues[input.id];
        delete state.imageTransforms[input.id];
        renderAll();
      });
      actions.append(reset, remove);
      field.appendChild(actions);
    }

    const error = document.createElement("div");
    error.className = "field-error";
    error.textContent = fieldError(input.id);
    field.appendChild(error);
    section.appendChild(field);
    return section;
  }

  function renderFontGroup(group) {
    if (!isControlVisible(group)) return null;

    const section = createControlGroup(group.label, false, group.instructions);
    const field = document.createElement("div");
    field.className = "control-field";

    const dropdown = document.createElement("details");
    dropdown.className = "font-dropdown";
    const summary = document.createElement("summary");
    const selectedFont = group.options.find((font) => font.id === state.selectedFonts[group.id]) || group.options[0];
    summary.textContent = selectedFont ? selectedFont.family : "Select font";
    if (selectedFont) summary.style.fontFamily = cssFontFamily(selectedFont.family);
    dropdown.appendChild(summary);

    const choiceList = document.createElement("div");
    choiceList.className = "font-choice-list";
    function syncFontChoices() {
      for (const button of choiceList.querySelectorAll(".font-choice")) {
        button.classList.toggle("is-selected", button.dataset.fontId === state.selectedFonts[group.id]);
      }
      const selected = group.options.find((font) => font.id === state.selectedFonts[group.id]);
      if (selected) {
        summary.textContent = selected.family;
        summary.style.fontFamily = cssFontFamily(selected.family);
      }
    }
    for (const font of group.options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "font-choice";
      button.dataset.fontId = font.id;
      button.textContent = font.family;
      button.style.fontFamily = cssFontFamily(font.family);
      button.addEventListener("click", () => {
        state.selectedFonts[group.id] = font.id;
        ensureFontLoaded(font);
        syncFontChoices();
        dropdown.open = false;
        renderPreview();
        updateExportOutput(false);
        if (document.fonts) document.fonts.ready.then(renderPreview).catch(() => {});
      });
      choiceList.appendChild(button);
    }
    syncFontChoices();
    dropdown.appendChild(choiceList);
    field.appendChild(dropdown);
    section.appendChild(field);
    return section;
  }

  function renderColorGroup(group) {
    if (!isControlVisible(group)) return null;
    if ((group.options || []).length <= 1) return null;

    const section = createControlGroup(group.label, false, group.instructions);
    const row = document.createElement("div");
    row.className = "swatch-row";
    for (const color of group.options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "swatch";
      button.title = `${color.name} ${color.value}`;
      button.style.setProperty("--swatch-color", color.value || "#fff");
      button.classList.toggle("is-selected", state.selectedColors[group.id] === color.id);
      button.addEventListener("click", () => {
        state.selectedColors[group.id] = color.id;
        renderAll();
      });
      row.appendChild(button);
    }
    section.appendChild(row);
    return section;
  }

  function renderControls() {
    elements.controls.innerHTML = "";

    const maps = {
      option: new Map(state.config.optionGroups.map((item) => [item.id, item])),
      text: new Map(state.config.textInputs.map((item) => [item.id, item])),
      image: new Map(state.config.imageInputs.map((item) => [item.id, item])),
      font: new Map(state.config.fontGroups.map((item) => [item.id, item])),
      color: new Map(state.config.colorGroups.map((item) => [item.id, item])),
    };
    const renderers = {
      option: renderOptionGroup,
      text: renderTextInput,
      image: renderImageInput,
      font: renderFontGroup,
      color: renderColorGroup,
    };
    const order =
      state.config.controlOrder && state.config.controlOrder.length
        ? state.config.controlOrder
        : [
            ...state.config.optionGroups.map((item) => ({ type: "option", id: item.id })),
            ...state.config.textInputs.map((item) => ({ type: "text", id: item.id })),
            ...state.config.imageInputs.map((item) => ({ type: "image", id: item.id })),
            ...state.config.fontGroups.map((item) => ({ type: "font", id: item.id })),
            ...state.config.colorGroups.map((item) => ({ type: "color", id: item.id })),
          ];
    const seen = new Set();
    const controls = order
      .map((entry) => {
        const key = `${entry.type}:${entry.id}`;
        if (seen.has(key)) return null;
        seen.add(key);
        const item = maps[entry.type] && maps[entry.type].get(entry.id);
        const renderer = renderers[entry.type];
        return item && renderer ? renderer(item) : null;
      })
      .filter(Boolean);

    if (!controls.length) {
      elements.controls.className = "controls-empty";
      elements.controls.textContent = "No supported customization controls found.";
      return;
    }

    elements.controls.className = "";
    for (const control of controls) elements.controls.appendChild(control);
    requestAnimationFrame(positionOptionLists);
  }

  function positionOptionLists() {
    const viewportTop = 0;
    const viewportBottom = window.innerHeight;
    elements.controls.querySelectorAll(".option-list").forEach((list) => {
      const control = list.closest(".control-group");
      const toggle = control && control.querySelector(".option-toggle");
      if (!control || !toggle) return;
      list.classList.remove("is-above", "is-below");
      list.style.top = "";
      list.style.bottom = "";
      list.style.maxHeight = "";
      const toggleRect = toggle.getBoundingClientRect();
      const availableBelow = viewportBottom - toggleRect.bottom - 16;
      const availableAbove = toggleRect.top - viewportTop - 16;
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

  function renderPreview() {
    if (!state.config) return;
    elements.stage.innerHTML = "";
    const surface = state.config.surfaces.find((item) => item.id === state.selectedSurfaceId) || state.config.surfaces[0];
    const baseImage = surface && surface.baseImage ? surface.baseImage : null;
    const productImage = state.config.product.productImageUrl;

    if (baseImage || productImage) {
      const img = document.createElement("img");
      img.className = "preview-layer preview-fill preview-base";
      img.alt = "";
      img.src = assetUrl((baseImage && baseImage.url) || productImage);
      elements.stage.appendChild(img);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "preview-placeholder";
      placeholder.textContent = "No base image found";
      elements.stage.appendChild(placeholder);
    }

    const controls = orderedRenderableControls();
    for (const entry of controls.filter((item) => item.type === "option" && isBackgroundOptionGroup(item.item))) {
      const group = entry.item;
      if (!isComponentVisible(group.id)) continue;
      const option = selectedOption(group);
      if (!option || !option.overlayImage) continue;
      const overlay = document.createElement("img");
      overlay.className = "preview-layer preview-fill preview-background";
      overlay.alt = "";
      overlay.src = assetUrl(option.overlayImage.url);
      elements.stage.appendChild(overlay);
    }

    for (const entry of controls.filter((item) => item.type === "image")) {
      const input = entry.item;
      if (!isControlVisible(input)) continue;
      const value = state.imageValues[input.id];
      if (!value || !value.objectUrl || !input.placementId) continue;
      const layer = document.createElement("div");
      layer.className = "placement-layer image-layer";
      layer.dataset.editId = `image:${input.id}`;
      layer.classList.toggle("is-active-edit", state.activeEditId === `image:${input.id}`);
      const { placement, css } = placeStyle(input.placementId);
      applyBoxStyle(layer, css);
      const img = document.createElement("img");
      img.alt = "";
      img.src = value.objectUrl;
      img.className = "inner-image";
      applyImageTransform(img, input.id);
      layer.appendChild(img);
      if (placement && placement.isFreePlacement) {
        layer.classList.add("is-draggable");
        layer.addEventListener("pointerdown", () => {
          setActiveEdit(`image:${input.id}`);
        });
        attachImageDrag(layer, img, input);
      }
      elements.stage.appendChild(layer);
    }

    for (const entry of controls.filter((item) => item.type === "option" && !isBackgroundOptionGroup(item.item))) {
      const group = entry.item;
      if (!isComponentVisible(group.id)) continue;
      const option = selectedOption(group);
      if (!option || !option.overlayImage) continue;
      const overlay = document.createElement("img");
      overlay.className = "preview-layer preview-fill preview-overlay";
      overlay.alt = "";
      overlay.src = assetUrl(option.overlayImage.url);
      elements.stage.appendChild(overlay);
    }

    for (const entry of controls.filter((item) => item.type === "text")) {
      const input = entry.item;
      if (!isControlVisible(input)) continue;
      const text = state.textValues[input.id] || "";
      if (!text || !input.placementId) continue;
      const layer = document.createElement("div");
      layer.className = `placement-layer text-layer ${isSingleLineText(input) ? "is-single-line" : ""}`;
      layer.dataset.editId = `text:${input.id}`;
      layer.classList.toggle("is-active-edit", state.activeEditId === `text:${input.id}`);
      const { placement, css } = placeStyle(input.placementId);
      applyBoxStyle(layer, css);
      layer.textContent = isSingleLineText(input) ? text.replace(/\r?\n/g, " ") : text;
      layer.style.color = activeColor(input);
      const fontFamily = activeFont(input);
      layer.style.fontFamily = fontFamily;
      layer.style.fontSize = `${textFontSize(input, css, text, fontFamily)}px`;
      layer.style.lineHeight = String(TEXT_LINE_HEIGHT);
      layer.addEventListener("pointerdown", () => {
        setActiveEdit(`text:${input.id}`);
      });
      attachDrag(layer, input.placementId);
      elements.stage.appendChild(layer);
    }

    if (surface && surface.maskImage) {
      const mask = document.createElement("img");
      mask.className = "preview-layer preview-fill preview-mask";
      mask.alt = "";
      mask.src = assetUrl(surface.maskImage.url);
      elements.stage.appendChild(mask);
    }
  }

  function attachDrag(element, placementId) {
    element.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      const start = { x: event.clientX, y: event.clientY };
      const original = { ...state.placementOverrides[placementId] };
      const scale = stageScale();

      function move(moveEvent) {
        const next = {
          ...original,
          x: original.x + (moveEvent.clientX - start.x) / scale,
          y: original.y + (moveEvent.clientY - start.y) / scale,
        };
        const max = state.config.product.previewSize || 400;
        next.x = Math.max(0, Math.min(max - next.width, next.x));
        next.y = Math.max(0, Math.min(max - next.height, next.y));
        state.placementOverrides[placementId] = next;
        const { css } = placeStyle(placementId);
        applyBoxStyle(element, css);
      }

      function up() {
        element.removeEventListener("pointermove", move);
        element.removeEventListener("pointerup", up);
        updateExportOutput(false);
      }

      element.addEventListener("pointermove", move);
      element.addEventListener("pointerup", up);
    });
  }

  function applyImageTransform(img, inputId) {
    const transform = state.imageTransforms[inputId] || { x: 0, y: 0, scale: 1, rotation: 0 };
    img.style.width = `${transform.scale * 100}%`;
    img.style.height = `${transform.scale * 100}%`;
    const scale = stageScale();
    img.style.left = `${transform.x * scale}px`;
    img.style.top = `${transform.y * scale}px`;
    img.style.transform = `rotate(${transform.rotation || 0}deg)`;
    img.style.transformOrigin = "center";
  }

  function clampImageTransform(inputId, input) {
    const transform = state.imageTransforms[inputId] || { x: 0, y: 0, scale: 1 };
    const placement = placementById(input.placementId);
    const box = state.placementOverrides[input.placementId] || {
      width: placement && placement.dimension ? placement.dimension.width : state.config.product.previewSize,
      height: placement && placement.dimension ? placement.dimension.height : state.config.product.previewSize,
    };
    const extraX = Math.max(0, box.width * transform.scale - box.width);
    const extraY = Math.max(0, box.height * transform.scale - box.height);
    transform.x = Math.max(-extraX, Math.min(0, transform.x));
    transform.y = Math.max(-extraY, Math.min(0, transform.y));
    state.imageTransforms[inputId] = transform;
    return transform;
  }

  function attachImageDrag(layer, img, input) {
    layer.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      layer.setPointerCapture(event.pointerId);
      const start = { x: event.clientX, y: event.clientY };
      const original = { ...(state.imageTransforms[input.id] || { x: 0, y: 0, scale: 1.18, rotation: 0 }) };
      const scale = stageScale();

      function move(moveEvent) {
        state.imageTransforms[input.id] = {
          ...original,
          x: original.x + (moveEvent.clientX - start.x) / scale,
          y: original.y + (moveEvent.clientY - start.y) / scale,
        };
        clampImageTransform(input.id, input);
        applyImageTransform(img, input.id);
      }

      function up() {
        layer.removeEventListener("pointermove", move);
        layer.removeEventListener("pointerup", up);
        updateExportOutput(false);
      }

      layer.addEventListener("pointermove", move);
      layer.addEventListener("pointerup", up);
    });
  }

  function validate() {
    state.validationErrors = {};

    for (const group of orderedOptionGroups()) {
      if (!isComponentVisible(group.id)) continue;
      if (group.required && !state.selectedOptions[group.id]) {
        state.validationErrors[group.id] = "Please choose an option.";
      }
    }

    for (const input of state.config.textInputs) {
      if (!isControlVisible(input)) continue;
      const value = state.textValues[input.id] || "";
      if (input.required && !value.trim()) {
        state.validationErrors[input.id] = "This field is required.";
        continue;
      }
      if (value && input.minLength && value.length < input.minLength) {
        state.validationErrors[input.id] = `Enter at least ${input.minLength} characters.`;
        continue;
      }
      if (value && input.maxLength && value.length > input.maxLength) {
        state.validationErrors[input.id] = `Use ${input.maxLength} characters or fewer.`;
        continue;
      }
      if (value && input.maxLines && value.split(/\r?\n/).length > input.maxLines) {
        state.validationErrors[input.id] = `Use ${input.maxLines} lines or fewer.`;
        continue;
      }
      if (value && input.regexChoice) {
        const regexChoice = state.config.regexChoices && state.config.regexChoices[input.regexChoice];
        if (regexChoice && regexChoice.pattern) {
          try {
            const expression = new RegExp(`^(?:${regexChoice.pattern})$`);
            if (!expression.test(value)) {
              state.validationErrors[input.id] =
                regexChoice.instructions || regexChoice.description || "Use only supported characters.";
            }
          } catch {
            // Ignore malformed third-party regex config; required/min/max validation still applies.
          }
        }
      }
    }

    for (const input of state.config.imageInputs) {
      if (!isControlVisible(input)) continue;
      if (input.required && !state.imageValues[input.id]) {
        state.validationErrors[input.id] = "Please upload an image.";
      }
    }

    return Object.keys(state.validationErrors).length === 0;
  }

  function renderValidationSummary() {
    const errors = Object.values(state.validationErrors);
    elements.validationSummary.textContent = errors.length ? `${errors.length} issue(s) need attention.` : "";
  }

  function buildExportPayload() {
    const optionGroups = orderedOptionGroups()
      .filter((group) => isComponentVisible(group.id))
      .map((group) => {
        const option = selectedOption(group);
        return {
          groupId: group.id,
          groupLabel: group.label,
          optionId: option && option.id,
          optionLabel: option && option.label,
          cost: option && option.cost ? option.cost : 0,
        };
      });

    const textInputs = state.config.textInputs
      .filter((input) => isControlVisible(input))
      .map((input) => ({
        id: input.id,
        label: input.label,
        value: state.textValues[input.id] || "",
        placementId: input.placementId,
        transform: state.textTransforms[input.id] || null,
      }));

    const imageInputs = state.config.imageInputs
      .filter((input) => isControlVisible(input))
      .map((input) => ({
        id: input.id,
        label: input.label,
        fileName: state.imageValues[input.id] && state.imageValues[input.id].fileName,
        placementId: input.placementId,
        transform: state.imageTransforms[input.id] || null,
      }));

    return {
      sourceUrl: state.sourceUrl,
      product: state.config.product,
      sellerConfigVersion: state.config.product.sellerConfigVersion,
      selectedOptions: optionGroups,
      textInputs,
      imageInputs,
      fontSelections: state.selectedFonts,
      colorSelections: state.selectedColors,
      placementOverrides: state.placementOverrides,
      priceDeltaTotal: state.priceDeltaTotal,
      generatedAt: new Date().toISOString(),
    };
  }

  function updateExportOutput(forceValidate) {
    if (forceValidate && !validate()) {
      renderValidationSummary();
      renderControls();
      return null;
    }
    const payload = buildExportPayload();
    state.exportedPersonalization = payload;
    elements.exportOutput.value = JSON.stringify(payload, null, 2);
    return payload;
  }

  function renderAll() {
    validate();
    renderWarnings();
    renderControls();
    renderPreview();
    renderValidationSummary();
    updateExportOutput(false);
  }

  async function loadConfig(url) {
    const response = await fetch("/api/custom-form", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const payload = await response.json();
    if (!response.ok) {
      const cached = (payload.cachedConfigs || [])
        .map((item) => `${item.file}: asin=${item.asin || "-"}, sku=${item.sku || "-"}`)
        .join(" | ");
      const detail = [payload.error, payload.detail, cached ? `Cached configs: ${cached}` : ""].filter(Boolean).join("\n");
      throw new Error(detail || "Unable to load custom form");
    }
    return payload;
  }

  async function drawImage(ctx, src, x, y, width, height, mode, transform) {
    if (!src) return;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.src = src.startsWith("blob:") ? src : assetUrl(src);
    await image.decode();

    if (mode === "cover") {
      const ratio = Math.max(width / image.naturalWidth, height / image.naturalHeight);
      const scale = transform && transform.scale ? transform.scale : 1;
      const drawWidth = image.naturalWidth * ratio * scale;
      const drawHeight = image.naturalHeight * ratio * scale;
      const offsetX = transform && Number.isFinite(transform.x) ? transform.x : (width - drawWidth) / 2;
      const offsetY = transform && Number.isFinite(transform.y) ? transform.y : (height - drawHeight) / 2;
      const rotation = transform && Number.isFinite(transform.rotation) ? (transform.rotation * Math.PI) / 180 : 0;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, width, height);
      ctx.clip();
      if (rotation) {
        ctx.translate(x + offsetX + drawWidth / 2, y + offsetY + drawHeight / 2);
        ctx.rotate(rotation);
        ctx.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
      } else {
        ctx.drawImage(image, x + offsetX, y + offsetY, drawWidth, drawHeight);
      }
      ctx.restore();
      return;
    }

    ctx.drawImage(image, x, y, width, height);
  }

  async function exportPng() {
    if (!validate()) {
      renderValidationSummary();
      renderControls();
      return;
    }

    const size = state.config.product.previewSize || 400;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#eef1f5";
    ctx.fillRect(0, 0, size, size);

    const surface = state.config.surfaces.find((item) => item.id === state.selectedSurfaceId) || state.config.surfaces[0];
    const baseUrl = (surface && surface.baseImage && surface.baseImage.url) || state.config.product.productImageUrl;
    if (baseUrl) await drawImage(ctx, baseUrl, 0, 0, size, size, "contain");

    const controls = orderedRenderableControls();
    for (const entry of controls.filter((item) => item.type === "option" && isBackgroundOptionGroup(item.item))) {
      const group = entry.item;
      if (!isComponentVisible(group.id)) continue;
      const option = selectedOption(group);
      if (option && option.overlayImage) await drawImage(ctx, option.overlayImage.url, 0, 0, size, size, "contain");
    }

    for (const entry of controls.filter((item) => item.type === "image")) {
      const input = entry.item;
      if (!isControlVisible(input)) continue;
      const value = state.imageValues[input.id];
      if (!value || !value.objectUrl || !input.placementId) continue;
      const box = state.placementOverrides[input.placementId];
      await drawImage(ctx, value.objectUrl, box.x, box.y, box.width, box.height, "cover", state.imageTransforms[input.id]);
    }

    for (const entry of controls.filter((item) => item.type === "option" && !isBackgroundOptionGroup(item.item))) {
      const group = entry.item;
      if (!isComponentVisible(group.id)) continue;
      const option = selectedOption(group);
      if (option && option.overlayImage) await drawImage(ctx, option.overlayImage.url, 0, 0, size, size, "contain");
    }

    for (const entry of controls.filter((item) => item.type === "text")) {
      const input = entry.item;
      if (!isControlVisible(input)) continue;
      const text = state.textValues[input.id] || "";
      if (!text || !input.placementId) continue;
      const box = state.placementOverrides[input.placementId];
      ctx.save();
      ctx.fillStyle = activeColor(input);
      const fontFamily = activeFont(input);
      ctx.font = `${textFontSize(input, box, text, fontFamily)}px ${fontFamily}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      drawCanvasText(ctx, input, text, box.x + box.width / 2, box.y + box.height / 2, box.width, box.height);
      ctx.restore();
    }

    if (surface && surface.maskImage) {
      await drawImage(ctx, surface.maskImage.url, 0, 0, size, size, "contain");
    }

    const a = document.createElement("a");
    a.download = `${state.config.product.asin || "custom-preview"}.png`;
    a.href = canvas.toDataURL("image/png");
    a.click();
  }

  function drawCanvasText(ctx, input, text, centerX, centerY, maxWidth, maxHeight) {
    if (isSingleLineText(input)) {
      ctx.fillText(String(text || "").replace(/\r?\n/g, " "), centerX, centerY, maxWidth);
      return;
    }
    const explicitLines = text.split(/\r?\n/);
    const lines = [];
    for (const line of explicitLines) {
      const words = line.split(/\s+/);
      let current = "";
      for (const word of words) {
        const test = current ? `${current} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth && current) {
          lines.push(current);
          current = word;
        } else {
          current = test;
        }
      }
      lines.push(current);
    }
    const fontSize = Number((ctx.font.match(/(\d+(?:\.\d+)?)px/) || [0, 16])[1]);
    const lineHeight = fontSize * TEXT_LINE_HEIGHT;
    const visible = lines.slice(0, Math.max(1, Math.floor(maxHeight / lineHeight)));
    const startY = centerY - ((visible.length - 1) * lineHeight) / 2;
    visible.forEach((line, index) => ctx.fillText(line, centerX, startY + index * lineHeight, maxWidth));
  }

  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = elements.url.value.trim();
    if (!url) return;

    setStatus("Loading custom form...");
    elements.form.querySelector("button").disabled = true;
    try {
      const config = await loadConfig(url);
      initializeState(config, url);
      elements.workspace.classList.remove("is-empty");
      elements.title.textContent = config.product.asin || "Custom product";
      elements.meta.textContent = [config.product.sku, config.product.sellerConfigVersion].filter(Boolean).join(" · ");
      elements.exportJson.disabled = false;
      elements.exportPng.disabled = false;
      renderAll();
      setStatus("Customizer loaded.");
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      elements.form.querySelector("button").disabled = false;
    }
  });

  elements.exportJson.addEventListener("click", () => {
    updateExportOutput(true);
  });

  elements.exportPng.addEventListener("click", () => {
    exportPng().catch((error) => setStatus(`PNG export failed: ${error.message}`, true));
  });

  window.addEventListener("resize", () => {
    if (state.config) renderPreview();
  });
})();
