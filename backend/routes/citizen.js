const express = require('express');
const db      = require('../db');
const { protect, citizenOnly } = require('../middleware/auth');
const router  = express.Router();

// ── Dashboard ──
router.get('/dashboard', protect, citizenOnly, async (req, res) => {
  try {
    const shopId = req.user.shop_id;

    const [settings] = await db.execute(
      'SELECT ss.*, rs.shop_name, rs.shop_code FROM shop_settings ss JOIN ration_shops rs ON rs.id = ss.shop_id WHERE ss.shop_id = ?',
      [shopId]
    );

    // Physical crowd (people who checked in and not yet checked out)
    const [physCrowd] = await db.execute(
      'SELECT COUNT(*) AS cnt FROM crowd_checkins WHERE shop_id=? AND checkin_date=CURDATE() AND checked_out=0',
      [shopId]
    );
    const physCount = physCrowd[0].cnt || 0;
    const physLevel = physCount >= 15 ? 'high' : physCount >= 7 ? 'medium' : 'low';

    // Booking stats today (for "served today" count)
    const [bookingStats] = await db.execute(
      `SELECT
         COUNT(CASE WHEN b.status='booked'  THEN 1 END) AS waiting,
         COUNT(CASE WHEN b.status='served'  THEN 1 END) AS served,
         COUNT(*) AS total
       FROM bookings b JOIN slots s ON b.slot_id=s.id
       WHERE s.shop_id=? AND s.slot_date=CURDATE()`,
      [shopId]
    );
    const bs = bookingStats[0];

    const [token] = await db.execute(
      `SELECT b.token_number, s.slot_label, s.slot_date
       FROM bookings b JOIN slots s ON b.slot_id = s.id
       WHERE b.user_id = ? AND s.slot_date = CURDATE() AND b.status = 'booked' LIMIT 1`,
      [req.user.id]
    );

    const [unread] = await db.execute(
      'SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND is_read = 0',
      [req.user.id]
    );

    // This month's booking status for the citizen
    const [monthStatus] = await db.execute(
      `SELECT b.status FROM bookings b JOIN slots s ON b.slot_id=s.id
       WHERE b.user_id=? AND MONTH(s.slot_date)=MONTH(CURDATE()) AND YEAR(s.slot_date)=YEAR(CURDATE())
       ORDER BY b.booked_at DESC LIMIT 1`,
      [req.user.id]
    );

    // Count expired (missed) bookings this month for rebook-limit enforcement
    const [monthExpired] = await db.execute(
      `SELECT COUNT(*) AS cnt FROM bookings b JOIN slots s ON b.slot_id=s.id
       WHERE b.user_id=? AND b.status='expired'
         AND MONTH(s.slot_date)=MONTH(CURDATE()) AND YEAR(s.slot_date)=YEAR(CURDATE())`,
      [req.user.id]
    );

    // Has citizen checked in today and not yet checked out?
    const [checkinRow] = await db.execute(
      'SELECT id FROM crowd_checkins WHERE user_id=? AND checkin_date=CURDATE() AND checked_out=0',
      [req.user.id]
    );

    const shop = settings[0] || {};
    res.json({
      shop: {
        is_open:    shop.is_open,
        open_time:  shop.open_time,
        close_time: shop.close_time,
        shop_name:  shop.shop_name,
        shop_code:  shop.shop_code
      },
      crowd: {
        waiting: physCount,
        served:  bs.served,
        total:   bs.total,
        pct:     Math.min(Math.round(physCount / 20 * 100), 100),
        level:   physLevel,
        message: physLevel === 'high'   ? 'Shop is busy. Consider coming later.' :
                 physLevel === 'medium' ? 'Moderate crowd. ~15 min wait.' :
                                         'Not crowded. Great time to visit!'
      },
      active_token:       token[0] || null,
      unread_count:       unread[0].cnt,
      this_month_status:        monthStatus[0]?.status || null,
      this_month_expired_count: monthExpired[0]?.cnt || 0,
      checked_in_today:         checkinRow.length > 0
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ message: 'Error loading dashboard.' });
  }
});

// ── Stock ──
router.get('/stock', protect, citizenOnly, async (req, res) => {
  try {
    const [stock] = await db.execute(
      'SELECT * FROM stock WHERE shop_id = ? ORDER BY item_name',
      [req.user.shop_id]
    );
    res.json({ stock });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching stock.' });
  }
});

// ── My Details: family pre-stored in DB by phone/ration card ──
// NO email shown. Family members come from family_members table.
// If empty, auto-seeds from family-seed-data.js on first access.
const familySeedData = require('../family-seed-data');

router.get('/details', protect, citizenOnly, async (req, res) => {
  try {
    const [users] = await db.execute(
      `SELECT u.id, u.name, u.phone, u.ration_card, u.address, u.pincode, u.age, u.card_type,
              d.name AS district_name, rs.shop_name, rs.shop_code
       FROM users u
       LEFT JOIN districts d ON d.id = u.district_id
       LEFT JOIN ration_shops rs ON rs.id = u.shop_id
       WHERE u.id = ?`,
      [req.user.id]
    );
    if (!users.length) return res.status(404).json({ message: 'User not found.' });

    // Fetch family members linked to this user_id
    let [family] = await db.execute(
      'SELECT serial_no, name, age, gender, relation_to_head FROM family_members WHERE user_id = ? ORDER BY serial_no',
      [req.user.id]
    );

    // ── Auto-seed family members if empty and phone has seed data ──
    if (family.length === 0 && users[0].phone && familySeedData[users[0].phone]) {
      const seed = familySeedData[users[0].phone];
      for (const m of seed) {
        await db.execute(
          'INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head) VALUES (?, ?, ?, ?, ?, ?)',
          [req.user.id, m.serial_no, m.name, m.age, m.gender, m.relation_to_head]
        );
      }
      // Re-fetch after seeding
      [family] = await db.execute(
        'SELECT serial_no, name, age, gender, relation_to_head FROM family_members WHERE user_id = ? ORDER BY serial_no',
        [req.user.id]
      );
    }

    res.json({ user: users[0], family });
  } catch (err) {
    console.error('Details error:', err);
    res.status(500).json({ message: 'Error fetching details.' });
  }
});

// ── Crowd checkin: citizen clicks "I Am At Shop" ──
// Increments physical crowd. Decremented automatically when admin marks token served.
router.post('/crowd/checkin', protect, citizenOnly, async (req, res) => {
  try {
    const shopId = req.user.shop_id;
    const userId = req.user.id;

    const [existing] = await db.execute(
      'SELECT id, checked_out FROM crowd_checkins WHERE user_id = ? AND checkin_date = CURDATE()',
      [userId]
    );

    if (existing.length > 0 && existing[0].checked_out === 0) {
      // Already checked in and still at shop
      const [count] = await db.execute(
        'SELECT COUNT(*) AS cnt FROM crowd_checkins WHERE shop_id=? AND checkin_date=CURDATE() AND checked_out=0',
        [shopId]
      );
      return res.json({
        message:     'You are already checked in at the shop.',
        crowd_count: count[0].cnt,
        already:     true
      });
    }

    if (existing.length > 0 && existing[0].checked_out === 1) {
      // Person left earlier but returned — reset their checkout flag
      await db.execute(
        'UPDATE crowd_checkins SET checked_out=0 WHERE user_id=? AND checkin_date=CURDATE()',
        [userId]
      );
    } else {
      // Fresh checkin for today
      await db.execute(
        'INSERT INTO crowd_checkins (user_id, shop_id, checkin_date) VALUES (?, ?, CURDATE())',
        [userId, shopId]
      );
    }

    const [count] = await db.execute(
      'SELECT COUNT(*) AS cnt FROM crowd_checkins WHERE shop_id=? AND checkin_date=CURDATE() AND checked_out=0',
      [shopId]
    );

    const crowdCount = count[0].cnt;
    const level      = crowdCount >= 15 ? 'high' : crowdCount >= 7 ? 'medium' : 'low';

    const io = req.app.get('io');
    if (io) {
      io.to(`shop-${shopId}`).emit('crowd-update', {
        waiting: crowdCount,
        pct:     Math.min(Math.round(crowdCount / 20 * 100), 100),
        level,
        message: level === 'high'   ? 'Shop is busy. Consider coming later.' :
                 level === 'medium' ? 'Moderate crowd. ~15 min wait.' :
                                     'Not crowded. Great time to visit!'
      });
    }

    res.json({ message: 'You are now marked as present at the shop.', crowd_count: crowdCount });
  } catch (err) {
    console.error('Crowd checkin error:', err);
    res.status(500).json({ message: 'Error processing check-in.' });
  }
});

// ── Notifications ──
// ── Crowd checkout: called when ration collected or citizen leaves ──
router.post('/crowd/checkout', protect, citizenOnly, async (req, res) => {
  try {
    const shopId = req.user.shop_id;
    const userId = req.user.id;

    await db.execute(
      'UPDATE crowd_checkins SET checked_out=1 WHERE user_id=? AND shop_id=? AND checkin_date=CURDATE()',
      [userId, shopId]
    );

    const [count] = await db.execute(
      'SELECT COUNT(*) AS cnt FROM crowd_checkins WHERE shop_id=? AND checkin_date=CURDATE() AND checked_out=0',
      [shopId]
    );
    const crowdCount = count[0].cnt;
    const level      = crowdCount >= 15 ? 'high' : crowdCount >= 7 ? 'medium' : 'low';

    const io = req.app.get('io');
    if (io) {
      io.to(`shop-${shopId}`).emit('crowd-update', {
        waiting: crowdCount,
        pct:     Math.min(Math.round(crowdCount / 20 * 100), 100),
        level,
        message: level === 'high'   ? 'Shop is busy. Consider coming later.' :
                 level === 'medium' ? 'Moderate crowd. ~15 min wait.' :
                                     'Not crowded. Great time to visit!'
      });
    }

    res.json({ message: 'Checked out from shop.', crowd_count: crowdCount });
  } catch (err) {
    console.error('Crowd checkout error:', err);
    res.status(500).json({ message: 'Error processing checkout.' });
  }
});

router.get('/notifications', protect, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT * FROM notifications
       WHERE user_id = ? OR (shop_id = ? AND user_id IS NULL)
       ORDER BY created_at DESC LIMIT 50`,
      [req.user.id, req.user.shop_id]
    );
    res.json({ notifications: rows });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching notifications.' });
  }
});

router.get('/notifications/unread-count', protect, async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND is_read = 0',
      [req.user.id]
    );
    res.json({ count: rows[0].cnt });
  } catch (err) {
    res.status(500).json({ message: 'Error.' });
  }
});

router.patch('/notifications/read-all', protect, async (req, res) => {
  try {
    await db.execute('UPDATE notifications SET is_read=1 WHERE user_id=?', [req.user.id]);
    res.json({ message: 'All marked as read.' });
  } catch (err) {
    res.status(500).json({ message: 'Error.' });
  }
});

router.patch('/notifications/:id/read', protect, async (req, res) => {
  try {
    await db.execute(
      'UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?',
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Marked as read.' });
  } catch (err) {
    res.status(500).json({ message: 'Error.' });
  }
});

// ── Complaints — citizen files complaint, goes to shop + govt ──
router.post('/complaints', protect, citizenOnly, async (req, res) => {
  try {
    const { category, message } = req.body;
    if (!category || !message) return res.status(400).json({ message: 'Category and message are required.' });
    await db.execute(
      'INSERT INTO complaints (user_id, shop_id, category, message) VALUES (?,?,?,?)',
      [req.user.id, req.user.shop_id, category, message]
    );
    // Notify citizen that complaint was received
    await db.execute(
      "INSERT INTO notifications (user_id, message, type) VALUES (?,?,'general')",
      [req.user.id, `📝 Your complaint about "${category}" has been received and forwarded to the Government Authority.`]
    );
    res.status(201).json({ message: 'Complaint recorded and forwarded to Government Authority.' });
  } catch (err) {
    res.status(500).json({ message: 'Error submitting complaint.' });
  }
});

// ── GET /citizen/ratings — fetch this citizen's past ratings (keyed by booking_id) ──
router.get('/ratings', protect, citizenOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT sr.id, sr.booking_id, sr.stars, sr.review, sr.created_at
       FROM ratings sr
       WHERE sr.user_id = ?
       ORDER BY sr.created_at DESC`,
      [req.user.id]
    );
    res.json({ ratings: rows });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.json({ ratings: [] });
    res.status(500).json({ message: 'Error fetching ratings.' });
  }
});

// ── POST /citizen/ratings — submit a star rating linked to a booking ──
router.post('/ratings', protect, citizenOnly, async (req, res) => {
  try {
    const { booking_id, stars, review } = req.body;
    if (!stars || stars < 1 || stars > 5) return res.status(400).json({ message: 'Stars must be between 1 and 5.' });
    if (!booking_id) return res.status(400).json({ message: 'booking_id is required.' });

    // Verify this booking belongs to this citizen and is served
    const [bkgs] = await db.execute(
      `SELECT b.id, b.user_id, s.shop_id FROM bookings b
       JOIN slots s ON b.slot_id=s.id
       WHERE b.id=? AND b.user_id=? AND b.status='served'`,
      [booking_id, req.user.id]
    );
    if (!bkgs.length) return res.status(403).json({ message: 'You can only rate after your ration has been collected.' });

    const shopId = bkgs[0].shop_id;

    // Upsert — one rating per booking
    await db.execute(
      `INSERT INTO ratings (user_id, shop_id, booking_id, stars, review, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE stars=VALUES(stars), review=VALUES(review), created_at=NOW()`,
      [req.user.id, shopId, booking_id, stars, review || null]
    );
    res.json({ message: 'Thank you for your rating!' });
  } catch (err) {
    console.error('Rating error:', err);
    res.status(500).json({ message: 'Error submitting rating.' });
  }
});

// ── POST /citizen/rating (legacy singular) — kept for dashboard popup compatibility ──
router.post('/rating', protect, citizenOnly, async (req, res) => {
  try {
    const { stars, review } = req.body;
    if (!stars || stars < 1 || stars > 5) return res.status(400).json({ message: 'Stars must be between 1 and 5.' });
    const [served] = await db.execute(
      `SELECT b.id FROM bookings b JOIN slots s ON b.slot_id=s.id
       WHERE b.user_id=? AND b.status='served'
         AND MONTH(s.slot_date)=MONTH(CURDATE()) AND YEAR(s.slot_date)=YEAR(CURDATE())`,
      [req.user.id]
    );
    if (!served.length) return res.status(403).json({ message: 'You can only rate after collecting your ration.' });
    const bookingId = served[0].id;
    await db.execute(
      `INSERT INTO ratings (user_id, shop_id, booking_id, stars, review, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE stars=VALUES(stars), review=VALUES(review), created_at=NOW()`,
      [req.user.id, req.user.shop_id, bookingId, stars, review || null]
    );
    res.json({ message: 'Thank you for your rating!' });
  } catch (err) {
    console.error('Rating (legacy) error:', err);
    res.status(500).json({ message: 'Error submitting rating.' });
  }
});

router.get('/my-complaints', protect, citizenOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT id, category, message, status, submitted_at FROM complaints WHERE user_id=? ORDER BY submitted_at DESC',
      [req.user.id]
    );
    res.json({ complaints: rows });
  } catch (err) {
    res.status(500).json({ message: 'Error.' });
  }
});

module.exports = router;