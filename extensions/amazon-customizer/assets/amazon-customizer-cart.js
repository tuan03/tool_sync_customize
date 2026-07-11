(function () {
  "use strict";

  const CART_SURFACE_SELECTOR = 'form[action*="/cart"], .cart-items, [data-cart-items], .cart-drawer, .ajaxcart, .cart-popup';

  if (!document.querySelector(CART_SURFACE_SELECTOR)) return;

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

  // Cart UI is theme-owned. The app no longer mutates cart DOM, syncs quantities,
  // or reloads cart surfaces from this embed. Themes should render directly from
  // Shopify cart data using the customization line item properties.
})();
