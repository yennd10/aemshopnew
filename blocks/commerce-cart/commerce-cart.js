import { events } from '@dropins/tools/event-bus.js';
import { render as provider } from '@dropins/storefront-cart/render.js';
import * as Cart from '@dropins/storefront-cart/api.js';
import { h } from '@dropins/tools/preact.js';
import {
  InLineAlert,
  Icon,
  Button,
  Incrementer,
  provider as UI,
} from '@dropins/tools/components.js';

// Dropin Containers
import CartSummaryList from '@dropins/storefront-cart/containers/CartSummaryList.js';
import OrderSummary from '@dropins/storefront-cart/containers/OrderSummary.js';
import EstimateShipping from '@dropins/storefront-cart/containers/EstimateShipping.js';
import Coupons from '@dropins/storefront-cart/containers/Coupons.js';
import GiftCards from '@dropins/storefront-cart/containers/GiftCards.js';
import GiftOptions from '@dropins/storefront-cart/containers/GiftOptions.js';
import { render as wishlistRender } from '@dropins/storefront-wishlist/render.js';
import { WishlistToggle } from '@dropins/storefront-wishlist/containers/WishlistToggle.js';
import { WishlistAlert } from '@dropins/storefront-wishlist/containers/WishlistAlert.js';
import { tryRenderAemAssetsImage } from '@dropins/tools/lib/aem/assets.js';

// API
import { publishShoppingCartViewEvent } from '@dropins/storefront-cart/api.js';

// Modal and Mini PDP
import createMiniPDP from '../../scripts/components/commerce-mini-pdp/commerce-mini-pdp.js';
import createModal from '../modal/modal.js';

// Initializers
import '../../scripts/initializers/cart.js';
import '../../scripts/initializers/wishlist.js';

import { readBlockConfig } from '../../scripts/aem.js';
import { getConfigValue } from '@dropins/tools/lib/aem/configs.js';
import { fetchPlaceholders, rootLink, getProductLink } from '../../scripts/commerce.js';
import {
  CART_STATIC_RECOMMENDATIONS_FALLBACK_CSV,
  parseCartStaticRecommendationSkus,
  renderStaticCartRecommendations,
} from './cart-static-recommendations.js';

export default async function decorate(block) {
  // Configuration
  const {
    'hide-heading': hideHeading = 'false',
    'max-items': maxItems,
    'hide-attributes': hideAttributes = '',
    'enable-item-quantity-update': enableUpdateItemQuantity = 'false',
    'enable-item-remove': enableRemoveItem = 'true',
    'enable-estimate-shipping': enableEstimateShipping = 'false',
    'start-shopping-url': startShoppingURL = '',
    'checkout-url': checkoutURL = '',
    'enable-updating-product': enableUpdatingProduct = 'false',
    'undo-remove-item': undo = 'false',
    'recommendation-skus': recommendationSkus = '',
    'recommendations-heading': recommendationsHeading = '',
  } = readBlockConfig(block);

  const placeholders = await fetchPlaceholders();

  // Modal state
  let currentModal = null;
  let currentNotification = null;

  // Layout
  const fragment = document.createRange().createContextualFragment(`
    <div class="cart__notification"></div>
    <div class="cart__wrapper">
      <div class="cart__left-column">
        <div class="cart__remove-all"></div>
        <div class="cart__continue-shopping"></div>
        <div class="cart__list"></div>
      </div>
      <div class="cart__right-column">
        <div class="cart__order-summary"></div>
        <div class="cart__gift-options"></div>
      </div>
    </div>

    <div class="cart__empty-cart"></div>
    <div class="cart__recommendations"></div>
  `);

  const $wrapper = fragment.querySelector('.cart__wrapper');
  const $notification = fragment.querySelector('.cart__notification');
  const $leftColumn = fragment.querySelector('.cart__left-column');
  const $removeAll = fragment.querySelector('.cart__remove-all');
  const $continueShopping = fragment.querySelector('.cart__continue-shopping');
  const $list = fragment.querySelector('.cart__list');
  const $summary = fragment.querySelector('.cart__order-summary');
  const $emptyCart = fragment.querySelector('.cart__empty-cart');
  const $giftOptions = fragment.querySelector('.cart__gift-options');
  const $rightColumn = fragment.querySelector('.cart__right-column');
  const $recsHost = fragment.querySelector('.cart__recommendations');

  block.innerHTML = '';
  block.appendChild(fragment);

  const ph = (key, fallback) => placeholders?.Global?.[key] ?? fallback;
  const $listHeader = document.createElement('div');
  $listHeader.className = 'cart__list-header';
  $listHeader.setAttribute('role', 'row');
  $listHeader.innerHTML = `
    <span class="cart__list-header__cell cart__list-header__cell--item" role="columnheader">${ph('CartListColumnItem', 'Item')}</span>
    <span class="cart__list-header__cell cart__list-header__cell--price" role="columnheader">${ph('CartListColumnPrice', 'Price')}</span>
    <span class="cart__list-header__cell cart__list-header__cell--qty" role="columnheader">${ph('CartListColumnQty', 'Qty')}</span>
    <span class="cart__list-header__cell cart__list-header__cell--subtotal" role="columnheader">${ph('CartListColumnSubtotal', 'Sub-total')}</span>
  `;
  $listHeader.classList.toggle('cart__list-header--hidden', isCartEmpty(Cart.getCartDataFromCache()));

  // Remove all products (clear cart)
  if ($removeAll) {
    let removingAll = false;
    UI.render(Button, {
      children: ph('CartRemoveAllProducts', 'Remove all products'),
      variant: 'tertiary',
      size: 'medium',
      icon: h(Icon, { source: 'Trash' }),
      onClick: async () => {
        if (removingAll) return;
        removingAll = true;
        try {
          await Cart.resetCart();
          events.emit('cart/reset', undefined);
          events.emit('cart/data', null);
        } catch (e) {
          console.error('Failed to remove all products:', e);
        } finally {
          removingAll = false;
        }
      },
    })($removeAll);
  }

  // Continue Shopping link (home page)
  if ($continueShopping) {
    const link = document.createElement('a');
    link.href = rootLink('/');
    link.className = 'dropin-button dropin-button--medium dropin-button--tertiary';
    link.textContent = ph('CartContinueShopping', '< Continue Shopping');
    link.setAttribute('aria-label', link.textContent);
    $continueShopping.appendChild(link);
  }

  const mergeRemoveIntoQtySlot =
    enableUpdateItemQuantity === 'true' && enableRemoveItem === 'true';

  let cartListLayoutRaf = 0;
  const scheduleCartListLayout = () => {
    if (cartListLayoutRaf) cancelAnimationFrame(cartListLayoutRaf);
    cartListLayoutRaf = requestAnimationFrame(() => {
      cartListLayoutRaf = 0;
      placeCartListHeader($list, $listHeader);
      wrapCartLineItemPrimary($list);
      placeRemoveAllAfterContent($list, $removeAll, $continueShopping);
      if (!mergeRemoveIntoQtySlot) {
        moveCartItemRemoveIntoQuantity($list);
        requestAnimationFrame(() => {
          moveCartItemRemoveIntoQuantity($list);
        });
      }
    });
  };
  const listLayoutObserver = new MutationObserver((records) => {
    if (records.some((record) => mutationAffectsCartListLayout(record, $listHeader))) {
      scheduleCartListLayout();
    }
  });
  listLayoutObserver.observe($list, { childList: true, subtree: true });

  // Wishlist variables
  const routeToWishlist = rootLink('/wishlist');

  // Toggle Empty Cart
  function toggleEmptyCart(_state) {
    $wrapper.removeAttribute('hidden');
    $emptyCart.setAttribute('hidden', '');
  }

  // Handle Edit Button Click
  async function handleEditButtonClick(cartItem) {
    try {
      // Create mini PDP content
      const miniPDPContent = await createMiniPDP(
        cartItem,
        async (_updateData) => {
          // Show success message when mini-PDP updates item
          const productName = cartItem.name
            || cartItem.product?.name
            || placeholders?.Global?.CartUpdatedProductName;
          const message = placeholders?.Global?.CartUpdatedProductMessage?.replace(
            '{product}',
            productName,
          );

          // Clear any existing notifications
          currentNotification?.remove();

          currentNotification = await UI.render(InLineAlert, {
            heading: message,
            type: 'success',
            variant: 'primary',
            icon: h(Icon, { source: 'CheckWithCircle' }),
            'aria-live': 'assertive',
            role: 'alert',
            onDismiss: () => {
              currentNotification?.remove();
            },
          })($notification);

          // Auto-dismiss after 5 seconds
          setTimeout(() => {
            currentNotification?.remove();
          }, 5000);
        },
        () => {
          if (currentModal) {
            currentModal.removeModal();
            currentModal = null;
          }
        },
      );

      // Create and show modal
      currentModal = await createModal([miniPDPContent]);

      if (currentModal.block) {
        currentModal.block.setAttribute('id', 'mini-pdp-modal');
      }

      currentModal.showModal();
    } catch (error) {
      console.error('Error opening mini PDP modal:', error);

      // Clear any existing notifications
      currentNotification?.remove();

      // Show error notification
      currentNotification = await UI.render(InLineAlert, {
        heading: placeholders?.Global?.ProductLoadError,
        type: 'error',
        variant: 'primary',
        icon: h(Icon, { source: 'AlertWithCircle' }),
        'aria-live': 'assertive',
        role: 'alert',
        onDismiss: () => {
          currentNotification?.remove();
        },
      })($notification);
    }
  }

  // Render Containers
  const createProductLink = (product) => getProductLink(product.url.urlKey, product.topLevelSku);
  await Promise.all([
    // Cart List
    provider.render(CartSummaryList, {
      hideHeading: hideHeading === 'true',
      routeProduct: createProductLink,
      routeEmptyCartCTA: startShoppingURL ? () => rootLink(startShoppingURL) : undefined,
      maxItems: parseInt(maxItems, 10) || undefined,
      attributesToHide: hideAttributes
        .split(',')
        .map((attr) => attr.trim().toLowerCase()),
      enableUpdateItemQuantity: enableUpdateItemQuantity === 'true',
      enableRemoveItem: enableRemoveItem === 'true',
      undo: undo === 'true',
      slots: {
        Thumbnail: (ctx) => {
          const { item, defaultImageProps } = ctx;
          const anchorWrapper = document.createElement('a');
          anchorWrapper.href = createProductLink(item);

          tryRenderAemAssetsImage(ctx, {
            alias: item.sku,
            imageProps: defaultImageProps,
            wrapper: anchorWrapper,

            params: {
              width: defaultImageProps.width,
              height: defaultImageProps.height,
            },
          });
        },

        Footer: (ctx) => {
          // Edit Link
          if (ctx.item?.itemType === 'ConfigurableCartItem' && enableUpdatingProduct === 'true') {
            const editLink = document.createElement('div');
            editLink.className = 'cart-item-edit-link';

            UI.render(Button, {
              children: placeholders?.Global?.CartEditButton,
              variant: 'tertiary',
              size: 'medium',
              icon: h(Icon, { source: 'Edit' }),
              onClick: () => handleEditButtonClick(ctx.item),
            })(editLink);

            ctx.appendChild(editLink);
          }

          // Wishlist Button (if product is not configurable)
          const $wishlistToggle = document.createElement('div');
          $wishlistToggle.classList.add('cart__action--wishlist-toggle');

          wishlistRender.render(WishlistToggle, {
            product: ctx.item,
            size: 'medium',
            labelToWishlist: placeholders?.Global?.CartMoveToWishlist,
            labelWishlisted: placeholders?.Global?.CartRemoveFromWishlist,
            removeProdFromCart: Cart.updateProductsFromCart,
          })($wishlistToggle);

          ctx.appendChild($wishlistToggle);

          // Gift Options
          const giftOptions = document.createElement('div');

          provider.render(GiftOptions, {
            item: ctx.item,
            view: 'product',
            dataSource: 'cart',
            handleItemsLoading: ctx.handleItemsLoading,
            handleItemsError: ctx.handleItemsError,
            onItemUpdate: ctx.onItemUpdate,
            slots: {
              SwatchImage: swatchImageSlot,
            },
          })(giftOptions);

          ctx.appendChild(giftOptions);
        },

        ...(enableUpdateItemQuantity === 'true'
          ? {
            ItemQuantity: (ctx) => {
              const row = document.createElement('div');
              row.className = 'cart__line-item-qty-with-remove';
              const incHost = document.createElement('div');
              incHost.className = 'cart__line-item-qty-inc';
              row.appendChild(incHost);

              const {
                item,
                handleItemQuantityUpdate,
                itemsLoading,
              } = ctx;

              UI.render(Incrementer, {
                value: item.quantity,
                min: 1,
                onValue: (val) => handleItemQuantityUpdate(item, Number(val)),
                name: 'quantity',
                disabled: itemsLoading.has(item.uid),
                'aria-label': placeholders?.Global?.CartQuantityLabel
                  || placeholders?.Global?.Quantity
                  || 'Quantity',
              })(incHost);

              if (enableRemoveItem === 'true') {
                const removeHost = document.createElement('div');
                removeHost.className = 'cart__line-item-qty-remove';
                removeHost.setAttribute('data-slot', 'ItemRemoveAction');
                row.appendChild(removeHost);

                const removeTemplate = placeholders?.Global?.CartRemoveItem
                  || 'Remove {product} from the cart';
                const removeAria = removeTemplate.replace(/\{product\}/g, item.name || '');

                UI.render(Button, {
                  variant: 'tertiary',
                  size: 'medium',
                  'data-testid': 'cart-item-remove-button',
                  className: 'dropin-cart-item__remove',
                  onClick: () => handleItemQuantityUpdate(item, 0),
                  disabled: itemsLoading.has(item.uid),
                  icon: h(Icon, {
                    source: 'Trash',
                    'data-testid': 'cart-item-remove-icon',
                    size: '24',
                    stroke: '2',
                    viewBox: '0 0 24 24',
                    'aria-label': removeAria,
                  }),
                })(removeHost);
              }

              ctx.replaceWith(row);
            },
          }
          : {}),

        ...(mergeRemoveIntoQtySlot
          ? {
            ItemRemoveAction: (ctx) => {
              ctx.remove();
            },
          }
          : {}),
      },
    })($list),

    // Order Summary
    provider.render(OrderSummary, {
      routeProduct: createProductLink,
      routeCheckout: checkoutURL ? () => rootLink(checkoutURL) : undefined,
      slots: {
        EstimateShipping: async (ctx) => {
          if (enableEstimateShipping === 'true') {
            const wrapper = document.createElement('div');
            await provider.render(EstimateShipping, {})(wrapper);
            ctx.replaceWith(wrapper);
          }
        },
        Coupons: (ctx) => {
          const coupons = document.createElement('div');

          provider.render(Coupons)(coupons);

          ctx.appendChild(coupons);
        },
        GiftCards: (ctx) => {
          const giftCards = document.createElement('div');

          provider.render(GiftCards)(giftCards);

          ctx.appendChild(giftCards);
        },
      },
    })($summary),

    provider.render(GiftOptions, {
      view: 'order',
      dataSource: 'cart',

      slots: {
        SwatchImage: swatchImageSlot,
      },
    })($giftOptions),
  ]);

  scheduleCartListLayout();

  // --- Custom: cart-static-recommendations ---
  // Renders a fixed SKU strip below the cart (see cart-static-recommendations.js).
  // SKUs: block "recommendation-skus" → config "cart-static-recommendation-skus" → fallback CSV in that module.
  let skuConfigFromSite = '';
  try {
    skuConfigFromSite = getConfigValue('cart-static-recommendation-skus') || '';
  } catch {
    /* config not ready */
  }
  const mergedSkuCsv = [recommendationSkus, skuConfigFromSite]
    .filter((s) => s && String(s).trim())
    .join(',');
  let staticRecSkus = parseCartStaticRecommendationSkus(mergedSkuCsv);
  if (!staticRecSkus.length) {
    staticRecSkus = parseCartStaticRecommendationSkus(CART_STATIC_RECOMMENDATIONS_FALLBACK_CSV);
  }
  await renderStaticCartRecommendations($recsHost, {
    skus: staticRecSkus,
    heading: recommendationsHeading.trim()
      || placeholders?.Global?.CartStaticRecommendationsHeading
      || 'You may also like',
    placeholders,
    getProductLink: (item) => getProductLink(item.urlKey, item.sku),
  });

  let cartViewEventPublished = false;
  // Events
  events.on(
    'cart/data',
    (cartData) => {
      toggleEmptyCart(isCartEmpty(cartData));

      const isEmpty = !cartData || cartData.totalQuantity < 1;
      $giftOptions.style.display = isEmpty ? 'none' : '';
      if ($removeAll) $removeAll.style.display = isEmpty ? 'none' : '';
      $rightColumn.style.display = isEmpty ? 'none' : '';
      $listHeader.classList.toggle('cart__list-header--hidden', isEmpty);
      scheduleCartListLayout();

      if (!cartViewEventPublished) {
        cartViewEventPublished = true;
        publishShoppingCartViewEvent();
      }
    },
    { eager: true },
  );

  events.on('wishlist/alert', ({ action, item }) => {
    wishlistRender.render(WishlistAlert, {
      action,
      item,
      routeToWishlist,
    })($notification);

    setTimeout(() => {
      $notification.innerHTML = '';
    }, 5000);
  });

  return Promise.resolve();
}

function isCartEmpty(cart) {
  return cart ? cart.totalQuantity < 1 : true;
}

const CART_SUMMARY_CONTENT_SELECTOR = '.cart-cart-summary-list__content';

function placeRemoveAllAfterContent($list, $removeAll, $continueShopping) {
  if (!$removeAll || !$list) return;
  const content = $list.querySelector(CART_SUMMARY_CONTENT_SELECTOR);
  if (!content) return;

  const sameParent = $removeAll.parentElement === content.parentElement;
  const alreadyPlaced =
    sameParent
    && content.nextElementSibling === $removeAll
    && (!($continueShopping && $continueShopping.parentElement)
      || $removeAll.nextElementSibling === $continueShopping);
  if (alreadyPlaced) return;

  content.after($removeAll);
  if ($continueShopping && $continueShopping.parentElement) {
    $removeAll.after($continueShopping);
  }
}

const CART_LIST_HEADING_SELECTOR = [
  '[data-testid="cart-summary-list-heading-wrapper"]',
  '.cart-cart-summary-list__heading',
  '.cart-summary-list-heading-wrapper',
].join(', ');

function mutationAffectsCartListHeaderAnchor(record, $listHeader) {
  if (record.type !== 'childList') return false;
  const touchesAnchor = (nodes) => {
    for (const n of nodes) {
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const el = n;
      if (el === $listHeader) return true;
      if (el.matches?.(CART_LIST_HEADING_SELECTOR) || el.matches?.('.dropin-cart-list')) {
        return true;
      }
      if (el.querySelector?.(`.dropin-cart-list, ${CART_LIST_HEADING_SELECTOR}`)) {
        return true;
      }
    }
    return false;
  };
  return touchesAnchor(record.addedNodes) || touchesAnchor(record.removedNodes);
}

function mutationAffectsCartLineWrappers(record) {
  if (record.type !== 'childList') return false;
  const touchesLine = (nodes) => {
    for (const n of nodes) {
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const el = n;
      if (el.matches?.('.dropin-cart-list__item') || el.matches?.('.dropin-cart-item__wrapper')) {
        return true;
      }
      if (el.querySelector?.('.dropin-cart-item__wrapper')) return true;
    }
    return false;
  };
  return touchesLine(record.addedNodes) || touchesLine(record.removedNodes);
}

function mutationAffectsItemRemoveSlot(record) {
  if (record.type !== 'childList') return false;
  const sel = '[data-slot="ItemRemoveAction"]';
  const check = (nodes) => {
    for (const n of nodes) {
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      if (n.matches?.(sel)) return true;
      if (n.querySelector?.(sel)) return true;
    }
    return false;
  };
  return check(record.addedNodes) || check(record.removedNodes);
}

function mutationAffectsCartListLayout(record, $listHeader) {
  return mutationAffectsCartListHeaderAnchor(record, $listHeader)
    || mutationAffectsCartLineWrappers(record)
    || mutationAffectsItemRemoveSlot(record);
}

/** Wrap image + title + sku + savings + attributes for grid/CSS targeting. */
function wrapCartLineItemPrimary($list) {
  $list.querySelectorAll('.dropin-cart-item__wrapper').forEach((wrapper) => {
    if (wrapper.querySelector(':scope > .cart__line-item-primary')) return;

    const image = wrapper.querySelector(':scope > .dropin-cart-item__image');
    const title = wrapper.querySelector(':scope > .dropin-cart-item__title');
    if (!image || !title) return;

    const sku = wrapper.querySelector(':scope > .dropin-cart-item__sku');
    const savings = wrapper.querySelector(':scope > .dropin-cart-item__savings__wrapper');
    const attributes = wrapper.querySelector(':scope > .dropin-cart-item__attributes');

    const primary = document.createElement('div');
    primary.className = 'cart__line-item-primary';

    wrapper.insertBefore(primary, image);
    primary.appendChild(image);
    primary.appendChild(title);
    if (sku) primary.appendChild(sku);
    if (savings) primary.appendChild(savings);
    if (attributes) primary.appendChild(attributes);
  });
}

function moveCartItemRemoveIntoQuantity($list) {
  $list.querySelectorAll('.dropin-cart-item__wrapper').forEach((wrapper) => {
    const qty =
      wrapper.querySelector(':scope > .dropin-cart-item__quantity')
      || wrapper.querySelector('.dropin-cart-item__quantity');
    let removeHost =
      wrapper.querySelector(':scope > [data-slot="ItemRemoveAction"]')
      || wrapper.querySelector('[data-slot="ItemRemoveAction"]');
    if (!removeHost && qty) {
      const btn = wrapper.querySelector('.dropin-cart-item__remove');
      removeHost = btn?.closest('[data-slot="ItemRemoveAction"]') || btn || null;
    }
    if (!qty || !removeHost) return;
    if (qty.contains(removeHost)) return;
    qty.appendChild(removeHost);
  });
}

/** Insert column headers after cart summary title (drop-in), or before the line-item list. */
function placeCartListHeader($list, $listHeader) {
  const heading = $list.querySelector(CART_LIST_HEADING_SELECTOR);
  const cartList = $list.querySelector('.dropin-cart-list');

  if (heading) {
    if (heading.nextElementSibling === $listHeader) return;
    heading.after($listHeader);
    return;
  }

  if (cartList?.parentNode) {
    if (cartList.previousElementSibling === $listHeader) return;
    cartList.parentNode.insertBefore($listHeader, cartList);
    return;
  }

  if (!$list.firstChild) {
    $list.appendChild($listHeader);
    return;
  }
  if ($list.firstChild === $listHeader) return;
  $list.insertBefore($listHeader, $list.firstChild);
}

function swatchImageSlot(ctx) {
  const { imageSwatchContext, defaultImageProps } = ctx;
  tryRenderAemAssetsImage(ctx, {
    alias: imageSwatchContext.label,
    imageProps: defaultImageProps,
    wrapper: document.createElement('span'),

    params: {
      width: defaultImageProps.width,
      height: defaultImageProps.height,
    },
  });
}
