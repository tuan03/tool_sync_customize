(function () {
  "use strict";
  let busy = false;
  let timer = null;

  async function reconcileFees() {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch(`${window.Shopify.routes.root}cart.js`, { headers: { accept: "application/json" } });
      if (!response.ok) return;
      const cart = await response.json();
      const groups = new Map();
      for (const item of cart.items || []) {
        const id = item.properties?._customization_id;
        if (!id) continue;
        const group = groups.get(id) || { main: null, fee: null };
        if (item.properties?._personalization_fee === "true") group.fee = item;
        else if (item.properties?._personalization_source === "etsy") group.main = item;
        groups.set(id, group);
      }
      for (const group of groups.values()) {
        if (!group.main && group.fee) {
          await fetch(`${window.Shopify.routes.root}cart/change.js`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: group.fee.key, quantity: 0 }) });
          continue;
        }
        if (!group.main) continue;
        const feeVariantId = Number(group.main.properties?._personalization_fee_variant_id || 0);
        if (!feeVariantId) continue;
        if (!group.fee) {
          await fetch(`${window.Shopify.routes.root}cart/add.js`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ id: feeVariantId, quantity: group.main.quantity, properties: { "Personalization fee": `$${group.main.properties._personalization_fee_amount}`, _customization_id: group.main.properties._customization_id, _personalization_fee: "true", _personalization_parent_variant_id: String(group.main.variant_id) } }] }) });
          continue;
        }
        if (group.fee.quantity !== group.main.quantity) {
          await fetch(`${window.Shopify.routes.root}cart/change.js`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: group.fee.key, quantity: group.main.quantity }) });
        }
      }
    } catch (error) {
      console.warn("[Product Personalizer] Could not reconcile fee lines", error);
    } finally {
      busy = false;
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(reconcileFees, 500);
  }
  document.addEventListener("change", schedule, true);
  document.addEventListener("cart:updated", schedule);
  window.addEventListener("pageshow", schedule);
  schedule();
})();
