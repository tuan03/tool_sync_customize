// @ts-check

const NO_CHANGES = { operations: [] };

/**
 * @param {any} input
 */
export function cartTransformRun(input) {
  const groups = new Map();

  for (const line of input.cart.lines || []) {
    const customizationId = line.customizationId && line.customizationId.value;
    if (!customizationId) continue;

    if (!groups.has(customizationId)) groups.set(customizationId, { main: [], addons: [] });
    const group = groups.get(customizationId);

    if (line.feeComponent && line.feeComponent.value) group.addons.push(line);
    else group.main.push(line);
  }

  const operations = [];

  for (const group of groups.values()) {
    if (group.main.length !== 1 || !group.addons.length) continue;

    const main = group.main[0];
    const variant = main.merchandise;
    if (!variant || variant.__typename !== "ProductVariant" || !variant.id) continue;

    const cartLines = [{ cartLineId: main.id, quantity: main.quantity }];
    for (const addon of group.addons) {
      cartLines.push({ cartLineId: addon.id, quantity: addon.quantity });
    }

    operations.push({
      linesMerge: {
        parentVariantId: variant.id,
        cartLines,
      },
    });
  }

  return operations.length ? { operations } : NO_CHANGES;
}
