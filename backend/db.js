// db.js
const mysql = require('mysql2');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,

  ssl: {
    rejectUnauthorized: false
  }
});

const db = pool.promise();

pool.getConnection((err, conn) => {
  if (err) { console.error('❌ DB connection failed:', err.message); return; }
  console.log('✅ MySQL connected to database:', process.env.DB_NAME);
  conn.release();
});

module.exports = db;