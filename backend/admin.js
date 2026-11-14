// Admin routes: login, orders, products, stock. Everything except /login needs the admin token.
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const pool = require('./db');

const router = express.Router();

const PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET =
  process.env.ADMIN_SECRET || crypto.createHash('sha256').update('bita-admin|' + PASSWORD).digest('hex');
const TOKEN_HOURS = 12;

const CATEGORIES = ['tees', 'hoodies', 'pants', 'accessories'];
const KINDS = ['tee', 'otee', 'hoodie', 'cargo', 'track', 'cap'];
const ORDER_STATUSES = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

function makeToken() {
  const exp = String(Date.now() + TOKEN_HOURS * 3600 * 1000);
  return `${exp}.${sign(exp)}`;
}
function tokenOk(token) {
  if (typeof token !== 'string') return false;
  const [exp, mac] = token.split('.');
  if (!exp || !mac || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const a = Buffer.from(mac);
  const b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function auth(req, res, next) {
  if (!PASSWORD) return res.status(503).json({ error: 'Admin is not set up yet' });
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ') || !tokenOk(h.slice(7))) return res.status(401).json({ error: 'Please log in again' });
  next();
}

// Wraps a handler so errors become clean JSON answers
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error(`${req.method} /api/admin${req.path} failed:`, err.message);
    res.status(500).json({ error: 'Something went wrong' });
  }
};

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' },
});

router.post(
  '/login',
  loginLimiter,
  wrap(async (req, res) => {
    if (!PASSWORD) throw new HttpError(503, 'Admin is not set up yet');
    const given = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
    if (!crypto.timingSafeEqual(sha(given), sha(PASSWORD))) throw new HttpError(401, 'Wrong password');
    res.json({ token: makeToken(), hours: TOKEN_HOURS });
  })
);

router.use(auth);

/* ---------- helpers ---------- */
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const whole = (v) => (Number.isInteger(Number(v)) && v !== '' && v !== null ? Number(v) : NaN);

function cleanImages(list) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list) || list.length > 8) throw new HttpError(400, 'Use up to 8 photos');
  return list.map((x) => {
    const u = str(x, 300);
    if (!/^(https:\/\/|images\/)[^\s"'<>]+$/.test(u)) {
      throw new HttpError(400, `Photo address "${u}" is not valid. Use https://... or images/name.jpg`);
    }
    return u;
  });
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'product';
}

/* ---------- orders ---------- */
router.get(
  '/orders',
  wrap(async (req, res) => {
    const status = str(req.query.status, 20);
    const params = [];
    let where = '';
    if (status) {
      if (!ORDER_STATUSES.includes(status)) throw new HttpError(400, 'Unknown status');
      params.push(status);
      where = 'where o.status = $1';
    }
    const { rows } = await pool.query(
      `select o.code, o.status, o.payment_method, o.payment_status, o.subtotal, o.shipping, o.total,
              o.name, o.phone, o.email, o.address, o.city, o.state, o.pin, o.created_at,
              coalesce(json_agg(json_build_object('name', i.name, 'color', i.color, 'size', i.size,
                                                   'qty', i.qty, 'price', i.price) order by i.id)
                       filter (where i.id is not null), '[]') as items
         from orders o left join order_items i on i.order_id = o.id
         ${where}
        group by o.id order by o.created_at desc limit 200`,
      params
    );
    res.json(rows);
  })
);

router.patch(
  '/orders/:code',
  wrap(async (req, res) => {
    const code = String(req.params.code).toUpperCase();
    const status = str(req.body && req.body.status, 20);
    if (!ORDER_STATUSES.includes(status)) throw new HttpError(400, 'Choose a valid status');

    const client = await pool.connect();
    try {
      await client.query('begin');
      const found = await client.query(
        'select id, status, payment_method from orders where code = $1 for update',
        [code]
      );
      if (!found.rows.length) throw new HttpError(404, 'Order not found');
      const o = found.rows[0];

      if (o.status === status) {
        await client.query('rollback');
        return res.json({ ok: true, status });
      }
      if (o.status === 'cancelled') throw new HttpError(409, 'A cancelled order cannot be reopened');

      if (status === 'cancelled') {
        // Give the stock back
        await client.query(
          `update variants v set stock = v.stock + oi.qty
             from order_items oi
            where oi.order_id = $1 and v.product_id = oi.product_id and v.color = oi.color and v.size = oi.size`,
          [o.id]
        );
      }
      await client.query('update orders set status = $1 where id = $2', [status, o.id]);
      if (status === 'delivered' && o.payment_method === 'cod') {
        await client.query(`update orders set payment_status = 'paid' where id = $1`, [o.id]);
      }
      await client.query('commit');
      res.json({ ok: true, status });
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  })
);

/* ---------- products ---------- */
router.get(
  '/products',
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `select p.id, p.slug, p.name, p.category, p.kind, p.description, p.price, p.mrp, p.badge, p.images, p.active,
              coalesce(json_agg(json_build_object('color', v.color, 'size', v.size, 'stock', v.stock) order by v.id)
                       filter (where v.id is not null), '[]') as variants
         from products p left join variants v on v.product_id = p.id
        group by p.id order by p.id`
    );
    res.json(rows);
  })
);

router.post(
  '/products',
  wrap(async (req, res) => {
    const b = req.body || {};
    const name = str(b.name, 100);
    const category = str(b.category, 20);
    const kind = str(b.kind, 20);
    const description = str(b.description, 1000);
    const price = whole(b.price);
    const mrp = b.mrp === '' || b.mrp == null ? price : whole(b.mrp);
    const badge = str(b.badge, 20) || null;
    const images = cleanImages(b.images) || [];
    const stock = b.stock === undefined || b.stock === '' ? 0 : whole(b.stock);

    if (name.length < 2) throw new HttpError(400, 'Enter the product name');
    if (!CATEGORIES.includes(category)) throw new HttpError(400, 'Choose a category');
    if (!KINDS.includes(kind)) throw new HttpError(400, 'Choose a shape');
    if (!(price > 0) || price > 1000000) throw new HttpError(400, 'Enter a valid price');
    if (!(mrp >= price)) throw new HttpError(400, 'MRP must be the same as or more than the price');
    if (!(stock >= 0 && stock <= 100000)) throw new HttpError(400, 'Enter a valid stock number');

    const colors = [...new Set((Array.isArray(b.colors) ? b.colors : []).map((c) => str(c, 30).toLowerCase()).filter(Boolean))];
    const sizes = [...new Set((Array.isArray(b.sizes) ? b.sizes : []).map((s) => str(s, 20)).filter(Boolean))];
    if (!colors.length || colors.length > 10) throw new HttpError(400, 'Add at least one colour');
    if (!sizes.length || sizes.length > 12) throw new HttpError(400, 'Add at least one size');

    const client = await pool.connect();
    try {
      await client.query('begin');
      let slug = slugify(name);
      for (let n = 2; (await client.query('select 1 from products where slug = $1', [slug])).rows.length; n++) {
        slug = `${slugify(name)}-${n}`;
      }
      const ins = await client.query(
        `insert into products (slug, name, category, kind, description, price, mrp, badge, images, active)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) returning id`,
        [slug, name, category, kind, description, price, mrp, badge, images]
      );
      const id = ins.rows[0].id;
      for (const color of colors) {
        for (const size of sizes) {
          await client.query('insert into variants (product_id, color, size, stock) values ($1,$2,$3,$4)', [id, color, size, stock]);
        }
      }
      await client.query('commit');
      res.status(201).json({ id, slug });
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  })
);

router.patch(
  '/products/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new HttpError(404, 'Product not found');
    const b = req.body || {};
    const sets = [];
    const vals = [];
    const add = (col, val) => {
      vals.push(val);
      sets.push(`${col} = $${vals.length}`);
    };

    if (b.name !== undefined) {
      const v = str(b.name, 100);
      if (v.length < 2) throw new HttpError(400, 'Enter the product name');
      add('name', v);
    }
    if (b.category !== undefined) {
      if (!CATEGORIES.includes(b.category)) throw new HttpError(400, 'Choose a category');
      add('category', b.category);
    }
    if (b.kind !== undefined) {
      if (!KINDS.includes(b.kind)) throw new HttpError(400, 'Choose a shape');
      add('kind', b.kind);
    }
    if (b.description !== undefined) add('description', str(b.description, 1000));
    if (b.price !== undefined) {
      const v = whole(b.price);
      if (!(v > 0) || v > 1000000) throw new HttpError(400, 'Enter a valid price');
      add('price', v);
    }
    if (b.mrp !== undefined) {
      const v = whole(b.mrp);
      if (!(v > 0) || v > 1000000) throw new HttpError(400, 'Enter a valid MRP');
      add('mrp', v);
    }
    if (b.badge !== undefined) add('badge', str(b.badge, 20) || null);
    if (b.images !== undefined) add('images', cleanImages(b.images));
    if (b.active !== undefined) add('active', Boolean(b.active));
    if (!sets.length) throw new HttpError(400, 'Nothing to change');

    vals.push(id);
    const r = await pool.query(`update products set ${sets.join(', ')} where id = $${vals.length} returning id`, vals);
    if (!r.rows.length) throw new HttpError(404, 'Product not found');
    res.json({ ok: true });
  })
);

// Sets the stock of one colour and size. Creates it if it does not exist yet.
router.put(
  '/products/:id/stock',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const color = str(req.body && req.body.color, 30).toLowerCase();
    const size = str(req.body && req.body.size, 20);
    const stock = whole(req.body && req.body.stock);
    if (!Number.isInteger(id) || id < 1 || !color || !size) throw new HttpError(400, 'Invalid request');
    if (!(stock >= 0 && stock <= 100000)) throw new HttpError(400, 'Enter a valid stock number');

    const exists = await pool.query('select 1 from products where id = $1', [id]);
    if (!exists.rows.length) throw new HttpError(404, 'Product not found');

    const up = await pool.query(
      'update variants set stock = $1 where product_id = $2 and color = $3 and size = $4 returning id',
      [stock, id, color, size]
    );
    if (!up.rows.length) {
      await pool.query('insert into variants (product_id, color, size, stock) values ($1,$2,$3,$4)', [id, color, size, stock]);
    }
    res.json({ ok: true, stock });
  })
);

module.exports = router;