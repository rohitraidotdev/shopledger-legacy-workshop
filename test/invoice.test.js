const test = require('node:test');
const assert = require('node:assert/strict');
const pricing = require('../lib/pricing');
const invoice = require('../lib/invoice');
const reports = require('../lib/reports');
const store = require('../lib/store');
const orderRouter = require('../routes/orders');

test('a printable invoice shows the billed total and GST for an HSN-priced order', function () {
  const items = [{ name: 'Rice', hsn: '1006', price: 640, qty: 1 }];
  const order = { id: 1, items, subtotal: 640, discount: 0, tax: 32, total: 672 };
  const html = invoice.render(order);

  assert.equal(invoice.computeInvoiceFigures(order).total, 672);
  assert.equal(invoice.computeInvoiceFigures(order).rows[0].gstPercent, 5);
  assert.match(html, /Total GST\)<\/td><td class="r">₹32\.00/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹672\.00/);
});

test('checkout apportions a capped coupon before applying each HSN slab', function () {
  const totals = pricing.computeTotals([
    { name: 'Rice', hsn: '1006', price: 500, qty: 2 },
    { name: 'Ghee', hsn: '0405', price: 1000, qty: 1 }
  ], ' save10 ');

  assert.deepEqual(totals.lines.map(function (line) {
    return [line.discount, line.taxable, line.gstPercent, line.tax];
  }), [[75, 925, 5, 46.25], [75, 925, 12, 111]]);
  assert.equal(totals.subtotal, 2000);
  assert.equal(totals.discount, 150);
  assert.equal(totals.taxable, 1850);
  assert.equal(totals.tax, 157.25);
  assert.equal(totals.cgst, 78.63);
  assert.equal(totals.sgst, 78.62);
  assert.equal(totals.total, 2007.25);
});

test('CURRENT BEHAVIOUR: a placed order loses catalog GST overrides but the invoice follows the recorded HSN', function (t) {
  const db = {
    products: [{ id: 1, name: 'Rice', hsn: '1006', gstRate: 12, price: 500, stock: 5 }],
    orders: [],
    nextOrderId: 1
  };
  t.mock.method(store, 'read', function () { return db; });
  const write = t.mock.method(store, 'write', function (record) {
    assert.equal(record, db);
  });
  const createOrder = orderRouter.stack.find(function (layer) {
    return layer.route.path === '/orders' && layer.route.methods.post;
  }).route.stack[0].handle;
  let status;
  let order;

  createOrder({ body: { items: [{ id: 1, qty: 2 }], coupon: ' save10 ' } }, {
    status(code) {
      status = code;
      return this;
    },
    json(body) {
      order = body;
    }
  });

  assert.equal(status, 201);
  assert.equal(write.mock.callCount(), 1);
  assert.equal(db.orders[0], order);
  assert.equal(order.items[0].hsn, '1006');
  assert.equal(Object.hasOwn(order.items[0], 'gstRate'), false);
  assert.equal(order.coupon, 'SAVE10');
  assert.equal(order.discount, 100);
  assert.equal(order.tax, 45);
  assert.equal(order.total, 945);

  const printed = invoice.computeInvoiceFigures(order);
  assert.equal(printed.rows[0].gstPercent, 5);
  assert.equal(printed.rows[0].lineTax, 45);
  assert.equal(printed.discount, 100);
  assert.equal(printed.cgst, 22.5);
  assert.equal(printed.sgst, 22.5);
  assert.equal(printed.total, 945);

  const html = invoice.render(order);
  assert.match(html, /Invoice Total<\/td><td class="r">₹945\.00/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹45\.00/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice uses the checkout coupon cap and applies GST after the discount', function () {
  const items = [{ name: 'Staples', price: 2000, qty: 1 }];
  const billed = pricing.computeTotals(items, 'SAVE10');
  const printed = invoice.computeInvoiceFigures({ items, coupon: 'SAVE10' });

  assert.deepEqual([billed.discount, billed.tax, billed.total], [150, 333, 2183]);
  assert.deepEqual([printed.discount, printed.tax, printed.total], [150, 333, 2183]);
});

test('invoice recalculation applies checkout eligibility for inactive and below-minimum coupons', function () {
  const items = [{ name: 'Staples', price: 100, qty: 1 }];

  assert.equal(pricing.computeTotals(items, 'DIWALI20').discount, 0);
  assert.equal(invoice.computeInvoiceFigures({ items, coupon: 'DIWALI20' }).discount, 0);
  assert.equal(pricing.computeTotals(items, 'FLAT50').discount, 0);
  assert.equal(invoice.computeInvoiceFigures({ items, coupon: 'FLAT50' }).discount, 0);
});

test('invoice and checkout both round GST per line', function () {
  const items = [
    { name: 'Sample A', price: 0.1, qty: 1, gstRate: 5 },
    { name: 'Sample B', price: 0.1, qty: 1, gstRate: 5 }
  ];
  const billed = pricing.computeTotals(items);
  const printed = invoice.computeInvoiceFigures({ items });

  assert.deepEqual(billed.lines.map(function (line) { return line.tax; }), [0.01, 0.01]);
  assert.deepEqual(printed.rows.map(function (line) { return line.lineTax; }), [0.01, 0.01]);
  assert.deepEqual([billed.tax, billed.cgst, billed.sgst, billed.total], [0.02, 0.01, 0.01, 0.22]);
  assert.deepEqual([printed.tax, printed.cgst, printed.sgst, printed.total], [0.02, 0.01, 0.01, 0.22]);
});

test('CURRENT BEHAVIOUR: reconciliation flags a GST-only mismatch while the printable invoice shows no notice', function () {
  const items = [{ name: 'Staples', price: 100, qty: 1 }];
  const order = {
    id: 1,
    date: '01/01/2026',
    items,
    coupon: 'WELCOME',
    subtotal: 100,
    discount: 5,
    tax: 18,
    total: 112.1
  };
  const matching = {
    ...order, id: 2, coupon: '', discount: 0, tax: 18, total: 118
  };
  const cancelled = { ...order, id: 3, status: 'cancelled' };
  const report = reports.getGstReconciliation({ orders: [order, matching, cancelled] });

  assert.equal(report.totalChecked, 2);
  assert.equal(report.mismatchCount, 1);
  assert.equal(report.totalDelta, 0);
  assert.deepEqual(report.rows.map(function (row) {
    return [row.orderId, row.ledgerTotal, row.invoiceTotal, row.ledgerTax, row.invoiceTax, row.delta, row.matched];
  }), [[1, 112.1, 112.1, 18, 17.1, 0, false], [2, 118, 118, 18, 18, 0, true]]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});
