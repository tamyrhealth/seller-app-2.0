import { displayOrderNumber, parseOrderNumberQuery } from '../lib/orderNumber';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

if (parseOrderNumberQuery('') !== null) fail('empty');
if (parseOrderNumberQuery('1') !== 'N000001') fail('1');
if (parseOrderNumberQuery('n12') !== 'N000012') fail('n12');
if (parseOrderNumberQuery('N000007') !== 'N000007') fail('canonical');
if (parseOrderNumberQuery('  42 ') !== 'N000042') fail('spaces');
if (parseOrderNumberQuery('abc') !== null) fail('abc');
if (displayOrderNumber({ id: 'aaaaaaaa-bbbb', order_number: 'N000003' }) !== 'N000003') {
  fail('display number');
}
if (displayOrderNumber({ id: 'abcdef00-1111', order_number: null }) !== 'abcdef00') {
  fail('display uuid fallback');
}

console.log('OK');
