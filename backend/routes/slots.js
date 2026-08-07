const express = require('express');
const db      = require('../db');
const { protect, citizenOnly, adminOnly } = require('../middleware/auth');
const router  = express.Router();

// 24-hour coverage — 8 slots of 3 hours each. All slots open to everyone.
const SLOT_DEFS = [
  { label:'12 - 3 AM',     start:'00:00', end:'03:00', max:4, elder:false },
  { label:'3 - 6 AM',      start:'03:00', end:'06:00', max:4, elder:false },
  { label:'6 - 9 AM',      start:'06:00', end:'09:00', max:4, elder:false },
  { label:'9 AM - 12 PM',  start:'09:00', end:'12:00', max:4, elder:false },
  { label:'12 - 3 PM',     start:'12:00', end:'15:00', max:4, elder:false },
  { label:'3 - 6 PM',      start:'15:00', end:'18:00', max:4, elder:false },
  { label:'6 - 9 PM',      start:'18:00', end:'21:00', max:4, elder:false },
  { label:'9 PM - 12 AM',  start:'21:00', end:'24:00', max:4, elder:false },
];

function calcPriority(age, userPin, shopPin) {
  if (age >= 60) return 1;
  const diff = Math.abs(parseInt(userPin || 0) - parseInt(shopPin || 0));
  if (diff > 500) return 2;
  if (diff > 100) return 3;
  return 4;
}

function tokenNum(count) {
  const g = ['A','B','C','D','E'][Math.floor(count / 20)] || 'Z';
  return `${g}-${String((count % 20) + 1).padStart(2,'0')}`;
}

function getIO(req) { return req.app.get('io'); }

function broadcastToShop(io, shopId, event, data) {
  io.to(`shop-${shopId}`).emit(event, data);
}

// ── Safely build a slot's end-of-window Date object ──
// MySQL DATE columns come back as Date objects at midnight in the server's local TZ.
// Using getUTC*() shifts a day off for negative-UTC-offset situations, so we use
// local getters and pass numeric args to the Date constructor — that always builds
// the exact wall-clock time in the server's local timezone, which on the user's
// Mac is IST. Comparing against new Date() (also local) gives a correct verdict.
function slotEndDateIST(slot_date, end_time) {
  let y, mo, d;
  if (slot_date instanceof Date) {
    y  = slot_date.getFullYear();
    mo = slot_date.getMonth();
    d  = slot_date.getDate();
  } else {
    const parts = String(slot_date).slice(0, 10).split('-');
    y  = parseInt(parts[0], 10);
    mo = parseInt(parts[1], 10) - 1;
    d  = parseInt(parts[2], 10);
  }
  const [h, mi, s = 0] = String(end_time).split(':').map(n => parseInt(n, 10));
  return new Date(y, mo, d, h, mi, s || 0);
}

router.get('/', protect, async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ message: 'date is required (YYYY-MM-DD).' });
    const shopId = req.user.shop_id;

    const [exist] = await db.execute('SELECT id FROM slots WHERE shop_id=? AND slot_date=?', [shopId, date]);
    if (exist.length === 0) {
      for (const s of SLOT_DEFS) {
        await db.execute(
          'INSERT IGNORE INTO slots (shop_id, slot_date, slot_label, start_time, end_time, max_tokens, is_elder_slot) VALUES (?,?,?,?,?,?,?)',
          [shopId, date, s.label, s.start, s.end, s.max, s.elder]
        );
      }
    }

    const [slots] = await db.execute(
      `SELECT s.*, COUNT(b.id) AS booked_count
       FROM slots s
       LEFT JOIN bookings b ON b.slot_id=s.id AND b.status IN ('booked','served')
       WHERE s.shop_id=? AND s.slot_date=?
       GROUP BY s.id ORDER BY s.start_time`,
      [shopId, date]
    );

    const [uRows] = await db.execute('SELECT age FROM users WHERE id=?', [req.user.id]);
    const citizenAge = uRows[0]?.age || 0;

    // "Now" as an absolute instant — compare against slot end (which we build in IST below)
    const now = new Date();

    res.json({
      date,
      citizen_age: citizenAge,
      slots: slots.map(s => {
        // Build slot end as an IST-anchored Date, then compare to current instant
        const slotEndIST = slotEndDateIST(s.slot_date, s.end_time);
        const isPast = slotEndIST <= now;
        return {
          id:            s.id,
          label:         s.slot_label,
          start_time:    s.start_time,
          end_time:      s.end_time,
          max_tokens:    s.max_tokens,
          booked_count:  s.booked_count,
          remaining:     Math.max(0, s.max_tokens - s.booked_count),
          is_full:       s.booked_count >= s.max_tokens,
          is_elder_slot: !!s.is_elder_slot,
          elder_locked:  !!s.is_elder_slot && citizenAge < 60,
          is_past:       isPast
        };
      })
    });
  } catch (err) {
    console.error('Slots error:', err);
    res.status(500).json({ message: 'Error fetching slots.' });
  }
});

router.post('/book', protect, citizenOnly, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { slot_id } = req.body;
    if (!slot_id) {
      await conn.rollback();
      return res.status(400).json({ message: 'slot_id is required.' });
    }

    const [slots] = await conn.execute('SELECT * FROM slots WHERE id=? FOR UPDATE', [slot_id]);
    if (!slots.length) {
      await conn.rollback();
      return res.status(404).json({ message: 'Slot not found.' });
    }
    const slot = slots[0];

    if (parseInt(slot.shop_id) !== parseInt(req.user.shop_id)) {
      await conn.rollback();
      return res.status(403).json({ message: 'This slot does not belong to your assigned shop.' });
    }

    if (slot.is_elder_slot) {
      const [uAge] = await conn.execute('SELECT age FROM users WHERE id=?', [req.user.id]);
      if ((uAge[0]?.age || 0) < 60) {
        await conn.rollback();
        return res.status(403).json({
          message: 'The Elder Walk-in slot is reserved for senior citizens (age 60+) only. Please select another time slot.'
        });
      }
    }

    // Block booking a slot whose end time has already passed (compared in IST)
    const slotEndIST = slotEndDateIST(slot.slot_date, slot.end_time);
    if (slotEndIST <= new Date()) {
      await conn.rollback();
      return res.status(409).json({
        message: 'This time slot has already passed. Please choose an upcoming slot.'
      });
    }

    const [monthServed] = await conn.execute(
      `SELECT b.id FROM bookings b JOIN slots s ON b.slot_id=s.id
       WHERE b.user_id=? AND b.status='served'
         AND MONTH(s.slot_date)=MONTH(?) AND YEAR(s.slot_date)=YEAR(?)`,
      [req.user.id, slot.slot_date, slot.slot_date]
    );
    if (monthServed.length) {
      await conn.rollback();
      return res.status(409).json({ message: 'You have already collected your ration this month.' });
    }

    const [monthBooked] = await conn.execute(
      `SELECT b.id FROM bookings b JOIN slots s ON b.slot_id=s.id
       WHERE b.user_id=? AND b.status='booked'
         AND MONTH(s.slot_date)=MONTH(?) AND YEAR(s.slot_date)=YEAR(?)`,
      [req.user.id, slot.slot_date, slot.slot_date]
    );
    if (monthBooked.length) {
      await conn.rollback();
      return res.status(409).json({ message: 'You already have an active booking this month. It will expire automatically if you miss it.' });
    }

    // Check rebook limit: max 2 expired (missed) bookings allowed per month; 3rd miss = cannot rebook
    const [monthExpired] = await conn.execute(
      `SELECT b.id FROM bookings b JOIN slots s ON b.slot_id=s.id
       WHERE b.user_id=? AND b.status='expired'
         AND MONTH(s.slot_date)=MONTH(?) AND YEAR(s.slot_date)=YEAR(?)`,
      [req.user.id, slot.slot_date, slot.slot_date]
    );
    if (monthExpired.length >= 2) {
      await conn.rollback();
      return res.status(409).json({
        message: `You have used all your re-booking chances for this month (max 2 re-books allowed). You will not be able to collect ration this month. Please collect your ration next month when the system resets.`
      });
    }

    const [cnt] = await conn.execute(
      "SELECT COUNT(*) AS c FROM bookings WHERE slot_id=? AND status IN ('booked','served')",
      [slot_id]
    );
    if (cnt[0].c >= slot.max_tokens) {
      await conn.rollback();
      return res.status(409).json({ message: 'This slot is full. Please choose another.' });
    }

    // Priority concept removed — strictly first-come, first-served by booked_at
    const tkn = tokenNum(cnt[0].c);

    const [result] = await conn.execute(
      "INSERT INTO bookings (user_id, slot_id, token_number, priority_score, status) VALUES (?,?,?,4,'booked')",
      [req.user.id, slot_id, tkn]
    );

    await conn.execute(
      "INSERT INTO notifications (user_id, message, type) VALUES (?,?,?)",
      [req.user.id, `✅ Booking confirmed! Token ${tkn} for ${slot.slot_label} on ${slot.slot_date}. Please arrive on time.`, 'slot']
    );

    await conn.commit();

    // Use physical crowd count (crowd_checkins) — same source as dashboard
    const [physRows] = await db.execute(
      'SELECT COUNT(*) AS cnt FROM crowd_checkins WHERE shop_id=? AND checkin_date=CURDATE() AND checked_out=0',
      [req.user.shop_id]
    );
    const physCount = physRows[0].cnt || 0;
    const physLevel = physCount >= 15 ? 'high' : physCount >= 7 ? 'medium' : 'low';
    const physPct   = Math.min(Math.round(physCount / 20 * 100), 100);

    const io = getIO(req);
    if (io) {
      broadcastToShop(io, req.user.shop_id, 'new-booking', {
        booking_id:   result.insertId,
        token_number: tkn,
        slot_label:   slot.slot_label,
        slot_date:    slot.slot_date,
        citizen_name: req.user.name
      });
      broadcastToShop(io, req.user.shop_id, 'crowd-update', {
        waiting: physCount,
        pct:     physPct,
        level:   physLevel,
        message: physLevel === 'high'   ? 'Shop is busy. Consider a later slot.' :
                 physLevel === 'medium' ? 'Moderate crowd. ~15 min wait.' :
                                         'Not crowded. Great time to visit!'
      });
    }

    res.status(201).json({
      message:      'Slot booked successfully!',
      booking_id:   result.insertId,
      token_number: tkn,
      slot_label:   slot.slot_label,
      slot_date:    slot.slot_date,
    });
  } catch (err) {
    await conn.rollback();
    console.error('Book error:', err);
    res.status(500).json({ message: 'Server error booking slot.' });
  } finally {
    conn.release();
  }
});

router.get('/my-bookings', protect, citizenOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT b.id, b.token_number, b.priority_score, b.status, b.booked_at, b.served_at,
              s.slot_label, s.slot_date, s.start_time, s.end_time
       FROM bookings b JOIN slots s ON b.slot_id=s.id
       WHERE b.user_id=? ORDER BY b.booked_at DESC`,
      [req.user.id]
    );
    res.json({ bookings: rows });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching bookings.' });
  }
});

router.patch('/expire', protect, adminOnly, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const shopId    = req.user.shop_id;
    const shopClose = req.body?.shop_close === true;
    const closeTime = req.body?.close_time;

    const whereClause = shopClose && closeTime
      ? `b.status='booked' AND s.shop_id=? AND s.slot_date=CURDATE() AND s.start_time >= ?`
      : `b.status='booked' AND s.shop_id=? AND CONCAT(s.slot_date,' ',s.end_time) < NOW()`;

    const params = shopClose && closeTime ? [shopId, closeTime] : [shopId];

    const [toExpire] = await conn.execute(
      `SELECT b.id, b.user_id, b.token_number, s.slot_label, s.slot_date, s.start_time
       FROM bookings b JOIN slots s ON b.slot_id=s.id
       WHERE ${whereClause}`,
      params
    );

    if (toExpire.length > 0) {
      await conn.execute(
        `UPDATE bookings b JOIN slots s ON b.slot_id=s.id SET b.status='expired' WHERE ${whereClause}`,
        params
      );

      for (const bk of toExpire) {
        const msg = shopClose
          ? `🏪 Shop closed early. Your token ${bk.token_number} for ${bk.slot_label} on ${bk.slot_date} has been cancelled. You may re-book for another day.`
          : `⚠️ You missed your ration! Token ${bk.token_number} for ${bk.slot_label} on ${bk.slot_date} has expired. You may re-book a new slot.`;
        await conn.execute(
          "INSERT INTO notifications (user_id, message, type) VALUES (?,?,?)",
          [bk.user_id, msg, 'slot']
        );
      }
    }

    await conn.commit();

    const io = getIO(req);
    if (io && toExpire.length > 0) {
      broadcastToShop(io, shopId, 'tokens-expired', { count: toExpire.length, shop_id: shopId, shop_close: shopClose });
      for (const bk of toExpire) {
        broadcastToShop(io, shopId, 'notification', {
          message: shopClose
            ? `🏪 Shop closed. Token ${bk.token_number} cancelled. You may re-book.`
            : `⚠️ Token ${bk.token_number} expired. You may re-book.`,
          type:    'slot',
          user_id: bk.user_id
        });
      }
    }

    res.json({
      message: shopClose
        ? `Shop closed. ${toExpire.length} upcoming token(s) cancelled and citizens notified.`
        : `${toExpire.length} token(s) expired.`,
      expired: toExpire.length
    });
  } catch (err) {
    await conn.rollback();
    console.error('Expire error:', err);
    res.status(500).json({ message: 'Error expiring tokens.' });
  } finally {
    conn.release();
  }
});

module.exports = router;