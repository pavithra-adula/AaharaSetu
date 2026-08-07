const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const db         = require('./db');
require('dotenv').config();

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin:  ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5000'],
    methods: ['GET', 'POST']
  },
  allowEIO3:    true,
  pingTimeout:  60000,
  pingInterval: 25000
});

app.set('io', io);

io.on('connection', (socket) => {
  socket.on('join-shop', (shopId) => {
    if (!shopId) return;
    socket.join(`shop-${shopId}`);
    socket.emit('joined-shop', { shop_id: shopId });
  });

  socket.on('disconnect', () => {});
});

app.use(cors({
  origin:         ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5000', '*'],
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-govt-key'],
  credentials:    true
}));
app.options('*', cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth',    require('./routes/auth'));
app.use('/api/slots',   require('./routes/slots'));
app.use('/api/citizen', require('./routes/citizen'));
app.use('/api/admin',   require('./routes/admin'));
app.use('/api/govt',    require('./routes/govt'));

app.get('/', (req, res) => {
  res.json({ status: 'running', api_base: `http://localhost:${process.env.PORT || 5000}/api` });
});

app.use((req, res) => res.status(404).json({ message: `Route ${req.originalUrl} not found.` }));
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Internal server error.' });
});

// ── Auto-expiry scheduler: runs every 60 seconds ──
// Expires any booking whose slot end_time has passed and status is still 'booked'
// Sends notification to citizen and broadcasts socket event
async function runAutoExpiry() {
  try {
    // Find all overdue booked slots (slot end time has passed, booking still active)
    const [toExpire] = await db.execute(
      `SELECT b.id, b.user_id, b.token_number, s.shop_id,
              s.slot_label, s.slot_date, s.start_time, s.end_time
       FROM bookings b
       JOIN slots s ON b.slot_id = s.id
       WHERE b.status = 'booked'
         AND CONCAT(s.slot_date, ' ', s.end_time) < NOW()`
    );

    if (toExpire.length === 0) return;

    // Mark them all expired
    const ids = toExpire.map(b => b.id);
    await db.execute(
      `UPDATE bookings SET status='expired' WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    );

    // Send notification to each citizen and broadcast socket event
    for (const bk of toExpire) {
      // DB notification
      await db.execute(
        `INSERT INTO notifications (user_id, shop_id, message, type) VALUES (?, ?, ?, 'slot')`,
        [
          bk.user_id,
          bk.shop_id,
          `⚠️ You missed your ration! Token ${bk.token_number} for ${bk.slot_label} on ${bk.slot_date} has expired. You can book a new slot now.`
        ]
      );

      // Real-time socket push to citizen's shop room
      io.to(`shop-${bk.shop_id}`).emit('notification', {
        user_id: bk.user_id,
        message: `⚠️ Token ${bk.token_number} (${bk.slot_label}) expired. Book a new slot now.`,
        type: 'slot'
      });

      io.to(`shop-${bk.shop_id}`).emit('tokens-expired', {
        count:   1,
        shop_id: bk.shop_id
      });
    }

    console.log(`[Auto-Expiry] ${toExpire.length} token(s) expired at ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.error('[Auto-Expiry] Error:', err.message);
  }
}

// Run immediately on startup, then every 60 seconds
runAutoExpiry();
setInterval(runAutoExpiry, 60 * 1000);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`\n Server running at http://localhost:${PORT}`);
  console.log(` Frontend     at http://localhost:3000\n`);
});