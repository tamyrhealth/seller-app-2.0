import { buildPreorderDemandRows } from '../lib/preorderDemand';
import { availableQty } from '../lib/inventoryAvailable';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

if (availableQty(5, 2) !== 3) fail('available 5-2');
if (availableQty(-1, 0) !== 0) fail('negative on-hand available 0');

const rows = buildPreorderDemandRows([
  {
    id: 'o1',
    order_number: 'A-1',
    seller_id: 's1',
    city_id: 'c1',
    seller_name: 'Galia',
    city_name: 'Almaty',
    order_items: [
      { product_id: 'p1', product_name_snapshot: 'Oil', qty: 5, qty_reserved: 2 },
      { product_id: 'p2', product_name_snapshot: 'Gift', qty: 1, qty_reserved: 1 },
    ],
  },
]);
if (rows.length !== 2) fail('two item rows');
const oil = rows.find((r) => r.product_id === 'p1');
if (!oil || oil.uncovered !== 3 || oil.reserved !== 2 || oil.qty !== 5) fail('uncovered is not reserved');
const gift = rows.find((r) => r.product_id === 'p2');
if (!gift || gift.uncovered !== 0) fail('fully reserved is not demand');
const uncoveredOnly = rows.filter((r) => r.uncovered > 0);
if (uncoveredOnly.length !== 1) fail('demand list hides covered lines');
if (oil.seller_name !== 'Galia' || oil.city_name !== 'Almaty' || oil.order_number !== 'A-1') {
  fail('demand must keep seller/city/order');
}

console.log('OK');
