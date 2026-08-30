import { describe, expect, it } from 'bun:test';
import { topoOrder } from '../../../src/contexts/import/table-order';

describe('import/table-order', () => {
  it('orders parents before children', () => {
    const order = topoOrder(
      ['orders', 'customers', 'regions'],
      [
        { child: 'orders', parent: 'customers' },
        { child: 'customers', parent: 'regions' },
      ],
    );
    expect(order.indexOf('regions')).toBeLessThan(order.indexOf('customers'));
    expect(order.indexOf('customers')).toBeLessThan(order.indexOf('orders'));
  });

  it('ignores edges to tables not in the set', () => {
    const order = topoOrder(['a', 'b'], [{ child: 'b', parent: 'ghost' }]);
    expect(order).toEqual(['a', 'b']);
  });

  it('falls back to original order on a cycle (never deadlocks)', () => {
    const order = topoOrder(
      ['a', 'b'],
      [
        { child: 'a', parent: 'b' },
        { child: 'b', parent: 'a' },
      ],
    );
    expect(order.sort()).toEqual(['a', 'b']);
  });
});
