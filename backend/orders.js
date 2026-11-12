// Order routes: POST /api/orders and GET /api/orders/:code?phone=...
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const pool = require('./db');

const router = express.Router();

const SHIPPING_FEE = Number(process.env.SHIPPING_FEE || 0); // 0 = free shipping
const HOLD_MINUTES = 30; // unpaid online orders give their stock back after this long
const PAYMENTS = ['upi', 'card', 'cod'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Checks everything the customer sent. Prices are never read from the request.
function cleanOrder(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Invalid request');

  const c = body.customer || {};
  const customer = {
    name: text(c.name, 80),
    phone: text(c.phone, 20),
    email: text(c.email, 120).toLowerCase(),
    address: text(c.address, 200),
    city: text(c.city, 60),
    state: text(c.state, 60),
    pin: text(c.pin, 20),
  };
  if (customer.name.length < 2) throw new HttpError(400, 'Enter your full name');
  if (!/^[6-9]\d{9}$/.test(customer.phone)) throw new HttpError(400, 'Enter a valid 10-digit phone number');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) throw new HttpError(400, 'Enter a valid email address');
  if (customer.address.length < 5) throw new HttpError(400, 'Enter your full address');
  if (!customer.city) throw new HttpError(400, 'Enter your city');
  if (!customer.state) throw new HttpError(400, 'Enter your state');
  if (!/^\d{6}$/.test(customer.pin)) throw new HttpError(400, 'Enter a valid 6-digit PIN code');

  const payment = text(body.payment, 10);
  if (!PAYMENTS.includes(payment)) throw new HttpError(400, 'Choose a payment method');

  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20) {
    throw new HttpError(400, 'Your cart is empty');
  }
  const merged = new Map();
  for (const it of body.items) {
    const productId = Number(it && it.productId);
    const qty = Number(it && it.qty);
    const color = text(it && it.color, 30);
    const size = text(it && it.size, 20);
    if (!Number.isInteger(productId) || productId < 1 || !Number.isInteger(qty) || qty < 1 || !color || !size) {
      throw new HttpError(400, 'Invalid item in your cart');
    }
    const key = `${productId}|${color}|${size}`;
    const have = merged.has(key) ? merged.get(key).qty : 0;
    merged.set(key, { productId, color, size, qty: have + qty });
  }
  const items = [...merged.values()];
  if (items.some((i) => i.qty > 10)) throw new HttpError(400, 'You can order up to 10 of one item');
  // Same order every time, so two orders never wait on each other in a circle
  items.sort((a, b) => a.productId - b.productId || a.color.localeCompare(b.color) || a.size.localeCompare(b.size));

  return { customer, payment, items };
}

async function newCode(client) {
  for (let i = 0; i < 5; i++) {
    const code = 'BT' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 7);
    const { rows } = await client.query('select 1 from orders where code = $1', [code]);
    if (!rows.length) return code;
  }
  throw new Error('Could not make an order code');
}

// Locks the stock rows, takes prices from the database, reduces stock, saves the order
async function createOrder({ customer, payment, items }) {
  const client = await pool.connect();
  try {
    await client.query('begin');

    const lines = [];
    for (const it of items) {
      const { rows } = await client.query(
        `select v.id, v.stock, p.name, p.price
           from variants v join products p on p.id = v.product_id
          where v.product_id = $1 and v.color = $2 and v.size = $3 and p.active
            for update of v`,
        [it.productId, it.color, it.size]
      );
      if (!rows.length) throw new HttpError(400, 'One of the items in your cart is no longer available');
      const row = rows[0];
      if (row.stock < it.qty) {
        const label = `${row.name} (${it.color}, ${it.size})`;
        throw new HttpError(409, row.stock > 0 ? `Only ${row.stock} left of ${label}` : `${label} is sold out`);
      }
      lines.push({ ...it, variantId: row.id, name: row.name, price: row.price });
    }

    const subtotal = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
    const shipping = SHIPPING_FEE;
    const total = subtotal + shipping;

    const cod = payment === 'cod';
    const status = cod ? 'confirmed' : 'pending';
    const paymentStatus = cod ? 'pay_on_delivery' : 'unpaid';
    const code = await newCode(client);

    const ins = await client.query(
      `insert into orders (code, status, payment_method, payment_status, subtotal, shipping, total,
                           name, phone, email, address, city, state, pin)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       returning id`,
      [code, status, payment, paymentStatus, subtotal, shipping, total,
        customer.name, customer.phone, customer.email, customer.address, customer.city, customer.state, customer.pin]
    );
    const orderId = ins.rows[0].id;

    for (const l of lines) {
      await client.query(
        `insert into order_items (order_id, product_id, name, color, size, qty, price)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [orderId, l.productId, l.name, l.color, l.size, l.qty, l.price]
      );
      await client.query('update variants set stock = stock - $1 where id = $2', [l.qty, l.variantId]);
    }

    await client.query('commit');
    return { code, status, paymentMethod: payment, paymentStatus, subtotal, shipping, total };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Unpaid online orders older than HOLD_MINUTES are cancelled and their stock is given back
async function releaseExpired() {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `select id from orders
        where status = 'pending' and payment_method <> 'cod' and payment_status = 'unpaid'
          and created_at < now() - interval '${HOLD_MINUTES} minutes'
          for update skip locked`
    );
    for (const o of rows) {
      await client.query(
        `update variants v set stock = v.stock + oi.qty
           from order_items oi
          where oi.order_id = $1 and v.product_id = oi.product_id and v.color = oi.color and v.size = oi.size`,
        [o.id]
      );
      await client.query(`update orders set status = 'cancelled', payment_status = 'expired' where id = $1`, [o.id]);
    }
    await client.query('commit');
    if (rows.length) console.log(`Released ${rows.length} unpaid order(s)`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    console.error('releaseExpired failed:', err.message);
  } finally {
    client.release();
  }
}
setInterval(releaseExpired, 5 * 60 * 1000).unref();

const createLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many orders from this connection. Please try again in a few minutes.' },
});

router.post('/', createLimiter, async (req, res) => {
  try {
    const order = await createOrder(cleanOrder(req.body));
    res.status(201).json({ order });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error('POST /api/orders failed:', err.message);
    res.status(500).json({ error: 'Could not place the order. Please try again.' });
  }
});

// Order tracking: the order code and the phone number used on the order must both match
router.get('/:code', async (req, res) => {
  try {
    const code = String(req.params.code).toUpperCase();
    const phone = text(req.query.phone, 20);
    if (!/^BT[0-9A-F]{7}$/.test(code) || !/^[6-9]\d{9}$/.test(phone)) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const { rows } = await pool.query('select * from orders where code = $1 and phone = $2', [code, phone]);
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    const o = rows[0];
    const items = await pool.query(
      'select name, color, size, qty, price from order_items where order_id = $1 order by id',
      [o.id]
    );
    res.json({
      code: o.code,
      status: o.status,
      paymentMethod: o.payment_method,
      paymentStatus: o.payment_status,
      subtotal: o.subtotal,
      shipping: o.shipping,
      total: o.total,
      city: o.city,
      createdAt: o.created_at,
      items: items.rows,
    });
  } catch (err) {
    console.error('GET /api/orders/:code failed:', err.message);
    res.status(500).json({ error: 'Could not load the order' });
  }
});

module.exports = router;