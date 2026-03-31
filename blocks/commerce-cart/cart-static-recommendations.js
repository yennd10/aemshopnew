import { fetchProductData, setEndpoint } from '@dropins/storefront-pdp/api.js';
import {
  Button,
  Icon,
  Image,
  Price,
  PriceRange,
  ProductItemCard,
  provider as UI,
} from '@dropins/tools/components.js';
import { Slot } from '@dropins/tools/lib.js';
import { h } from '@dropins/tools/preact.js';
import * as cartApi from '@dropins/storefront-cart/api.js';
import { CS_FETCH_GRAPHQL } from '../../scripts/commerce.js';

/** Default SKUs when block `recommendation-skus` and config `cart-static-recommendation-skus` are empty. */
export const CART_STATIC_RECOMMENDATIONS_FALLBACK_CSV = 'ADB102,ADB111,ADB112';

export function parseCartStaticRecommendationSkus(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Map storefront-pdp transformed product to recommendation card item shape.
 */
function mapPdpToCardItem(p) {
  if (!p?.sku) return null;
  const isComplex = p.productType === 'complex';
  const images = (p.images || []).map((img) => ({
    url: (img.url || '').replace(/^https?:/, ''),
    label: img.label || p.name || '',
    roles: img.roles || ['thumbnail'],
  }));
  const item = {
    sku: p.sku,
    name: p.name,
    urlKey: p.urlKey,
    images,
    itemType: isComplex ? 'ComplexProductView' : 'SimpleProductView',
  };
  if (isComplex && p.prices?.final) {
    const { minimumAmount, maximumAmount, currency } = p.prices.final;
    item.priceRange = {
      minimum: { final: { amount: { value: minimumAmount, currency } } },
      maximum: { final: { amount: { value: maximumAmount, currency } } },
    };
  } else if (p.prices?.final?.amount != null) {
    item.price = {
      final: {
        amount: {
          value: p.prices.final.amount,
          currency: p.prices.final.currency || 'USD',
        },
      },
    };
  }
  return item;
}

function productUrlFor(item, getProductLink) {
  return getProductLink(item);
}

function priceVnode(item) {
  if (item.itemType === 'ComplexProductView' && item.priceRange?.minimum?.final?.amount) {
    return h(Slot, {
      name: 'Price',
      children: h(PriceRange, {
        display: 'from to',
        minimumAmount: item.priceRange.minimum.final.amount.value,
        maximumAmount: item.priceRange.maximum.final.amount.value,
        currency: item.priceRange.minimum.final.amount.currency,
      }),
    });
  }
  if (item.price?.final?.amount) {
    return h(Slot, {
      name: 'Price',
      children: h(Price, {
        amount: item.price.final.amount.value,
        currency: item.price.final.amount.currency,
      }),
    });
  }
  return h(Slot, { name: 'Price', children: h('span', {}, '') });
}

export async function renderStaticCartRecommendations(el, options) {
  const {
    skus,
    heading,
    placeholders,
    getProductLink,
  } = options;

  if (!skus?.length || !el) return;

  setEndpoint(CS_FETCH_GRAPHQL);

  const fetched = await Promise.all(
    skus.map((sku) => fetchProductData(sku).catch(() => null)),
  );

  const items = skus
    .map((_, i) => mapPdpToCardItem(fetched[i]))
    .filter(Boolean);

  if (!items.length) return;

  el.innerHTML = '';
  const section = document.createElement('section');
  section.className = 'recommendations-product-list cart__static-recommendations';
  section.setAttribute('role', 'region');
  section.setAttribute('aria-label', heading || 'Product recommendations');

  const title = document.createElement('h2');
  title.className = 'recommendations-product-list__heading';
  title.textContent = heading || '';

  const grid = document.createElement('div');
  grid.className = 'recommendations-product-list__content';

  const addLabel = placeholders?.Global?.AddProductToCart;
  const optionsLabel = placeholders?.Global?.SelectProductOptions;

  items.forEach((item, index) => {
    const cardHost = document.createElement('div');
    const href = productUrlFor(item, getProductLink);
    const defaultImageProps = {
      loading: index < 4 ? 'eager' : 'lazy',
      src: item.images[0]?.url || '',
      alt: item.images[0]?.label || item.name,
      width: '300',
      height: '300',
      params: { width: 300, height: 300 },
    };

    const thumbImage = h(Image, {
      'data-testid': 'product-list-item-image',
      ...defaultImageProps,
      'aria-label': item.sku,
    });

    const thumbVnode = h(Slot, {
      name: 'Thumbnail',
      children: h('a', { href }, thumbImage),
    });

    const titleVnode = h(Slot, {
      name: 'Title',
      children: h('a', { href }, item.name),
    });

    const skuVnode = h(Slot, {
      name: 'Sku',
      children: h('span', {}, item.sku),
    });

    const primaryBtn = item.itemType === 'ComplexProductView'
      ? h(Button, {
        children: optionsLabel,
        href,
        variant: 'tertiary',
      })
      : h(Button, {
        children: addLabel,
        icon: Icon({ source: 'Cart' }),
        variant: 'primary',
        onClick: (event) => {
          event.stopPropagation();
          cartApi.addProductsToCart([{ sku: item.sku, quantity: 1 }]);
        },
      });

    const footerVnode = h(Slot, {
      name: 'Footer',
      children: h('div', { 'data-testid': 'static-recs-footer' }, primaryBtn),
    });

    UI.render(ProductItemCard, {
      initialized: true,
      sku: skuVnode,
      image: thumbVnode,
      titleNode: titleVnode,
      price: priceVnode(item),
      actionButton: footerVnode,
    })(cardHost);

    grid.appendChild(cardHost);
  });

  section.append(title, grid);
  el.appendChild(section);
}
