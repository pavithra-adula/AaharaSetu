// routes/govt.js
// ─────────────────────────────────────────────────────────────────────────────
// Government Authority Portal — read complaints raised by citizens
// This is a SEPARATE portal from the shop admin.
// Shop admins CANNOT see malpractice complaints here (citizens file directly).
// Access is protected by a static GOVT_KEY header (set in .env).
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const db      = require('../db');
const router  = express.Router();
require('dotenv').config();

// Simple key-based auth for govt portal (not JWT — separate system)
function govtAuth(req, res, next) {
  const key = req.headers['x-govt-key'] || req.query.key;
  const validKey = process.env.GOVT_KEY || 'GOVT_TELANGANA_2026';
  if (!key || key !== validKey) {
    return res.status(401).json({ message: 'Unauthorized. Invalid government access key.' });
  }
  next();
}

// ── GET /api/govt/complaints ──
// All complaints across ALL shops (government sees everything)
router.get('/complaints', govtAuth, async (req, res) => {
  try {
    const { status, category, district_id, shop_id } = req.query;

    let q = `SELECT c.id, c.category, c.message, c.status, c.submitted_at,
                    u.name AS citizen_name, u.ration_card, u.phone,
                    rs.shop_name, rs.shop_code,
                    d.name AS district_name
             FROM complaints c
             JOIN users u        ON c.user_id=u.id
             LEFT JOIN ration_shops rs ON c.shop_id=rs.id
             LEFT JOIN districts d    ON rs.district_id=d.id
             WHERE 1=1`;
    const p = [];

    if (status)      { q += ' AND c.status=?';         p.push(status); }
    if (category)    { q += ' AND c.category LIKE ?';  p.push(`%${category}%`); }
    if (district_id) { q += ' AND d.id=?';             p.push(district_id); }
    if (shop_id)     { q += ' AND c.shop_id=?';        p.push(shop_id); }

    q += ' ORDER BY c.submitted_at DESC LIMIT 200';

    const [rows] = await db.execute(q, p);

    // Stats summary
    const [stats] = await db.execute(
      `SELECT
         COUNT(*) AS total,
         COUNT(CASE WHEN status='pending'  THEN 1 END) AS pending,
         COUNT(CASE WHEN status='resolved' THEN 1 END) AS resolved,
         COUNT(CASE WHEN category LIKE '%Malpractice%' THEN 1 END) AS malpractice
       FROM complaints`
    );

    res.json({ complaints: rows, stats: stats[0] });
  } catch (err) {
    console.error('Govt complaints error:', err);
    res.status(500).json({ message: 'Error fetching complaints.' });
  }
});

// ── GET /api/govt/complaints/:id ──
router.get('/complaints/:id', govtAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT c.*, u.name AS citizen_name, u.ration_card, u.phone, u.address,
              rs.shop_name, rs.shop_code, d.name AS district_name
       FROM complaints c
       JOIN users u        ON c.user_id=u.id
       LEFT JOIN ration_shops rs ON c.shop_id=rs.id
       LEFT JOIN districts d    ON rs.district_id=d.id
       WHERE c.id=?`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Complaint not found.' });
    res.json({ complaint: rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Error.' });
  }
});

// ── PATCH /api/govt/complaints/:id/action ──
// Govt marks a complaint as resolved or escalates it. Every action is
// recorded in the complaint_history table for a full audit trail.
router.patch('/complaints/:id/action', govtAuth, async (req, res) => {
  try {
    const { action, note } = req.body; // 'resolved' | 'escalated'
    const validActions = ['resolved', 'escalated'];
    const nextStatus = validActions.includes(action) ? action : 'resolved';

    const [rows] = await db.execute('SELECT * FROM complaints WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Complaint not found.' });
    const complaint = rows[0];
    const prevStatus = complaint.status;

    if (prevStatus === nextStatus) {
      return res.status(409).json({ message: `Complaint is already ${nextStatus}.` });
    }

    // Update the main status
    await db.execute('UPDATE complaints SET status=? WHERE id=?', [nextStatus, req.params.id]);

    // Record in history (best-effort — table may not exist on very old DBs)
    try {
      await db.execute(
        `INSERT INTO complaint_history (complaint_id, action, note, actor, from_status, to_status)
         VALUES (?,?,?,?,?,?)`,
        [complaint.id, nextStatus, note || null, 'government', prevStatus, nextStatus]
      );
    } catch (histErr) {
      if (histErr.code !== 'ER_NO_SUCH_TABLE') console.error('History log error:', histErr.message);
    }

    // Notify the citizen
    const msg = nextStatus === 'escalated'
      ? `⚠️ Your complaint (#${complaint.id}) has been escalated to the District Collector's office. Action will be taken within 7 working days.${note ? ' Note: ' + note : ''}`
      : `✅ Your complaint (#${complaint.id}) has been resolved by the Government Authority.${note ? ' Note: ' + note : ''}`;
    await db.execute(
      "INSERT INTO notifications (user_id, message, type) VALUES (?,?,'general')",
      [complaint.user_id, msg]
    );

    res.json({
      message: `Complaint #${complaint.id} marked as ${nextStatus}.`,
      complaint_id: complaint.id,
      from_status: prevStatus,
      to_status: nextStatus
    });
  } catch (err) {
    console.error('Complaint action error:', err);
    res.status(500).json({ message: 'Error updating complaint.' });
  }
});

// ── GET /api/govt/complaints/:id/history ──
// Full audit trail for a complaint
router.get('/complaints/:id/history', govtAuth, async (req, res) => {
  try {
    const [history] = await db.execute(
      `SELECT action, note, actor, from_status, to_status, created_at
       FROM complaint_history WHERE complaint_id=? ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json({ history });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.json({ history: [] });
    res.status(500).json({ message: 'Error fetching history.' });
  }
});

// ── GET /api/govt/dashboard ──
// High-level stats for government portal
router.get('/dashboard', govtAuth, async (req, res) => {
  try {
    const [shopStats] = await db.execute(
      `SELECT rs.shop_name, rs.shop_code, d.name AS district,
              ss.is_open,
              COUNT(DISTINCT u.id) AS citizens,
              COUNT(DISTINCT CASE WHEN s.slot_date=CURDATE() THEN b.id END) AS bookings_today,
              COUNT(DISTINCT CASE WHEN b.status='served' AND s.slot_date=CURDATE() THEN b.id END) AS served_today,
              COUNT(DISTINCT CASE WHEN stk.quantity/stk.max_capacity < 0.3 THEN stk.id END) AS low_stock
       FROM ration_shops rs
       LEFT JOIN districts d      ON d.id=rs.district_id
       LEFT JOIN shop_settings ss ON ss.shop_id=rs.id
       LEFT JOIN users u          ON u.shop_id=rs.id AND u.role='citizen'
       LEFT JOIN slots s          ON s.shop_id=rs.id AND s.slot_date=CURDATE()
       LEFT JOIN bookings b       ON b.slot_id=s.id
       LEFT JOIN stock stk        ON stk.shop_id=rs.id
       GROUP BY rs.id ORDER BY rs.shop_code`
    );
    const [complaintStats] = await db.execute(
      `SELECT COUNT(*) AS total,
              COUNT(CASE WHEN status='pending'  THEN 1 END) AS pending,
              COUNT(CASE WHEN status='resolved' THEN 1 END) AS resolved,
              COUNT(CASE WHEN category LIKE '%Malpractice%' THEN 1 END) AS malpractice
       FROM complaints`
    );
    const [districtStats] = await db.execute(
      `SELECT d.name, COUNT(DISTINCT u.id) AS citizens
       FROM districts d LEFT JOIN ration_shops rs ON rs.district_id=d.id
       LEFT JOIN users u ON u.shop_id=rs.id AND u.role='citizen'
       GROUP BY d.id ORDER BY d.name`
    );
    res.json({ shops: shopStats, complaints: complaintStats[0], districts: districtStats });
  } catch (err) {
    res.status(500).json({ message: 'Error loading govt dashboard.' });
  }
});

// ── GET /api/govt/ratings ──
// All citizen ratings with per-shop averages
router.get('/ratings', govtAuth, async (req, res) => {
  try {
    const [ratings] = await db.execute(
      `SELECT sr.stars, sr.review, sr.created_at,
              u.name AS citizen_name, u.ration_card,
              rs.shop_name, rs.shop_code,
              d.name AS district
       FROM ratings sr
       JOIN users u          ON u.id=sr.user_id
       JOIN ration_shops rs  ON rs.id=sr.shop_id
       LEFT JOIN districts d ON d.id=rs.district_id
       ORDER BY sr.created_at DESC
       LIMIT 200`
    );

    const [avgByShop] = await db.execute(
      `SELECT rs.shop_name, rs.shop_code,
              d.name AS district,
              ROUND(AVG(sr.stars),2) AS avg_stars,
              COUNT(sr.id) AS total_ratings
       FROM ration_shops rs
       JOIN ratings sr  ON sr.shop_id=rs.id
       LEFT JOIN districts d ON d.id=rs.district_id
       GROUP BY rs.id
       ORDER BY avg_stars DESC`
    );

    res.json({ ratings, avg_by_shop: avgByShop });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.json({ ratings: [], avg_by_shop: [] });
    }
    console.error('Ratings error:', err);
    res.status(500).json({ message: 'Error fetching ratings.' });
  }
});

module.exports = router;