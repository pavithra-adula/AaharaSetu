// routes/auth.js
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const db       = require('../db');
const { generateOTP, sendOTPEmail } = require('../mailer');
const router   = express.Router();
require('dotenv').config();

function makeToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name, shop_id: user.shop_id },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  );
}

// ─── GET /api/auth/districts ─────────────────────────────
// Returns all Telangana districts
router.get('/districts', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT id, name FROM districts ORDER BY name');
    res.json({ districts: rows });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching districts.' });
  }
});

// ─── GET /api/auth/shops?district_id=X ───────────────────
// Returns shops for a given district
router.get('/shops', async (req, res) => {
  try {
    const { district_id } = req.query;
    if (!district_id) return res.status(400).json({ message: 'district_id is required.' });
    const [rows] = await db.execute(
      'SELECT id, shop_code, shop_name, address, pincode FROM ration_shops WHERE district_id = ? ORDER BY shop_code',
      [district_id]
    );
    res.json({ shops: rows });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching shops.' });
  }
});

// ─── POST /api/auth/send-otp ──────────────────────────────
// Step 1 of registration: validate phone+shop, send OTP email
router.post('/send-otp', async (req, res) => {
  try {
    const { name, email, phone, shop_id, district_id, age, address, pincode, password } = req.body;

    // Basic validation
    if (!name || !email || !phone || !shop_id || !district_id || !age || !address || !pincode || !password) {
      return res.status(400).json({ message: 'All fields are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    // Check if email already registered
    const [emailCheck] = await db.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (emailCheck.length > 0) {
      return res.status(409).json({ message: 'This email is already registered.' });
    }

    // ── KEY VALIDATION: phone must belong to the selected shop ──
    const [phoneCheck] = await db.execute(
      'SELECT rp.*, rs.shop_name, rs.shop_code FROM registered_phones rp JOIN ration_shops rs ON rs.id = rp.shop_id WHERE rp.phone = ?',
      [phone]
    );

    if (phoneCheck.length === 0) {
      return res.status(400).json({
        message: 'This phone number is not registered in our ration database. Please contact your district office.'
      });
    }

    const phoneRecord = phoneCheck[0];

    // Phone must belong to the SELECTED shop
    if (parseInt(phoneRecord.shop_id) !== parseInt(shop_id)) {
      return res.status(400).json({
        message: `This phone number belongs to ${phoneRecord.shop_name} (${phoneRecord.shop_code}), not the selected shop. Please select the correct shop.`
      });
    }

    // Phone must not already be used for another account
    if (phoneRecord.is_used) {
      return res.status(409).json({
        message: 'This phone number is already linked to an existing account.'
      });
    }

    // Also check phone not already in users table
    const [userPhoneCheck] = await db.execute('SELECT id FROM users WHERE phone = ?', [phone]);
    if (userPhoneCheck.length > 0) {
      return res.status(409).json({ message: 'This phone number is already registered.' });
    }

    // All valid — generate OTP
    const otp     = generateOTP();
    const expires = new Date(Date.now() + (parseInt(process.env.OTP_EXPIRY_MINUTES) || 2) * 60 * 1000);

    // Delete any existing unused OTPs for this email
    await db.execute('DELETE FROM otp_verifications WHERE email = ?', [email]);

    // Store OTP in DB
    await db.execute(
      'INSERT INTO otp_verifications (email, otp, expires_at) VALUES (?, ?, ?)',
      [email, otp, expires]
    );

    // Send OTP email
    const sent = await sendOTPEmail(email, otp, name);
    if (!sent) {
      return res.status(500).json({ message: 'Failed to send OTP email. Check your email configuration.' });
    }

    // Return ration card from registered_phones
    res.json({
      message:      `Verification code sent to ${email}. It expires in 2 minutes.`,
      ration_card:  phoneRecord.ration_card,
      expires_in:   120  // seconds
    });

  } catch (err) {
    console.error('Send OTP error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ─── POST /api/auth/verify-otp ────────────────────────────
// Step 2: verify OTP and create the account
router.post('/verify-otp', async (req, res) => {
  try {
    const { name, email, phone, shop_id, district_id, age, address, pincode, password, otp } = req.body;

    if (!otp || !email) {
      return res.status(400).json({ message: 'OTP and email are required.' });
    }

    // Find OTP record
    const [otpRows] = await db.execute(
      'SELECT * FROM otp_verifications WHERE email = ? AND is_used = FALSE ORDER BY created_at DESC LIMIT 1',
      [email]
    );

    if (otpRows.length === 0) {
      return res.status(400).json({ message: 'No OTP found for this email. Please request a new one.' });
    }

    const otpRecord = otpRows[0];

    // Check expiry
    if (new Date() > new Date(otpRecord.expires_at)) {
      await db.execute('UPDATE otp_verifications SET is_used = TRUE WHERE id = ?', [otpRecord.id]);
      return res.status(400).json({ message: 'OTP has expired. Please request a new verification code.' });
    }

    // Check OTP match
    if (otpRecord.otp !== otp.toString().trim()) {
      return res.status(400).json({ message: 'Invalid OTP. Please check the code sent to your email.' });
    }

    // ── OTP is valid — create account ──
    // Get ration card from registered_phones
    const [phoneRow] = await db.execute(
      'SELECT ration_card FROM registered_phones WHERE phone = ? AND shop_id = ?',
      [phone, shop_id]
    );
    if (phoneRow.length === 0) {
      return res.status(400).json({ message: 'Phone/shop mismatch. Please restart registration.' });
    }

    const ration_card    = phoneRow[0].ration_card;
    const password_hash  = await bcrypt.hash(password, 10);

    // Insert user
    const [result] = await db.execute(
      `INSERT INTO users (name, email, ration_card, phone, address, pincode, district_id, shop_id, age, password_hash, role, is_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'citizen', TRUE)`,
      [name, email, ration_card, phone, address, pincode, district_id, shop_id, parseInt(age), password_hash]
    );

    // Mark OTP as used
    await db.execute('UPDATE otp_verifications SET is_used = TRUE WHERE id = ?', [otpRecord.id]);

    // Mark phone as used in registered_phones
    await db.execute('UPDATE registered_phones SET is_used = TRUE WHERE phone = ?', [phone]);

    // Send welcome notification
    await db.execute(
      "INSERT INTO notifications (user_id, message, type) VALUES (?, ?, 'general')",
      [result.insertId, `Welcome to the Ration Portal, ${name}! Your account is verified. Ration Card: ${ration_card}`]
    );

    const newUser = { id: result.insertId, email, role: 'citizen', name, shop_id };
    const token   = makeToken(newUser);

    res.status(201).json({
      message:     'Registration successful! Welcome to the Ration Portal.',
      token,
      user: {
        id: result.insertId, name, email, role: 'citizen',
        ration_card, phone, shop_id: parseInt(shop_id), district_id: parseInt(district_id)
      }
    });

  } catch (err) {
    console.error('Verify OTP error:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Account already exists with this email or phone.' });
    }
    res.status(500).json({ message: 'Server error during registration.' });
  }
});

// ─── POST /api/auth/login ─────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { identifier, password, role } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ message: 'Email/Ration Card and password are required.' });
    }

    const [users] = await db.execute(
      `SELECT u.*, d.name AS district_name, rs.shop_code, rs.shop_name
       FROM users u
       LEFT JOIN districts d ON d.id = u.district_id
       LEFT JOIN ration_shops rs ON rs.id = u.shop_id
       WHERE (u.email = ? OR u.ration_card = ?) AND u.role = ?`,
      [identifier, identifier, role || 'citizen']
    );

    if (users.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials or wrong role selected.' });
    }

    const user = users[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) return res.status(401).json({ message: 'Incorrect password.' });

    const token = makeToken(user);

    res.json({
      message: 'Login successful',
      token,
      user: {
        id:           user.id,
        name:         user.name,
        email:        user.email,
        role:         user.role,
        ration_card:  user.ration_card,
        phone:        user.phone,
        age:          user.age,
        address:      user.address,
        pincode:      user.pincode,
        district_id:  user.district_id,
        district_name:user.district_name,
        shop_id:      user.shop_id,
        shop_code:    user.shop_code,
        shop_name:    user.shop_name,
        card_type:    user.card_type
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error during login.' });
  }
});

module.exports = router;