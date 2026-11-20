require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const QRCode = require('qrcode'); 

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
      default: 'pending'
    },
    orderCode: { type: String, unique: true, required: true },
    isScanned: { type: Boolean, default: false },
    scannedAt: { type: Date, default: null }
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
    const order = new Order({ customer, items: validatedItems, total, orderCode, status: 'pending' });
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
   PAYMENT & QR CODE ROUTES
   ============================================================ */

// ⚠️ TEST MODE: Set to 'false' when you want to use REAL money with SasaPay
const TEST_MODE = true; 

app.post('/api/payments/initialize', async (req, res) => {
  try {
    const { orderCode } = req.body;
    const order = await Order.findOne({ orderCode });
    if (!order) return res.status(404).json({ message: 'Order not found' });

    // If TEST_MODE is ON, redirect to our fake internal payment page
    if (TEST_MODE) {
      return res.json({ paymentUrl: `/mock-payment?ref=${orderCode}` });
    }

    // Real SasaPay Link (Used when TEST_MODE is false)
    const saspayUrl = `https://link.saspay.me/o9gdrykuu6u?ref=${orderCode}`; 
    res.json({ paymentUrl: saspayUrl });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Fake SasaPay Page (Only works when TEST_MODE = true)
app.get('/mock-payment', (req, res) => {
  const { ref } = req.query;
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Test Paiement - SasaPay</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: sans-serif; text-align: center; padding: 50px 20px; background: #eef2f5; margin: 0; }
        .card { background: white; padding: 30px; border-radius: 8px; max-width: 400px; margin: 0 auto; box-shadow: 0 4px 12px rgba(0,0,0,0.1); border-top: 6px solid #f1c40f; }
        h1 { color: #333; font-size: 1.4rem; }
        .btn { display: block; width: 100%; padding: 15px; background: #27ae60; color: white; border: none; border-radius: 4px; font-size: 1.1rem; font-weight: bold; margin-top: 20px; cursor: pointer; text-decoration: none; box-sizing: border-box; }
        .btn:hover { background: #219150; }
        .cancel { display: block; margin-top: 15px; color: #e74c3c; text-decoration: none; font-size: 0.9rem; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Passerelle de Test SasaPay</h1>
        <p>Code de commande : <strong>${ref || 'Inconnu'}</strong></p>
        <p style="color: #666; font-size: 0.9rem;">Ceci est une simulation. Aucun argent ne sera débité.</p>
        
        <a href="/payment/success?ref=${ref}" class="btn">Simuler le paiement réussi</a>
        <a href="/" class="cancel">Annuler et retourner à l'accueil</a>
      </div>
    </body>
    </html>
  `);
});

app.get('/payment/success', async (req, res) => {
  try {
    const { ref } = req.query;
    if (!ref) return res.status(400).send('Missing reference code.');

    const order = await Order.findOne({ orderCode: ref });
    if (!order) return res.status(404).send('Order not found.');

    if (order.status !== 'confirmed') {
      order.status = 'confirmed';
      await order.save();
    }

    const qrCodeDataUrl = await QRCode.toDataURL(order.orderCode);

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Billet Confirmé - Festi Noël</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
        <style>
          body { font-family: 'Inter', sans-serif; text-align: center; padding: 40px 20px; background: #fbf8f1; margin: 0; }
          .card { background: white; padding: 30px; border-radius: 8px; max-width: 400px; margin: 0 auto; box-shadow: 0 4px 12px rgba(0,0,0,0.08); border-top: 6px solid #0b3d2e; }
          .qr-img { width: 100%; max-width: 250px; height: auto; margin: 20px auto; display: block; border: 1px solid #eee; border-radius: 8px; padding: 10px; }
          h1 { color: #0b3d2e; font-family: Georgia, serif; margin-top: 0; }
          .code { font-family: monospace; font-size: 1.2rem; font-weight: bold; color: #b23a2c; background: #fdfaf3; padding: 8px 12px; border-radius: 4px; display: inline-block; margin-top: 10px; border: 1px dashed #ccc; }
          p { color: #626b66; line-height: 1.5; }
          .btn { display: inline-block; margin-top: 25px; padding: 12px 24px; background: #0b3d2e; color: white; text-decoration: none; border-radius: 4px; font-weight: 600; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Paiement Confirmé</h1>
          <p>Merci <strong>${order.customer.name}</strong>. Voici votre QR Code d'accès.</p>
          <img src="${qrCodeDataUrl}" class="qr-img" alt="QR Code">
          <p>Présentez ce code à l'entrée le 12 Décembre.</p>
          <div class="code">${order.orderCode}</div>
          <br>
          <a href="/" class="btn">Retour à l'accueil</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Server error generating QR code.');
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
    const [orders, total] = await Promise.all([
      Order.find().sort({ createdAt: -1 }).limit(50).populate('items.ticketId', 'name price'),
      Order.countDocuments()
    ]);
    res.json({ orders, total });
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

app.post('/api/admin/scan', requireAdmin, async (req, res) => {
  try {
    const { orderCode } = req.body;
    const order = await Order.findOne({ orderCode });

    if (!order) {
      return res.status(404).json({ message: "Fake ticket. Introuvable." });
    }
    if (order.status !== 'confirmed') {
      return res.status(400).json({ message: "Paiement non validé (En attente)." });
    }
    if (order.isScanned) {
      return res.status(400).json({ message: "DÉJÀ SCANNÉ ! Accès refusé." });
    }

    order.isScanned = true;
    order.scannedAt = new Date();
    await order.save();

    res.json({ message: "Accès Autorisé", customer: order.customer.name });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
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
    await Ticket.deleteMany({}); 
    await Ticket.insertMany(buildDemoTickets());
    console.log('Seeded 2 real event tickets (Single & Pack 5)');
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
