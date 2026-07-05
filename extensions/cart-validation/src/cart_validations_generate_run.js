// @ts-check

/**
 * @param {any} input
 */
export function cartValidationsGenerateRun(input) {
  const groups = new Map();
  const errors = [];
  for (const line of input.cart.lines || []) {
    const id = line.customizationId && line.customizationId.value;
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, { main: [], fees: [] });
    const group = groups.get(id);
    if (line.feeComponent && line.feeComponent.value) group.fees.push(line);
    else if (line.expectedFee && line.expectedFee.value) group.main.push(line);
  }
  for (const [id, group] of groups) {
    if (group.main.length !== 1) {
      errors.push({ message: `Customization ${id} must contain exactly one product line.`, target: "$.cart" });
      continue;
    }
    const main = group.main[0];
    let config = null, choices = null;
    try { config = JSON.parse(main.merchandise.product.customizer.value); choices = JSON.parse(main.selectedOptions.value); }
    catch { errors.push({ message: "Customization data is invalid. Please remove the item and customize it again.", target: "$.cart" }); continue; }
    const expected = (config.optionGroups || []).reduce((total, optionGroup) => {
      const option = (optionGroup.options || []).find((item) => item.id === choices[optionGroup.id]);
      return total + Number(option && option.cost || 0);
    }, 0) * Number(main.quantity || 1);
    const declared = Number(main.expectedFee.value || 0) * Number(main.quantity || 1);
    const actual = group.fees.reduce((total, line) => total + Number(line.feeComponent.value || 0) * Number(line.quantity || 1), 0);
    const parentVariantId = String(main.merchandise.id || "").split("/").pop();
    const wrongParent = group.fees.some((line) => !line.parentVariant || line.parentVariant.value !== parentVariantId);
    if (expected !== declared || expected !== actual || wrongParent) errors.push({ message: "Customization surcharge is incomplete or invalid. Please remove the item and customize it again.", target: "$.cart" });
  }
  for (const line of input.cart.lines || []) {
    if (line.feeComponent && line.feeComponent.value && (!line.customizationId || !groups.has(line.customizationId.value))) errors.push({ message: "Orphan customization surcharge found in cart.", target: "$.cart" });
  }
  return errors.length ? { operations: [{ validationAdd: { errors } }] } : { operations: [] };
}
