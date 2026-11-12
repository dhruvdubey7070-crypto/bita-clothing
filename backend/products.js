// Product routes: GET /api/products and GET /api/products/:idOrSlug
const express = require('express');
const pool = require('./db');

const router = express.Router();

const SELECT = `
  select p.id, p.slug, p.name, p.category, p.kind, p.description,
         p.price, p.mrp, p.badge, p.images,
         coalesce(
           json_agg(json_build_object('color', v.color, 'size', v.size, 'stock', v.stock) order by v.id)
             filter (where v.id is not null),
           '[]'
         ) as variants
  from products p
  left join variants v on v.product_id = p.id
  where p.active`;

// Turns a database row into the shape the website uses
function shape(row) {
    const COLOR_ORDER = ['black', 'white', 'charcoal'];
  const SIZE_ORDER = ['S', 'M', 'L', 'XL', 'XXL'];
  const rank = (list, x) => (list.includes(x) ? list.indexOf(x) : list.length);
  const colors = [...new Set(row.variants.map((v) => v.color))]
    .sort((a, b) => rank(COLOR_ORDER, a) - rank(COLOR_ORDER, b) || a.localeCompare(b));
  const sizes = [...new Set(row.variants.map((v) => v.size))]
    .sort((a, b) => rank(SIZE_ORDER, a) - rank(SIZE_ORDER, b) || a.localeCompare(b, undefined, { numeric: true }));
  const stock = {};
  for (const v of row.variants) stock[`${v.color}|${v.size}`] = v.stock;
  const total = row.variants.reduce((sum, v) => sum + v.stock, 0);

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    cat: row.category,
    kind: row.kind,
    desc: row.description,
    price: row.price,
    mrp: row.mrp,
    badge: row.badge,
    img: row.images,
    colors,
    sizes,
    stock,        // for example { "black|M": 20 }
    soldOut: total === 0,
  };
}

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`${SELECT} group by p.id order by p.id`);
    res.json(rows.map(shape));
  } catch (err) {
    console.error('GET /api/products failed:', err.message);
    res.status(500).json({ error: 'Could not load products' });
  }
});

router.get('/:key', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${SELECT} and (p.id::text = $1 or p.slug = $1) group by p.id`,
      [req.params.key]
    );
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json(shape(rows[0]));
  } catch (err) {
    console.error('GET /api/products/:key failed:', err.message);
    res.status(500).json({ error: 'Could not load the product' });
  }
});

module.exports = router;