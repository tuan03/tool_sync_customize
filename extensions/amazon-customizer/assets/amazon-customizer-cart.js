(function () {
  "use strict";

  const CART_SURFACE_SELECTOR = 'form[action*="/cart"], .cart-items, [data-cart-items], .cart-drawer, .ajaxcart, .cart-popup';

  if (!document.querySelector(CART_SURFACE_SELECTOR)) return;

  // Cart UI is theme-owned. The app no longer mutates cart DOM, syncs quantities,
  // or reloads cart surfaces from this embed. Themes should render directly from
  // Shopify cart data using the customization line item properties.
})();
