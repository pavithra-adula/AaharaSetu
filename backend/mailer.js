// mailer.js — Sends OTP emails using Gmail
const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 10000
});

// Generate 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send OTP email
async function sendOTPEmail(toEmail, otp, userName) {
  const mailOptions = {
    from:    process.env.EMAIL_FROM,
    to:      toEmail,
    subject: 'Ration Portal — Email Verification Code',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
        <div style="background:#1a2744;padding:24px;text-align:center">
          <h2 style="color:#fff;margin:0;font-size:1.2rem">🌾 Ration Distribution Portal</h2>
          <p style="color:#94a3b8;margin:6px 0 0;font-size:.85rem">Government of Telangana</p>
        </div>
        <div style="padding:28px 32px">
          <p style="color:#1e293b;font-size:.95rem">Hello <b>${userName}</b>,</p>
          <p style="color:#64748b;font-size:.88rem;margin:12px 0">
            Use the verification code below to complete your registration.
            This code expires in <b>2 minutes</b>.
          </p>
          <div style="background:#eff6ff;border:2px dashed #2563eb;border-radius:10px;padding:20px;text-align:center;margin:20px 0">
            <div style="font-size:2.4rem;font-weight:700;letter-spacing:10px;color:#2563eb">${otp}</div>
          </div>
          <p style="color:#94a3b8;font-size:.78rem">
            If you did not request this, please ignore this email.
            Do not share this OTP with anyone.
          </p>
        </div>
        <div style="background:#f8fafc;padding:14px 32px;border-top:1px solid #e2e8f0;text-align:center">
          <p style="color:#94a3b8;font-size:.75rem;margin:0">
            Intelligent Digital Platform For Ration Distribution Services
          </p>
        </div>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ OTP email sent to ${toEmail}`);
    return true;
  } catch (err) {
    console.error('❌ Email send failed:', err.message);
    return false;
  }
}

module.exports = { generateOTP, sendOTPEmail };