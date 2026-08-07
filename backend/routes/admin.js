const express = require('express');
const db      = require('../db');
const { protect, adminOnly } = require('../middleware/auth');
const router  = express.Router();

router.use(protect, adminOnly);

function getIO(req) { return req.app.get('io'); }
function broadcastToShop(io, shopId, event, data) {
  io.to(`shop-${shopId}`).emit(event, data);
}

// ── Stats: TODAY only ──
async function getBookingCrowdToday(shopId, conn) {
  const db_ = conn || db;
  const [rows] = await db_.execute(
    `SELECT
       COUNT(CASE WHEN b.status='booked'  THEN 1 END) AS waiting,
       COUNT(CASE WHEN b.status='served'  THEN 1 END) AS served,
       COUNT(CASE WHEN b.status='expired' THEN 1 END) AS expired,
       COUNT(*) AS total
     FROM bookings b JOIN slots s ON b.slot_id = s.id
     WHERE s.shop_id = ? AND s.slot_date = CURDATE()`,
    [shopId]
  );
  const r     = rows[0];
  const pct   = r.total > 0 ? Math.round(r.waiting / r.total * 100) : 0;
  const level = pct >= 60 ? 'high' : pct >= 30 ? 'medium' : 'low';
  return { waiting: r.waiting, served: r.served, expired: r.expired, total: r.total, pct, level };
}

async function getPhysicalCrowd(shopId, conn) {
  const db_ = conn || db;
  const [rows] = await db_.execute(
    'SELECT COUNT(*) AS cnt FROM crowd_checkins WHERE shop_id=? AND checkin_date=CURDATE() AND checked_out=0',
    [shopId]
  );
  const cnt   = rows[0].cnt || 0;
  const pct   = Math.min(Math.round(cnt / 20 * 100), 100);
  const level = cnt >= 15 ? 'high' : cnt >= 7 ? 'medium' : 'low';
  return {
    waiting: cnt, pct, level,
    message: level === 'high'   ? 'Shop is busy. Consider a later slot.' :
             level === 'medium' ? 'Moderate crowd. ~15 min wait.' :
                                  'Not crowded. Great time to visit!'
  };
}

const CARD_MULTIPLIER = { APL: 1.0, BPL: 1.5, AAY: 2.0 };
const CARD_ITEMS = {
  APL: ['Rice', 'Wheat', 'Sugar', 'Edible Oil'],
  BPL: ['Rice', 'Wheat', 'Dal', 'Sugar', 'Edible Oil', 'Salt'],
  AAY: ['Rice', 'Wheat', 'Dal', 'Sugar', 'Edible Oil', 'Salt', 'Kerosene'],
};

// ── Dashboard ──
router.get('/dashboard', async (req, res) => {
  try {
    const shopId = req.user.shop_id;
    const { date } = req.query;
    const filterDate = date || new Date().toISOString().split('T')[0];
    const isToday = filterDate === new Date().toISOString().split('T')[0];

    const [crowdRows] = await db.execute(
      `SELECT
         COUNT(CASE WHEN b.status='booked'  THEN 1 END) AS waiting,
         COUNT(CASE WHEN b.status='served'  THEN 1 END) AS served,
         COUNT(CASE WHEN b.status='expired' THEN 1 END) AS expired,
         COUNT(*) AS total
       FROM bookings b JOIN slots s ON b.slot_id = s.id
       WHERE s.shop_id = ? AND s.slot_date = ?`,
      [shopId, filterDate]
    );
    const crowd = crowdRows[0];
    const pct   = crowd.total > 0 ? Math.round(crowd.waiting / crowd.total * 100) : 0;
    const level = pct >= 60 ? 'high' : pct >= 30 ? 'medium' : 'low';
    const physical = isToday ? await getPhysicalCrowd(shopId) : { waiting: 0, pct: 0, level: 'low', message: 'N/A for past dates' };

    const [lowStock] = await db.execute(
      'SELECT item_name, quantity, max_capacity, unit FROM stock WHERE shop_id=? AND quantity/max_capacity < 0.3',
      [shopId]
    );
    const [settings] = await db.execute(
      'SELECT ss.*, rs.shop_name, rs.shop_code FROM shop_settings ss JOIN ration_shops rs ON rs.id=ss.shop_id WHERE ss.shop_id=?',
      [shopId]
    );
    const [queue] = await db.execute(
      `SELECT b.id, b.token_number, b.priority_score, b.status,
              u.name AS citizen_name, u.ration_card, u.age, u.card_type,
              s.slot_label, s.slot_date
       FROM bookings b JOIN users u ON b.user_id=u.id JOIN slots s ON b.slot_id=s.id
       WHERE s.shop_id=? AND s.slot_date=?
       ORDER BY b.booked_at ASC`,
      [shopId, filterDate]
    );

    res.json({
      stats: {
        total:         crowd.total,
        waiting:       crowd.waiting,
        served:        crowd.served,
        expired:       crowd.expired,
        crowd_waiting: physical.waiting,
        crowd_level:   physical.level,
        crowd_pct:     physical.pct
      },
      shop:        settings[0] || {},
      low_stock:   lowStock,
      queue,
      filter_date: filterDate
    });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    res.status(500).json({ message: 'Error loading dashboard.' });
  }
});

// ── Bookings (today by default) ──
router.get('/bookings', async (req, res) => {
  try {
    const shopId = req.user.shop_id;
    const { date, status, slot_id } = req.query;
    const filterDate = date || new Date().toISOString().split('T')[0];

    let q = `SELECT b.id, b.token_number, b.priority_score, b.status, b.booked_at, b.served_at,
                    u.name AS citizen_name, u.ration_card, u.age, u.phone, u.card_type,
                    s.slot_label, s.slot_date, s.start_time, rs.shop_code
             FROM bookings b
             JOIN users u  ON b.user_id=u.id
             JOIN slots s  ON b.slot_id=s.id
             JOIN ration_shops rs ON rs.id=s.shop_id
             WHERE s.shop_id=? AND s.slot_date=?`;
    const p = [shopId, filterDate];
    if (status)  { q += ' AND b.status=?';  p.push(status); }
    if (slot_id) { q += ' AND b.slot_id=?'; p.push(slot_id); }
    q += ' ORDER BY b.booked_at ASC';

    const [rows] = await db.execute(q, p);
    res.json({ bookings: rows, date: filterDate });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching bookings.' });
  }
});

// ── Serve token (deducts stock, checks out from crowd) ──
router.patch('/bookings/:id/serve', async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const shopId = req.user.shop_id;

    const [bkgs] = await conn.execute(
      `SELECT b.*, u.id AS uid, u.name AS uname, u.shop_id, u.card_type
       FROM bookings b JOIN users u ON b.user_id=u.id
       WHERE b.id=? AND b.status='booked'`,
      [req.params.id]
    );
    if (!bkgs.length) { await conn.rollback(); return res.status(404).json({ message: 'Booking not found or already served.' }); }
    const bkg = bkgs[0];
    if (parseInt(bkg.shop_id) !== parseInt(shopId)) { await conn.rollback(); return res.status(403).json({ message: 'This booking does not belong to your shop.' }); }

    const [fam]    = await conn.execute('SELECT COUNT(*) AS c FROM family_members WHERE user_id=?', [bkg.uid]);
    const members  = fam[0].c || 1;
    const cardType = (bkg.card_type || 'BPL').toUpperCase();
    const multiplier   = CARD_MULTIPLIER[cardType] || 1.0;
    const allowedItems = CARD_ITEMS[cardType] || CARD_ITEMS.BPL;

    await conn.execute('UPDATE bookings SET status="served", served_at=NOW() WHERE id=?', [req.params.id]);

    const placeholders = allowedItems.map(() => '?').join(',');
    await conn.execute(
      `UPDATE stock SET quantity=GREATEST(0,quantity-(allotment_per_person*?*?)), last_updated=NOW()
       WHERE shop_id=? AND item_name IN (${placeholders})`,
      [members, multiplier, shopId, ...allowedItems]
    );

    // Auto-checkout from physical crowd counter (whether or not they checked in)
    const [existingCheckin] = await conn.execute(
      'SELECT id FROM crowd_checkins WHERE user_id=? AND shop_id=? AND checkin_date=CURDATE()',
      [bkg.uid, shopId]
    );
    if (existingCheckin.length > 0) {
      // They checked in — mark them out
      await conn.execute(
        'UPDATE crowd_checkins SET checked_out=1 WHERE user_id=? AND shop_id=? AND checkin_date=CURDATE()',
        [bkg.uid, shopId]
      );
    }
    // If they never checked in, crowd count is unaffected — nothing to do

    const [updatedStock] = await conn.execute('SELECT * FROM stock WHERE shop_id=?', [shopId]);
    const totalKg = (5 * members * multiplier).toFixed(1);

    await conn.execute(
      "INSERT INTO notifications (user_id, message, type) VALUES (?,?,'general')",
      [bkg.uid, `✅ Ration collected! Token ${bkg.token_number}. ${cardType} card — ${members} member(s) · ~${totalKg}kg rice equivalent distributed.`]
    );
    await conn.commit();

    const physical = await getPhysicalCrowd(shopId);
    const io = getIO(req);
    if (io) {
      broadcastToShop(io, shopId, 'crowd-update', { waiting: physical.waiting, pct: physical.pct, level: physical.level, message: physical.message });
      broadcastToShop(io, shopId, 'stock-update', { stock: updatedStock });
      broadcastToShop(io, shopId, 'citizen-served', { booking_id: parseInt(req.params.id), user_id: bkg.uid, token_number: bkg.token_number });
      broadcastToShop(io, shopId, 'notification', {
        message: `✅ Ration collected! Token ${bkg.token_number}. ${cardType} card — ${members} member(s).`,
        type: 'general', user_id: bkg.uid
      });
    }

    res.json({ message: `Token ${bkg.token_number} served.`, crowd_now: physical.waiting });
  } catch (err) {
    await conn.rollback();
    console.error('Serve error:', err);
    res.status(500).json({ message: 'Error marking as served.' });
  } finally { conn.release(); }
});

// ── Stock ──
router.get('/stock', async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT s.*, rs.shop_code FROM stock s JOIN ration_shops rs ON rs.id=s.shop_id WHERE s.shop_id=? ORDER BY item_name',
      [req.user.shop_id]
    );
    res.json({ stock: rows });
  } catch (err) { res.status(500).json({ message: 'Error fetching stock.' }); }
});

router.patch('/stock/:id', async (req, res) => {
  try {
    const { quantity } = req.body;
    const shopId = req.user.shop_id;
    if (quantity === undefined || quantity < 0) return res.status(400).json({ message: 'Valid quantity required.' });
    const [item] = await db.execute('SELECT shop_id FROM stock WHERE id=?', [req.params.id]);
    if (!item.length) return res.status(404).json({ message: 'Stock item not found.' });
    if (parseInt(item[0].shop_id) !== parseInt(shopId)) return res.status(403).json({ message: 'Not your shop.' });
    await db.execute('UPDATE stock SET quantity=?, last_updated=NOW() WHERE id=?', [quantity, req.params.id]);
    const [updatedStock] = await db.execute('SELECT * FROM stock WHERE shop_id=?', [shopId]);
    const io = getIO(req);
    if (io) broadcastToShop(io, shopId, 'stock-update', { stock: updatedStock });
    res.json({ message: 'Stock updated.', stock: updatedStock });
  } catch (err) { res.status(500).json({ message: 'Error updating stock.' }); }
});

// ── Shop settings ──
router.get('/shop-settings', async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT ss.*, rs.shop_name, rs.shop_code FROM shop_settings ss JOIN ration_shops rs ON rs.id=ss.shop_id WHERE ss.shop_id=?',
      [req.user.shop_id]
    );
    res.json({ settings: rows[0] || {} });
  } catch (err) { res.status(500).json({ message: 'Error fetching settings.' }); }
});

router.patch('/shop-settings', async (req, res) => {
  try {
    const shopId = req.user.shop_id;
    const { is_open, open_time, close_time, was_open } = req.body;

    await db.execute(
      'UPDATE shop_settings SET is_open=?, open_time=?, close_time=?, updated_at=NOW() WHERE shop_id=?',
      [is_open ? 1 : 0, open_time, close_time, shopId]
    );

    const [saved] = await db.execute(
      'SELECT ss.*, rs.shop_name FROM shop_settings ss JOIN ration_shops rs ON rs.id=ss.shop_id WHERE ss.shop_id=?',
      [shopId]
    );
    const savedSettings = saved[0];
    const status = is_open ? 'OPEN' : 'CLOSED';

    let expiredCount = 0;
    if (!is_open && was_open) {
      const [toExpire] = await db.execute(
        `SELECT b.id, b.user_id, b.token_number, s.slot_label, s.slot_date
         FROM bookings b JOIN slots s ON b.slot_id=s.id
         WHERE b.status='booked' AND s.shop_id=? AND s.slot_date=CURDATE()`, [shopId]
      );
      if (toExpire.length > 0) {
        await db.execute(
          `UPDATE bookings b JOIN slots s ON b.slot_id=s.id SET b.status='expired'
           WHERE b.status='booked' AND s.shop_id=? AND s.slot_date=CURDATE()`, [shopId]
        );
        for (const bk of toExpire) {
          await db.execute("INSERT INTO notifications (user_id, message, type) VALUES (?,?,?)",
            [bk.user_id, `🏪 Shop closed early. Token ${bk.token_number} for ${bk.slot_label} cancelled. You may re-book.`, 'slot']);
        }
        expiredCount = toExpire.length;
      }
    }

    const [citizens] = await db.execute("SELECT id FROM users WHERE shop_id=? AND role='citizen'", [shopId]);
    for (const c of citizens) {
      await db.execute("INSERT INTO notifications (user_id, shop_id, message, type) VALUES (?,?,?,'shop')",
        [c.id, shopId, `${savedSettings?.shop_name || 'Your shop'} is now ${status}. Hours: ${open_time} – ${close_time}`]);
    }

    const io = getIO(req);
    if (io) {
      broadcastToShop(io, shopId, 'shop-update', { shop_id: shopId, is_open: is_open ? 1 : 0, open_time, close_time, shop_name: savedSettings?.shop_name });
      if (expiredCount > 0) {
        broadcastToShop(io, shopId, 'notification', { message: `🏪 Shop closed early. ${expiredCount} token(s) cancelled.`, type: 'slot' });
      }
    }

    res.json({
      message: `Shop status set to ${status}. ${citizens.length} citizen(s) notified.${expiredCount > 0 ? ` ${expiredCount} token(s) cancelled.` : ''}`,
      saved: savedSettings
    });
  } catch (err) {
    console.error('Shop settings error:', err);
    res.status(500).json({ message: 'Error updating shop settings.' });
  }
});

// ── Physical crowd ──
router.get('/crowd', async (req, res) => {
  try {
    const shopId = req.user.shop_id;
    const { date } = req.query;
    const filterDate = date || new Date().toISOString().split('T')[0];
    const isToday = filterDate === new Date().toISOString().split('T')[0];
    const physical = isToday ? await getPhysicalCrowd(shopId) : { waiting: 0, pct: 0, level: 'low' };
    const [queue]  = await db.execute(
      `SELECT b.id, b.token_number, b.status, b.booked_at, u.name, u.ration_card
       FROM bookings b JOIN users u ON b.user_id=u.id JOIN slots s ON b.slot_id=s.id
       WHERE s.shop_id=? AND s.slot_date=? AND b.status='booked'
       ORDER BY b.booked_at ASC`,
      [shopId, filterDate]
    );
    res.json({ crowd_count: physical.waiting, level: physical.level, pct: physical.pct, queue });
  } catch (err) { res.status(500).json({ message: 'Error fetching crowd.' }); }
});

// ── Beneficiaries ──
router.get('/beneficiaries', async (req, res) => {
  try {
    const shopId = req.user.shop_id;
    const { search } = req.query;
    let q = `SELECT u.id, u.name, u.ration_card, u.phone, u.address,
                    u.pincode, u.age, u.card_type, u.created_at,
                    d.name AS district_name, rs.shop_code, rs.shop_name,
                    COUNT(f.id) AS family_count
             FROM users u
             LEFT JOIN family_members f ON f.user_id=u.id
             LEFT JOIN districts d      ON d.id=u.district_id
             LEFT JOIN ration_shops rs  ON rs.id=u.shop_id
             WHERE u.role='citizen' AND u.shop_id=?`;
    const p = [shopId];
    if (search) { q += ' AND (u.name LIKE ? OR u.ration_card LIKE ? OR u.phone LIKE ?)'; p.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    q += ' GROUP BY u.id ORDER BY u.name';
    const [rows] = await db.execute(q, p);
    res.json({ citizens: rows });
  } catch (err) { res.status(500).json({ message: 'Error fetching beneficiaries.' }); }
});

router.get('/beneficiaries/:id', async (req, res) => {
  try {
    const [u] = await db.execute(
      `SELECT u.*, d.name AS district_name, rs.shop_name, rs.shop_code
       FROM users u LEFT JOIN districts d ON d.id=u.district_id
       LEFT JOIN ration_shops rs ON rs.id=u.shop_id
       WHERE u.id=? AND u.role='citizen' AND u.shop_id=?`,
      [req.params.id, req.user.shop_id]
    );
    if (!u.length) return res.status(404).json({ message: 'Citizen not found.' });
    const [fam] = await db.execute(
      'SELECT id, serial_no, name, age, gender, relation_to_head FROM family_members WHERE user_id=? ORDER BY serial_no',
      [req.params.id]
    );
    res.json({ citizen: u[0], family: fam });
  } catch (err) { res.status(500).json({ message: 'Error.' }); }
});

// ── Complaints (shop admin view — cannot see malpractice content, only status) ──
router.get('/complaints', async (req, res) => {
  try {
    const shopId = req.user.shop_id;
    const { status } = req.query;
    let q = `SELECT c.id, c.category, c.message, c.status, c.submitted_at,
                    u.name AS citizen_name, u.ration_card, u.phone
             FROM complaints c JOIN users u ON c.user_id=u.id
             WHERE c.shop_id=?`;
    const p = [shopId];
    if (status) { q += ' AND c.status=?'; p.push(status); }
    q += ' ORDER BY c.submitted_at DESC';
    const [rows] = await db.execute(q, p);
    res.json({ complaints: rows });
  } catch (err) { res.status(500).json({ message: 'Error fetching complaints.' }); }
});

router.patch('/complaints/:id/resolve', async (req, res) => {
  try {
    const shopId = req.user.shop_id;
    const [rows] = await db.execute('SELECT * FROM complaints WHERE id=? AND shop_id=?', [req.params.id, shopId]);
    if (!rows.length) return res.status(404).json({ message: 'Complaint not found.' });
    await db.execute("UPDATE complaints SET status='resolved' WHERE id=? AND shop_id=?", [req.params.id, shopId]);
    const complaint = rows[0];
    await db.execute("INSERT INTO notifications (user_id, shop_id, message, type) VALUES (?,?,?,'general')",
      [complaint.user_id, shopId, `✅ Your complaint (#${complaint.id}) has been resolved by the shop admin.`]);
    const io = getIO(req);
    if (io) broadcastToShop(io, shopId, 'notification', { message: `✅ Complaint #${complaint.id} resolved.`, type: 'general', user_id: complaint.user_id });
    res.json({ message: 'Complaint resolved and citizen notified.' });
  } catch (err) { res.status(500).json({ message: 'Error resolving complaint.' }); }
});

// ── Send Notifications ──
// Body accepts either `identifier` (Citizen ID / phone / email) for specific target,
// or nothing → broadcast to all citizens of this shop.
router.post('/notifications', async (req, res) => {
  try {
    const shopId = req.user.shop_id;
    const { message, type, identifier } = req.body;
    if (!message) return res.status(400).json({ message: 'Message required.' });

    if (identifier) {
      const idn = String(identifier).trim();
      let sql, params;
      if (idn.includes('@')) {
        sql = "SELECT id, name FROM users WHERE email=? AND shop_id=? AND role='citizen'";
        params = [idn, shopId];
      } else if (/^\d{10}$/.test(idn)) {
        sql = "SELECT id, name FROM users WHERE phone=? AND shop_id=? AND role='citizen'";
        params = [idn, shopId];
      } else if (/^\d+$/.test(idn)) {
        sql = "SELECT id, name FROM users WHERE id=? AND shop_id=? AND role='citizen'";
        params = [parseInt(idn, 10), shopId];
      } else {
        return res.status(400).json({ message: 'Invalid identifier. Use Citizen ID, 10-digit phone, or email.' });
      }
      const [check] = await db.execute(sql, params);
      if (!check.length) return res.status(404).json({ message: 'Citizen not found in your shop.' });
      await db.execute('INSERT INTO notifications (user_id, shop_id, message, type) VALUES (?,?,?,?)',
        [check[0].id, shopId, message, type || 'general']);
      const io = getIO(req);
      if (io) broadcastToShop(io, shopId, 'notification', { message, type: type || 'general', shop_id: shopId, user_id: check[0].id });
      return res.status(201).json({ message: `Notification sent to ${check[0].name}.` });
    }

    const [citizens] = await db.execute("SELECT id FROM users WHERE role='citizen' AND shop_id=?", [shopId]);
    for (const c of citizens) {
      await db.execute('INSERT INTO notifications (user_id, shop_id, message, type) VALUES (?,?,?,?)',
        [c.id, shopId, message, type || 'general']);
    }
    const io = getIO(req);
    if (io) broadcastToShop(io, shopId, 'notification', { message, type: type || 'general', shop_id: shopId });
    res.status(201).json({ message: `Notification sent to ${citizens.length} citizen(s).` });
  } catch (err) {
    console.error('Notif error:', err);
    res.status(500).json({ message: 'Error sending notification.' });
  }
});

router.get('/ration-types', async (req, res) => {
  res.json({
    card_types: {
      APL: { name: 'Above Poverty Line', multiplier: 1.0, items: CARD_ITEMS.APL, description: 'Base allotment per person' },
      BPL: { name: 'Below Poverty Line', multiplier: 1.5, items: CARD_ITEMS.BPL, description: '1.5× base allotment per person' },
      AAY: { name: 'Antyodaya Anna Yojana', multiplier: 2.0, items: CARD_ITEMS.AAY, description: '2× base allotment per person — all items' }
    },
    example: { family_size: 4, rice_per_person_kg: 5, APL: { rice: 20 }, BPL: { rice: 30 }, AAY: { rice: 40 } }
  });
});

// ── Reports ──
router.get('/reports', async (req, res) => {
  try {
    const shopId = req.user.shop_id;
    const [daily] = await db.execute(
      `SELECT DATE(b.served_at) AS day, COUNT(*) AS count
       FROM bookings b JOIN slots s ON b.slot_id=s.id
       WHERE b.status='served' AND s.shop_id=? AND b.served_at >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
       GROUP BY DATE(b.served_at) ORDER BY day`, [shopId]
    );
    const [stock]   = await db.execute('SELECT * FROM stock WHERE shop_id=?', [shopId]);
    const [monthly] = await db.execute(
      `SELECT COUNT(*) AS total FROM bookings b JOIN slots s ON b.slot_id=s.id
       WHERE b.status='served' AND s.shop_id=?
       AND MONTH(s.slot_date)=MONTH(CURDATE()) AND YEAR(s.slot_date)=YEAR(CURDATE())`, [shopId]
    );
    res.json({ daily_served: daily, stock_status: stock, monthly_total: monthly[0].total });
  } catch (err) { res.status(500).json({ message: 'Error loading reports.' }); }
});

// ── Admin: Ratings summary + recent reviews ──
router.get('/ratings', async (req, res) => {
  try {
    const shopId = req.user.shop_id;

    // Per-star counts and average
    const [summary] = await db.execute(
      `SELECT
         COUNT(*) AS total,
         ROUND(AVG(stars), 1) AS avg_stars,
         SUM(CASE WHEN stars=5 THEN 1 ELSE 0 END) AS five,
         SUM(CASE WHEN stars=4 THEN 1 ELSE 0 END) AS four,
         SUM(CASE WHEN stars=3 THEN 1 ELSE 0 END) AS three,
         SUM(CASE WHEN stars=2 THEN 1 ELSE 0 END) AS two,
         SUM(CASE WHEN stars=1 THEN 1 ELSE 0 END) AS one
       FROM shop_ratings
       WHERE shop_id = ?`,
      [shopId]
    );

    // Recent individual reviews
    const [recent] = await db.execute(
      `SELECT sr.stars, sr.review, sr.created_at,
              u.name AS citizen_name
       FROM shop_ratings sr
       JOIN users u ON u.id = sr.user_id
       WHERE sr.shop_id = ?
       ORDER BY sr.created_at DESC
       LIMIT 20`,
      [shopId]
    );

    res.json({ summary: summary[0], recent });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.json({ summary: { total: 0, avg_stars: 0, five:0, four:0, three:0, two:0, one:0 }, recent: [] });
    }
    res.status(500).json({ message: 'Error fetching ratings.' });
  }
});

module.exports = router;