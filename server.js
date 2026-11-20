require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   DATABASE MODELS
   ============================================================ */

const ticketSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    price: { type: Number, required: true, min: 0 },
    ageRange: { type: String, default: '' },
    iconBase64: { type: String, default: '' },
    perks: [{ type: String }],
    featured: { type: Boolean, default: false },
    badge: { type: String, default: '' },
    available: { type: Boolean, default: true },
    stock: { type: Number, default: 1000 }
  },
  { timestamps: true }
);
const Ticket = mongoose.model('Ticket', ticketSchema);

const orderItemSchema = new mongoose.Schema(
  {
    ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', required: true },
    quantity: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true }
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    customer: {
      name: { type: String, required: true, trim: true },
      email: { type: String, default: '' },
      phone: { type: String, required: true, trim: true }
    },
    items: [orderItemSchema],
    total: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'cancelled'],
      default: 'confirmed'
    },
    orderCode: { type: String, unique: true, required: true }
  },
  { timestamps: true }
);
const Order = mongoose.model('Order', orderSchema);

/* ============================================================
   HELPERS
   ============================================================ */

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ message: 'Admin not configured. Set ADMIN_TOKEN.' });
  }
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== ADMIN_TOKEN) return res.status(401).json({ message: 'Unauthorized' });
  next();
}

function monogram(letter, fg = '#0b3d2e', bg = '#efe9df') {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48'>` +
    `<rect width='48' height='48' fill='${bg}'/>` +
    `<text x='50%' y='50%' dominant-baseline='central' text-anchor='middle' ` +
    `font-family='Georgia, serif' font-size='22' font-weight='700' fill='${fg}'>${letter}</text>` +
    `</svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function buildDemoTickets() {
  return [
    {
      name: 'Single',
      description: 'Parfait pour venir profiter de toute la soirée.',
      price: 2000,
      ageRange: '1 Personne',
      perks: ['Accès à toutes les activités', 'Musique & Jeux', 'Soirée Cinéma'],
      iconBase64: monogram('S')
    },
    {
      name: 'Pack 5 Personnes',
      description: 'Venez en famille ou entre amis et économisez 1000 F.',
      price: 9000,
      ageRange: '5 Personnes',
      perks: ['5 entrées incluses', 'Barbecue & Feu de camp', 'Économisez 1000 F'],
      featured: true,
      badge: 'Le plus populaire',
      iconBase64: monogram('P', '#8e2c20', '#f5e6dc')
    },
    {
      name: 'Couple (2 Personnes)',
      description: 'Une soirée romantique sous les étoiles.',
      price: 3500,
      ageRange: '2 Personnes',
      perks: ['2 entrées incluses', 'Accès prioritaire', 'Économisez 500 F'],
      iconBase64: monogram('C')
    }
  ];
}

/* ============================================================
   PUBLIC API
   ============================================================ */

app.get('/api/tickets', async (req, res) => {
  try {
    const tickets = await Ticket.find({ available: true }).sort({ price: 1 });
    res.json(tickets);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    const { customer, items } = req.body;
    if (!customer?.name || !customer?.phone) {
      return res.status(400).json({ message: 'Nom et numéro de téléphone requis' });
    }
    if (!items || !items.length) {
      return res.status(400).json({ message: 'Cart is empty' });
    }
    let total = 0;
    const validatedItems = [];
    for (const item of items) {
      const ticket = await Ticket.findById(item.ticketId);
      if (!ticket || !ticket.available) {
        return res.status(400).json({ message: `Ticket unavailable` });
      }
      if (item.quantity < 1) {
        return res.status(400).json({ message: 'Quantity must be at least 1' });
      }
      total += ticket.price * item.quantity;
      validatedItems.push({
        ticketId: ticket._id,
        quantity: item.quantity,
        price: ticket.price
      });
    }
    const orderCode = 'FESTI-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const order = new Order({ customer, items: validatedItems, total, orderCode, status: 'pending' }); // Pending until Momo is added
    await order.save();
    res.status(201).json({ message: 'Order confirmed', order });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

app.get('/api/orders/:code', async (req, res) => {
  try {
    const order = await Order.findOne({ orderCode: req.params.code }).populate('items.ticketId', 'name price');
    if (!order) return res.status(404).json({ message: 'Billet introuvable' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

/* ============================================================
   ADMIN API
   ============================================================ */

app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_TOKEN) return res.status(503).json({ message: 'Admin not configured.' });
  const { token } = req.body || {};
  if (!token || token !== ADMIN_TOKEN) return res.status(401).json({ message: 'Jeton incorrect' });
  res.json({ ok: true });
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const [orders, tickets] = await Promise.all([
      Order.find({ status: { $ne: 'cancelled' } }),
      Ticket.countDocuments()
    ]);
    const revenue = orders.reduce((s, o) => s + o.total, 0);
    const ticketsSold = orders.reduce((s, o) => s + o.items.reduce((a, i) => a + i.quantity, 0), 0);
    res.json({ revenue, orderCount: orders.length, ticketsSold, ticketTypes: tickets });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 25, 200);
    const skip = Math.max(Number(req.query.skip) || 0, 0);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('items.ticketId', 'name price'),
      Order.countDocuments(filter)
    ]);
    res.json({ orders, total, skip, limit });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

app.patch('/api/admin/orders/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['pending', 'confirmed', 'cancelled'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!order) return res.status(404).json({ message: 'Not found' });
    res.json(order);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.get('/api/admin/tickets', requireAdmin, async (req, res) => {
  try {
    const [tickets, orders] = await Promise.all([
      Ticket.find().sort({ price: 1 }),
      Order.find({ status: { $ne: 'cancelled' } })
    ]);
    const soldMap = {};
    for (const o of orders) {
      for (const it of o.items) {
        const key = it.ticketId.toString();
        soldMap[key] = (soldMap[key] || 0) + it.quantity;
      }
    }
    const result = tickets.map((t) => {
      const obj = t.toObject();
      obj.sold = soldMap[t._id.toString()] || 0;
      return obj;
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

app.post('/api/admin/tickets', requireAdmin, async (req, res) => {
  try {
    const ticket = new Ticket(req.body);
    await ticket.save();
    res.status(201).json(ticket);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.patch('/api/admin/tickets/:id', requireAdmin, async (req, res) => {
  try {
    const ticket = await Ticket.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!ticket) return res.status(404).json({ message: 'Not found' });
    res.json(ticket);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.delete('/api/admin/tickets/:id', requireAdmin, async (req, res) => {
  try {
    const ticket = await Ticket.findByIdAndDelete(req.params.id);
    if (!ticket) return res.status(404).json({ message: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/* ============================================================
   STATIC PAGES & START
   ============================================================ */

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ message: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function seedIfEmpty() {
  try {
    // Drop existing tickets to force the new real tickets to load
    await Ticket.deleteMany({}); 
    await Ticket.insertMany(buildDemoTickets());
    console.log('Seeded real event tickets');
  } catch (err) {
    console.error('Seed check failed:', err.message);
  }
}

mongoose.connect(process.env.MONGODB_URI).then(async () => {
    console.log('Connected to MongoDB');
    await seedIfEmpty();
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  }).catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });
