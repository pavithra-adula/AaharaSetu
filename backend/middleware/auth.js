// middleware/auth.js
const jwt = require('jsonwebtoken');
require('dotenv').config();

function protect(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Access denied. No token provided.' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Invalid or expired token. Please login again.' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admins only.' });
  next();
}

function citizenOnly(req, res, next) {
  if (req.user.role !== 'citizen') return res.status(403).json({ message: 'Citizens only.' });
  next();
}

module.exports = { protect, adminOnly, citizenOnly };