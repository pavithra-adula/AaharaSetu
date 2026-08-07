// seed-admin.js
// ─────────────────────────────────────────────────────────────────────
// Creates 10 admin accounts — one per shop.
//
// Admin credentials pattern:
//   Shop 1  → admin1@gov.in  / Admin@1
//   Shop 2  → admin2@gov.in  / Admin@2
//   ...
//   Shop 10 → admin10@gov.in / Admin@10
//
// Run ONCE after `npm install`:
//   node seed-admin.js
// ─────────────────────────────────────────────────────────────────────

const bcrypt = require('bcryptjs');
const mysql  = require('mysql2/promise');
require('dotenv').config();

// ── Admin definitions (1 per shop, shops 1-10) ─────────────────────
// district_id and shop_id match the IDs in setup.sql:
//   Shop 1-2  → district 1 (Adilabad)
//   Shop 3-4  → district 2 (Hyderabad)
//   Shop 5-6  → district 3 (Mahboob Nagar)
//   Shop 7-8  → district 4 (Ranga Reddy)
//   Shop 9-10 → district 5 (Sangareddy)
const ADMINS = [
  { shop_id: 1,  district_id: 1, name: 'Admin Adilabad Shop 1',      email: 'admin1@gov.in',  password: 'Admin@1'  },
  { shop_id: 2,  district_id: 1, name: 'Admin Adilabad Shop 2',      email: 'admin2@gov.in',  password: 'Admin@2'  },
  { shop_id: 3,  district_id: 2, name: 'Admin Hyderabad Shop 1',     email: 'admin3@gov.in',  password: 'Admin@3'  },
  { shop_id: 4,  district_id: 2, name: 'Admin Hyderabad Shop 2',     email: 'admin4@gov.in',  password: 'Admin@4'  },
  { shop_id: 5,  district_id: 3, name: 'Admin Mahboob Nagar Shop 1', email: 'admin5@gov.in',  password: 'Admin@5'  },
  { shop_id: 6,  district_id: 3, name: 'Admin Mahboob Nagar Shop 2', email: 'admin6@gov.in',  password: 'Admin@6'  },
  { shop_id: 7,  district_id: 4, name: 'Admin Ranga Reddy Shop 1',   email: 'admin7@gov.in',  password: 'Admin@7'  },
  { shop_id: 8,  district_id: 4, name: 'Admin Ranga Reddy Shop 2',   email: 'admin8@gov.in',  password: 'Admin@8'  },
  { shop_id: 9,  district_id: 5, name: 'Admin Sangareddy Shop 1',    email: 'admin9@gov.in',  password: 'Admin@9'  },
  { shop_id: 10, district_id: 5, name: 'Admin Sangareddy Shop 2',    email: 'admin10@gov.in', password: 'Admin@10' },
];

async function seedAdmins() {
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST     || 'localhost',
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME     || 'ration_platform',
  });

  console.log('\n====================================================');
  console.log(' Ration Platform — Admin Seeder');
  console.log('====================================================');
  console.log('✅ Connected to database:', process.env.DB_NAME || 'ration_platform');
  console.log('');

  for (const admin of ADMINS) {
    // Delete stale record if exists
    await conn.execute('DELETE FROM users WHERE email = ?', [admin.email]);

    const hash = await bcrypt.hash(admin.password, 10);

    await conn.execute(
      `INSERT INTO users
         (name, email, phone, ration_card, district_id, shop_id,
          password_hash, role, is_verified)
       VALUES (?, ?, NULL, NULL, ?, ?, ?, 'admin', TRUE)`,
      [admin.name, admin.email, admin.district_id, admin.shop_id, hash]
    );

    console.log(`✅ Shop ${String(admin.shop_id).padStart(2, ' ')} | ${admin.email.padEnd(18)} | password: ${admin.password}`);
  }

  console.log('');
  console.log('====================================================');
  console.log(' All 10 admin accounts created successfully!');
  console.log('====================================================');
  console.log(' Login at: http://localhost:3000  →  🔒 Admin tab');
  console.log('====================================================\n');

  await conn.end();
}

seedAdmins().catch(err => {
  console.error('❌ Seed failed:', err.message);
  console.error('   Make sure .env has correct DB_HOST, DB_USER, DB_PASSWORD, DB_NAME');
  console.error('   And that you ran setup.sql first in MySQL Workbench.');
  process.exit(1);
});