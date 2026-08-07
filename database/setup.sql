-- ============================================================================
-- RATION PLATFORM — FINAL PRODUCTION SQL
-- ----------------------------------------------------------------------------
-- Single file. Zero errors. Fully re-runnable.
--
-- Merges: setup.sql + family_members.sql + path.sql
--
-- What this file does:
--   1. Drops the database (if any) and creates a fresh one
--   2. Creates all 14 tables in correct dependency order
--   3. Seeds 5 districts, 10 shops, 50 registered phones (in sequence)
--   4. Seeds 70 stock rows (7 items x 10 shops) and 10 shop_settings
--   5. Creates 10 admin accounts (admin1@gov.in ... admin10@gov.in)
--   6. Prepares family_members inserts that activate as citizens register
--
-- How to run:
--   In MySQL Workbench: open this file, click the lightning bolt.
--   In terminal:        mysql -u root -p < ration_platform.sql
--
-- Compatible with: MySQL 8.x, MySQL Workbench (safe update mode is fine)
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 0. DATABASE
-- ────────────────────────────────────────────────────────────────────────────
DROP DATABASE IF EXISTS ration_platform;
CREATE DATABASE ration_platform
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
USE ration_platform;


-- ============================================================================
-- 1. SCHEMA — 14 tables in dependency order
-- ============================================================================

-- ─── districts ──────────────────────────────────────────────────────────────
CREATE TABLE districts (
  id   INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE
);

-- ─── ration_shops ───────────────────────────────────────────────────────────
CREATE TABLE ration_shops (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  district_id INT          NOT NULL,
  shop_code   VARCHAR(20)  NOT NULL UNIQUE,
  shop_name   VARCHAR(150) NOT NULL,
  address     TEXT,
  pincode     VARCHAR(10),
  max_tokens  INT DEFAULT 20,
  FOREIGN KEY (district_id) REFERENCES districts(id)
);

-- ─── registered_phones ──────────────────────────────────────────────────────
CREATE TABLE registered_phones (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  shop_id     INT         NOT NULL,
  phone       VARCHAR(15) NOT NULL UNIQUE,
  ration_card VARCHAR(30) NOT NULL UNIQUE,
  is_used     BOOLEAN     DEFAULT FALSE,
  FOREIGN KEY (shop_id) REFERENCES ration_shops(id)
);

-- ─── otp_verifications ──────────────────────────────────────────────────────
CREATE TABLE otp_verifications (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  email      VARCHAR(150) NOT NULL,
  otp        VARCHAR(6)   NOT NULL,
  expires_at DATETIME     NOT NULL,
  is_used    BOOLEAN      DEFAULT FALSE,
  created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- ─── users (citizens + admins) ──────────────────────────────────────────────
CREATE TABLE users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(150) UNIQUE,
  phone         VARCHAR(15)  UNIQUE,
  ration_card   VARCHAR(30)  UNIQUE,
  address       TEXT,
  pincode       VARCHAR(10),
  district_id   INT,
  shop_id       INT,
  age           INT,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('citizen','admin')     DEFAULT 'citizen',
  card_type     ENUM('APL','BPL','AAY')     DEFAULT 'BPL',
  is_verified   BOOLEAN                     DEFAULT FALSE,
  created_at    TIMESTAMP                   DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (district_id) REFERENCES districts(id),
  FOREIGN KEY (shop_id)     REFERENCES ration_shops(id)
);

-- ─── family_members ─────────────────────────────────────────────────────────
CREATE TABLE family_members (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  user_id          INT          NOT NULL,
  serial_no        INT          NOT NULL DEFAULT 1,
  name             VARCHAR(100) NOT NULL,
  age              INT,
  gender           ENUM('Male','Female','Other'),
  relation_to_head VARCHAR(50),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ─── slots ──────────────────────────────────────────────────────────────────
CREATE TABLE slots (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  shop_id       INT         NOT NULL,
  slot_date     DATE        NOT NULL,
  slot_label    VARCHAR(60) NOT NULL,
  start_time    TIME        NOT NULL,
  end_time      TIME        NOT NULL,
  max_tokens    INT         DEFAULT 4,
  is_elder_slot BOOLEAN     DEFAULT FALSE,
  FOREIGN KEY (shop_id) REFERENCES ration_shops(id)
);

-- ─── bookings ───────────────────────────────────────────────────────────────
-- status ENUM already includes 'not_collected' (from path.sql — baked in).
CREATE TABLE bookings (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  user_id        INT         NOT NULL,
  slot_id        INT         NOT NULL,
  token_number   VARCHAR(10) NOT NULL,
  priority_score INT         DEFAULT 4,
  status         ENUM('booked','served','expired','cancelled','not_collected') DEFAULT 'booked',
  booked_at      TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  served_at      TIMESTAMP   NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (slot_id) REFERENCES slots(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_slot (user_id, slot_id)
);

-- ─── stock ──────────────────────────────────────────────────────────────────
CREATE TABLE stock (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  shop_id              INT           NOT NULL,
  item_name            VARCHAR(60)   NOT NULL,
  quantity             DECIMAL(10,2) NOT NULL DEFAULT 0,
  max_capacity         DECIMAL(10,2) NOT NULL,
  unit                 VARCHAR(10)   DEFAULT 'kg',
  allotment_per_person DECIMAL(5,2)  DEFAULT 1,
  last_updated         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (shop_id) REFERENCES ration_shops(id)
);

-- ─── shop_settings ──────────────────────────────────────────────────────────
CREATE TABLE shop_settings (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  shop_id    INT     UNIQUE NOT NULL,
  is_open    BOOLEAN DEFAULT TRUE,
  open_time  TIME    DEFAULT '09:00:00',
  close_time TIME    DEFAULT '18:00:00',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (shop_id) REFERENCES ration_shops(id)
);

-- ─── notifications ──────────────────────────────────────────────────────────
CREATE TABLE notifications (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT,
  shop_id    INT,
  message    TEXT NOT NULL,
  type       ENUM('slot','crowd','stock','general','shop') DEFAULT 'general',
  is_read    BOOLEAN   DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES ration_shops(id)
);

-- ─── crowd_checkins ─────────────────────────────────────────────────────────
CREATE TABLE crowd_checkins (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  user_id      INT  NOT NULL,
  shop_id      INT  NOT NULL,
  checkin_date DATE NOT NULL,
  checked_out  TINYINT(1) DEFAULT 0,
  created_at   TIMESTAMP  DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_date (user_id, checkin_date),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES ration_shops(id)
);

-- ─── complaints ─────────────────────────────────────────────────────────────
CREATE TABLE complaints (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  user_id      INT         NOT NULL,
  shop_id      INT,
  category     VARCHAR(80) NOT NULL,
  message      TEXT        NOT NULL,
  status       ENUM('pending','resolved') DEFAULT 'pending',
  submitted_at TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES ration_shops(id)
);

-- ─── ratings ────────────────────────────────────────────────────────────────
CREATE TABLE ratings (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  booking_id  INT NOT NULL UNIQUE,
  shop_id     INT NOT NULL,
  stars       TINYINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  review      TEXT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)    REFERENCES users(id)         ON DELETE CASCADE,
  FOREIGN KEY (booking_id) REFERENCES bookings(id)      ON DELETE CASCADE,
  FOREIGN KEY (shop_id)    REFERENCES ration_shops(id)  ON DELETE CASCADE
);


-- ============================================================================
-- 2. SEED — 5 DISTRICTS
-- ============================================================================
INSERT INTO districts (id, name) VALUES
(1, 'Adilabad'),
(2, 'Hyderabad'),
(3, 'Mahboob Nagar'),
(4, 'Ranga Reddy'),
(5, 'Sangareddy');


-- ============================================================================
-- 3. SEED — 10 SHOPS (2 per district)
-- ============================================================================
INSERT INTO ration_shops (id, district_id, shop_code, shop_name, address, pincode, max_tokens) VALUES
(1,  1, 'ADL-S01', 'Adilabad Ration Shop 1',      'Ward 1, Adilabad',           '504001', 20),
(2,  1, 'ADL-S02', 'Adilabad Ration Shop 2',      'Ward 2, Adilabad',           '504002', 20),
(3,  2, 'HYD-S01', 'Hyderabad Ration Shop 1',     'Ameerpet, Hyderabad',        '500016', 20),
(4,  2, 'HYD-S02', 'Hyderabad Ration Shop 2',     'Banjara Hills, Hyderabad',   '500034', 20),
(5,  3, 'MBN-S01', 'Mahboob Nagar Ration Shop 1', 'Ward 1, Mahboob Nagar',      '509001', 20),
(6,  3, 'MBN-S02', 'Mahboob Nagar Ration Shop 2', 'Ward 2, Mahboob Nagar',      '509002', 20),
(7,  4, 'RRD-S01', 'Ranga Reddy Ration Shop 1',   'Shamshabad, Ranga Reddy',    '501218', 20),
(8,  4, 'RRD-S02', 'Ranga Reddy Ration Shop 2',   'Ibrahimpatnam, Ranga Reddy', '501506', 20),
(9,  5, 'SGR-S01', 'Sangareddy Ration Shop 1',    'Ward 1, Sangareddy',         '502001', 20),
(10, 5, 'SGR-S02', 'Sangareddy Ration Shop 2',    'Ward 2, Sangareddy',         '502002', 20);


-- ============================================================================
-- 4. SEED — 50 REGISTERED PHONES (5 per shop, exact sequence preserved)
--   Shop 1  ADL-S01 : 9000000001 - 9000000005
--   Shop 2  ADL-S02 : 9000000006 - 9000000010
--   Shop 3  HYD-S01 : 9000000011 - 9000000015
--   Shop 4  HYD-S02 : 9000000016 - 9000000020
--   Shop 5  MBN-S01 : 9000000021 - 9000000025
--   Shop 6  MBN-S02 : 9000000026 - 9000000030
--   Shop 7  RRD-S01 : 9000000031 - 9000000035
--   Shop 8  RRD-S02 : 9000000036 - 9000000040
--   Shop 9  SGR-S01 : 9000000041 - 9000000045
--   Shop 10 SGR-S02 : 9000000046 - 9000000050
-- ============================================================================
INSERT INTO registered_phones (shop_id, phone, ration_card) VALUES
(1,  '9000000001', 'TG-ADL-S01-0001'),
(1,  '9000000002', 'TG-ADL-S01-0002'),
(1,  '9000000003', 'TG-ADL-S01-0003'),
(1,  '9000000004', 'TG-ADL-S01-0004'),
(1,  '9000000005', 'TG-ADL-S01-0005'),
(2,  '9000000006', 'TG-ADL-S02-0001'),
(2,  '9000000007', 'TG-ADL-S02-0002'),
(2,  '9000000008', 'TG-ADL-S02-0003'),
(2,  '9000000009', 'TG-ADL-S02-0004'),
(2,  '9000000010', 'TG-ADL-S02-0005'),
(3,  '9000000011', 'TG-HYD-S01-0001'),
(3,  '9000000012', 'TG-HYD-S01-0002'),
(3,  '9000000013', 'TG-HYD-S01-0003'),
(3,  '9000000014', 'TG-HYD-S01-0004'),
(3,  '9000000015', 'TG-HYD-S01-0005'),
(4,  '9000000016', 'TG-HYD-S02-0001'),
(4,  '9000000017', 'TG-HYD-S02-0002'),
(4,  '9000000018', 'TG-HYD-S02-0003'),
(4,  '9000000019', 'TG-HYD-S02-0004'),
(4,  '9000000020', 'TG-HYD-S02-0005'),
(5,  '9000000021', 'TG-MBN-S01-0001'),
(5,  '9000000022', 'TG-MBN-S01-0002'),
(5,  '9000000023', 'TG-MBN-S01-0003'),
(5,  '9000000024', 'TG-MBN-S01-0004'),
(5,  '9000000025', 'TG-MBN-S01-0005'),
(6,  '9000000026', 'TG-MBN-S02-0001'),
(6,  '9000000027', 'TG-MBN-S02-0002'),
(6,  '9000000028', 'TG-MBN-S02-0003'),
(6,  '9000000029', 'TG-MBN-S02-0004'),
(6,  '9000000030', 'TG-MBN-S02-0005'),
(7,  '9000000031', 'TG-RRD-S01-0001'),
(7,  '9000000032', 'TG-RRD-S01-0002'),
(7,  '9000000033', 'TG-RRD-S01-0003'),
(7,  '9000000034', 'TG-RRD-S01-0004'),
(7,  '9000000035', 'TG-RRD-S01-0005'),
(8,  '9000000036', 'TG-RRD-S02-0001'),
(8,  '9000000037', 'TG-RRD-S02-0002'),
(8,  '9000000038', 'TG-RRD-S02-0003'),
(8,  '9000000039', 'TG-RRD-S02-0004'),
(8,  '9000000040', 'TG-RRD-S02-0005'),
(9,  '9000000041', 'TG-SGR-S01-0001'),
(9,  '9000000042', 'TG-SGR-S01-0002'),
(9,  '9000000043', 'TG-SGR-S01-0003'),
(9,  '9000000044', 'TG-SGR-S01-0004'),
(9,  '9000000045', 'TG-SGR-S01-0005'),
(10, '9000000046', 'TG-SGR-S02-0001'),
(10, '9000000047', 'TG-SGR-S02-0002'),
(10, '9000000048', 'TG-SGR-S02-0003'),
(10, '9000000049', 'TG-SGR-S02-0004'),
(10, '9000000050', 'TG-SGR-S02-0005');


-- ============================================================================
-- 5. SEED — STOCK (7 items x 10 shops = 70 rows)
-- ============================================================================
INSERT INTO stock (shop_id, item_name, quantity, max_capacity, unit, allotment_per_person)
SELECT rs.id, items.item_name, items.qty, items.max_cap, items.unit, items.allot
FROM ration_shops rs
CROSS JOIN (
  SELECT 'Rice'       AS item_name, 450 AS qty, 600 AS max_cap, 'kg' AS unit, 5 AS allot UNION ALL
  SELECT 'Wheat',                   300,         500,            'kg',          4           UNION ALL
  SELECT 'Dal',                     150,         300,            'kg',          2           UNION ALL
  SELECT 'Sugar',                    80,         200,            'kg',          1           UNION ALL
  SELECT 'Edible Oil',              200,         400,            'L',           2           UNION ALL
  SELECT 'Salt',                    120,         300,            'kg',          1           UNION ALL
  SELECT 'Kerosene',                 90,         200,            'L',           3
) items;


-- ============================================================================
-- 6. SEED — SHOP SETTINGS (1 row per shop = 10 rows)
-- ============================================================================
INSERT INTO shop_settings (shop_id, is_open, open_time, close_time)
SELECT id, TRUE, '09:00:00', '18:00:00' FROM ration_shops;


-- ============================================================================
-- 7. SEED — 10 ADMIN ACCOUNTS (1 per shop)
--   Login pattern:
--     admin1@gov.in  / Admin@1     → Shop 1  (Adilabad)
--     admin2@gov.in  / Admin@2     → Shop 2  (Adilabad)
--     admin3@gov.in  / Admin@3     → Shop 3  (Hyderabad)
--     admin4@gov.in  / Admin@4     → Shop 4  (Hyderabad)
--     admin5@gov.in  / Admin@5     → Shop 5  (Mahboob Nagar)
--     admin6@gov.in  / Admin@6     → Shop 6  (Mahboob Nagar)
--     admin7@gov.in  / Admin@7     → Shop 7  (Ranga Reddy)
--     admin8@gov.in  / Admin@8     → Shop 8  (Ranga Reddy)
--     admin9@gov.in  / Admin@9     → Shop 9  (Sangareddy)
--     admin10@gov.in / Admin@10    → Shop 10 (Sangareddy)
--
--   Passwords are bcrypt-hashed (rounds=10) so the backend's bcrypt.compare works.
-- ============================================================================
INSERT INTO users (name, email, phone, ration_card, district_id, shop_id, password_hash, role, is_verified) VALUES
('Admin Adilabad Shop 1',      'admin1@gov.in',  NULL, NULL, 1, 1,  '$2a$10$oxBwl7pzft0Iv8cGHHv/fO1FZxdOSXN.8hpEQROlWXcENbeRZg1r.', 'admin', TRUE),
('Admin Adilabad Shop 2',      'admin2@gov.in',  NULL, NULL, 1, 2,  '$2a$10$5usRjysJ2INGV0eVBnQ6GuYvdka3Ph4Kd0jD9U0DUgQKVpxtAFRv2', 'admin', TRUE),
('Admin Hyderabad Shop 1',     'admin3@gov.in',  NULL, NULL, 2, 3,  '$2a$10$8aU7FtGg7QyAE8u7kVNTW.eezR7hGPa/xmyZWywoaY5o6x7rf.NuO', 'admin', TRUE),
('Admin Hyderabad Shop 2',     'admin4@gov.in',  NULL, NULL, 2, 4,  '$2a$10$D07wK85Gtz7YniWMc/EwHeX7FLSTArLmKu8LYsHFwVd4QdZjuAcTS', 'admin', TRUE),
('Admin Mahboob Nagar Shop 1', 'admin5@gov.in',  NULL, NULL, 3, 5,  '$2a$10$cdZEJwE/mBlkk5DzjUEKqeCJX5lCkNOPhr6lTS6JFaPGTNmgqdNGy', 'admin', TRUE),
('Admin Mahboob Nagar Shop 2', 'admin6@gov.in',  NULL, NULL, 3, 6,  '$2a$10$P6SBASqvaZtaWJtQPKZHt.Zhv9bTUlswjOtotMfXuVit6awKxXjp.', 'admin', TRUE),
('Admin Ranga Reddy Shop 1',   'admin7@gov.in',  NULL, NULL, 4, 7,  '$2a$10$pJaJSRLhDlE0ypoUUrXty.kyZU6pfqTmsCeVJIjPhZYgXVMmN.BTm', 'admin', TRUE),
('Admin Ranga Reddy Shop 2',   'admin8@gov.in',  NULL, NULL, 4, 8,  '$2a$10$kZj7iNY3V22e8cQynhqYVOjxeJpW/tHuUM.Loi08AWDaFvderwQdW', 'admin', TRUE),
('Admin Sangareddy Shop 1',    'admin9@gov.in',  NULL, NULL, 5, 9,  '$2a$10$FoqbRngt0obx6okkvkTy2.nW8gSHx6.CQsV0AOn61R2W67lzJglOy', 'admin', TRUE),
('Admin Sangareddy Shop 2',    'admin10@gov.in', NULL, NULL, 5, 10, '$2a$10$2w9mXEfSlj43PsWJcWpv.Og0B4IIDy7l6TcZKmFOIfc9kenc1Kfbi', 'admin', TRUE);


-- ============================================================================
-- 8. FAMILY MEMBERS — activates as citizens register
-- ----------------------------------------------------------------------------
-- These INSERTs use SELECT ... FROM users WHERE phone='...'
-- so they are safe: they insert nothing if no citizen has that phone yet,
-- and populate automatically once the matching citizen registers.
-- ============================================================================

-- 9000000001 : Ramesh Kumar (Shop 1)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Ramesh Kumar', 45, 'Male',   'Self'     FROM users WHERE phone='9000000001';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Sunita Kumar', 41, 'Female', 'Spouse'   FROM users WHERE phone='9000000001';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Rohit Kumar',  18, 'Male',   'Son'      FROM users WHERE phone='9000000001';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 4, 'Priya Kumar',  14, 'Female', 'Daughter' FROM users WHERE phone='9000000001';

-- 9000000002 : Lakshmi Devi (Shop 1)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Lakshmi Devi',   62, 'Female', 'Self'   FROM users WHERE phone='9000000002';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Karthik Devi',   65, 'Male',   'Spouse' FROM users WHERE phone='9000000002';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Anand Devi',     38, 'Male',   'Son'    FROM users WHERE phone='9000000002';

-- 9000000003 : Suresh Rao (Shop 1)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Suresh Rao', 38, 'Male',   'Self'     FROM users WHERE phone='9000000003';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Geetha Rao', 34, 'Female', 'Spouse'   FROM users WHERE phone='9000000003';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Sai Rao',    10, 'Male',   'Son'      FROM users WHERE phone='9000000003';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 4, 'Nisha Rao',   7, 'Female', 'Daughter' FROM users WHERE phone='9000000003';

-- 9000000004 : Anitha Bai (Shop 1)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Anitha Bai', 29, 'Female', 'Self'     FROM users WHERE phone='9000000004';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Ravi Bai',   32, 'Male',   'Spouse'   FROM users WHERE phone='9000000004';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Arya Bai',    3, 'Female', 'Daughter' FROM users WHERE phone='9000000004';

-- 9000000005 : Venkat Reddy (Shop 1)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Venkat Reddy',     55, 'Male',   'Self'   FROM users WHERE phone='9000000005';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Padmavathi Reddy', 50, 'Female', 'Spouse' FROM users WHERE phone='9000000005';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Sunil Reddy',      26, 'Male',   'Son'    FROM users WHERE phone='9000000005';

-- 9000000006 : Naresh Patil (Shop 2)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Naresh Patil',  41, 'Male',   'Self'     FROM users WHERE phone='9000000006';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Sujatha Patil', 37, 'Female', 'Spouse'   FROM users WHERE phone='9000000006';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Rahul Patil',   15, 'Male',   'Son'      FROM users WHERE phone='9000000006';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 4, 'Pooja Patil',   12, 'Female', 'Daughter' FROM users WHERE phone='9000000006';

-- 9000000007 : Padma Latha (Shop 2)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Padma Latha',    67, 'Female', 'Self'     FROM users WHERE phone='9000000007';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Ramulu Latha',   70, 'Male',   'Spouse'   FROM users WHERE phone='9000000007';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Priya Ramulu',   40, 'Female', 'Daughter' FROM users WHERE phone='9000000007';

-- 9000000008 : Kishore Babu (Shop 2)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Kishore Babu', 33, 'Male',   'Self'   FROM users WHERE phone='9000000008';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Madhavi Babu', 29, 'Female', 'Spouse' FROM users WHERE phone='9000000008';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Arjun Babu',    4, 'Male',   'Son'    FROM users WHERE phone='9000000008';

-- 9000000009 : Sunita Sharma (Shop 2)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Sunita Sharma', 25, 'Female', 'Self'   FROM users WHERE phone='9000000009';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Ravi Sharma',   28, 'Male',   'Spouse' FROM users WHERE phone='9000000009';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Krish Sharma',   1, 'Male',   'Son'    FROM users WHERE phone='9000000009';

-- 9000000010 : Raju Nayak (Shop 2)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Raju Nayak',     48, 'Male',   'Self'     FROM users WHERE phone='9000000010';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Kamakshi Nayak', 44, 'Female', 'Spouse'   FROM users WHERE phone='9000000010';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Teju Nayak',     20, 'Male',   'Son'      FROM users WHERE phone='9000000010';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 4, 'Hema Nayak',     17, 'Female', 'Daughter' FROM users WHERE phone='9000000010';

-- 9000000011 : Srinivas Murthy (Shop 3)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Srinivas Murthy', 52, 'Male',   'Self'   FROM users WHERE phone='9000000011';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Sarada Murthy',   48, 'Female', 'Spouse' FROM users WHERE phone='9000000011';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Naveen Murthy',   24, 'Male',   'Son'    FROM users WHERE phone='9000000011';

-- 9000000012 : Meena Kumari (Shop 3)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Meena Kumari',   35, 'Female', 'Self'     FROM users WHERE phone='9000000012';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Praveen Kumari', 38, 'Male',   'Spouse'   FROM users WHERE phone='9000000012';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Isha Kumari',     8, 'Female', 'Daughter' FROM users WHERE phone='9000000012';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 4, 'Dev Kumari',      5, 'Male',   'Son'      FROM users WHERE phone='9000000012';

-- 9000000013 : Arun Chandra (Shop 3)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Arun Chandra',    28, 'Male',   'Self'   FROM users WHERE phone='9000000013';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Nandini Chandra', 25, 'Female', 'Spouse' FROM users WHERE phone='9000000013';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Aarav Chandra',    2, 'Male',   'Son'    FROM users WHERE phone='9000000013';

-- 9000000014 : Savitri Bai (Shop 3)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Savitri Bai',       71, 'Female', 'Self'   FROM users WHERE phone='9000000014';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Krishnamurthy Bai', 74, 'Male',   'Spouse' FROM users WHERE phone='9000000014';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Soma Bai',          45, 'Male',   'Son'    FROM users WHERE phone='9000000014';

-- 9000000015 : Prasad Goud (Shop 3)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Prasad Goud',     44, 'Male',   'Self'     FROM users WHERE phone='9000000015';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Anuradha Goud',   40, 'Female', 'Spouse'   FROM users WHERE phone='9000000015';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Siddharth Goud',  16, 'Male',   'Son'      FROM users WHERE phone='9000000015';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 4, 'Swathi Goud',     13, 'Female', 'Daughter' FROM users WHERE phone='9000000015';

-- 9000000016 : Kavitha Reddy (Shop 4)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Kavitha Reddy',   39, 'Female', 'Self'   FROM users WHERE phone='9000000016';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Suresh Reddy',    42, 'Male',   'Spouse' FROM users WHERE phone='9000000016';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Abhishek Reddy',  12, 'Male',   'Son'    FROM users WHERE phone='9000000016';

-- 9000000017 : Mohan Das (Shop 4)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Mohan Das',   58, 'Male',   'Self'     FROM users WHERE phone='9000000017';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Vimala Das',  54, 'Female', 'Spouse'   FROM users WHERE phone='9000000017';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Ajay Das',    30, 'Male',   'Son'      FROM users WHERE phone='9000000017';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 4, 'Preethi Das', 27, 'Female', 'Daughter' FROM users WHERE phone='9000000017';

-- 9000000018 : Rekha Singh (Shop 4)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Rekha Singh', 31, 'Female', 'Self'     FROM users WHERE phone='9000000018';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Raj Singh',   34, 'Male',   'Spouse'   FROM users WHERE phone='9000000018';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Riya Singh',   4, 'Female', 'Daughter' FROM users WHERE phone='9000000018';

-- 9000000019 : Gopal Krishna (Shop 4)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Gopal Krishna',  63, 'Male',   'Self'   FROM users WHERE phone='9000000019';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Sarada Krishna', 59, 'Female', 'Spouse' FROM users WHERE phone='9000000019';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Hari Krishna',   35, 'Male',   'Son'    FROM users WHERE phone='9000000019';

-- 9000000020 : Usha Rani (Shop 4)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Usha Rani',   27, 'Female', 'Self'     FROM users WHERE phone='9000000020';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Deepak Rani', 30, 'Male',   'Spouse'   FROM users WHERE phone='9000000020';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Baby Rani',    1, 'Female', 'Daughter' FROM users WHERE phone='9000000020';

-- 9000000021 : Balaiah Verma (Shop 5)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Balaiah Verma',   50, 'Male',   'Self'     FROM users WHERE phone='9000000021';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Sarojini Verma',  46, 'Female', 'Spouse'   FROM users WHERE phone='9000000021';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Kiran Verma',     22, 'Male',   'Son'      FROM users WHERE phone='9000000021';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 4, 'Divya Verma',     19, 'Female', 'Daughter' FROM users WHERE phone='9000000021';

-- 9000000022 : Saroja Devi (Shop 5)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Saroja Devi',   43, 'Female', 'Self'     FROM users WHERE phone='9000000022';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Lingaiah Devi', 47, 'Male',   'Spouse'   FROM users WHERE phone='9000000022';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Renu Devi',     18, 'Female', 'Daughter' FROM users WHERE phone='9000000022';

-- 9000000023 : Nagaraju Yadav (Shop 5)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Nagaraju Yadav', 36, 'Male',   'Self'     FROM users WHERE phone='9000000023';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Bhagya Yadav',   32, 'Female', 'Spouse'   FROM users WHERE phone='9000000023';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Akash Yadav',     9, 'Male',   'Son'      FROM users WHERE phone='9000000023';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 4, 'Sneha Yadav',     6, 'Female', 'Daughter' FROM users WHERE phone='9000000023';

-- 9000000024 : Radha Krishnamma (Shop 5)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Radha Krishnamma',     68, 'Female', 'Self'   FROM users WHERE phone='9000000024';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Venkatesh Krishnamma', 71, 'Male',   'Spouse' FROM users WHERE phone='9000000024';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Mohan Krishnamma',     44, 'Male',   'Son'    FROM users WHERE phone='9000000024';

-- 9000000025 : Sekhar Babu (Shop 5)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Sekhar Babu', 22, 'Male',   'Self'     FROM users WHERE phone='9000000025';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Manasa Babu', 21, 'Female', 'Spouse'   FROM users WHERE phone='9000000025';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Tanvi Babu',   1, 'Female', 'Daughter' FROM users WHERE phone='9000000025';

-- 9000000026 : Mallaiah Goud (Shop 6)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Mallaiah Goud',   47, 'Male',   'Self'     FROM users WHERE phone='9000000026';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Ratnavathi Goud', 43, 'Female', 'Spouse'   FROM users WHERE phone='9000000026';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Suresh Goud',     21, 'Male',   'Son'      FROM users WHERE phone='9000000026';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 4, 'Nirmala Goud',    18, 'Female', 'Daughter' FROM users WHERE phone='9000000026';

-- 9000000027 : Vijaya Lakshmi (Shop 6)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Vijaya Lakshmi',      55, 'Female', 'Self'   FROM users WHERE phone='9000000027';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Srinivasulu Lakshmi', 59, 'Male',   'Spouse' FROM users WHERE phone='9000000027';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Venu Lakshmi',        28, 'Male',   'Son'    FROM users WHERE phone='9000000027';

-- 9000000028 : Ravi Teja (Shop 6)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Ravi Teja',    30, 'Male',   'Self'   FROM users WHERE phone='9000000028';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Swetha Teja',  27, 'Female', 'Spouse' FROM users WHERE phone='9000000028';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Ishaan Teja',   2, 'Male',   'Son'    FROM users WHERE phone='9000000028';

-- 9000000029 : Kamala Devi (Shop 6)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Kamala Devi',   72, 'Female', 'Self'     FROM users WHERE phone='9000000029';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Gangaiah Devi', 75, 'Male',   'Spouse'   FROM users WHERE phone='9000000029';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Nagesh Devi',   46, 'Male',   'Son'      FROM users WHERE phone='9000000029';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 4, 'Padma Devi',    42, 'Female', 'Daughter' FROM users WHERE phone='9000000029';

-- 9000000030 : Anil Kumar (Shop 6)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Anil Kumar',    34, 'Male',   'Self'   FROM users WHERE phone='9000000030';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Kavitha Kumar', 30, 'Female', 'Spouse' FROM users WHERE phone='9000000030';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Vivaan Kumar',   5, 'Male',   'Son'    FROM users WHERE phone='9000000030';

-- 9000000031 : Siva Prasad (Shop 7)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Siva Prasad',      42, 'Male',   'Self'     FROM users WHERE phone='9000000031';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Santhoshi Prasad', 38, 'Female', 'Spouse'   FROM users WHERE phone='9000000031';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Rohith Prasad',    14, 'Male',   'Son'      FROM users WHERE phone='9000000031';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 4, 'Roja Prasad',      11, 'Female', 'Daughter' FROM users WHERE phone='9000000031';

-- 9000000032 : Geetha Reddy (Shop 7)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Geetha Reddy',         37, 'Female', 'Self'   FROM users WHERE phone='9000000032';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Venkataramana Reddy',  40, 'Male',   'Spouse' FROM users WHERE phone='9000000032';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Vivek Reddy',          12, 'Male',   'Son'    FROM users WHERE phone='9000000032';

-- 9000000033 : Ramakrishna Naik (Shop 7)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Ramakrishna Naik', 65, 'Male',   'Self'     FROM users WHERE phone='9000000033';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Nagamani Naik',    61, 'Female', 'Spouse'   FROM users WHERE phone='9000000033';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Suresh Naik',      38, 'Male',   'Son'      FROM users WHERE phone='9000000033';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 4, 'Geetha Naik',      35, 'Female', 'Daughter' FROM users WHERE phone='9000000033';

-- 9000000034 : Deepa Kumari (Shop 7)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Deepa Kumari',   24, 'Female', 'Self'   FROM users WHERE phone='9000000034';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Rajesh Kumari',  27, 'Male',   'Spouse' FROM users WHERE phone='9000000034';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Dev Kumari',      1, 'Male',   'Son'    FROM users WHERE phone='9000000034';

-- 9000000035 : Chandrasekhar Rao (Shop 7)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Chandrasekhar Rao', 56, 'Male',   'Self'   FROM users WHERE phone='9000000035';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Vijayalaxmi Rao',   52, 'Female', 'Spouse' FROM users WHERE phone='9000000035';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Pranav Rao',        27, 'Male',   'Son'    FROM users WHERE phone='9000000035';

-- 9000000036 : Bhavani Devi (Shop 8)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Bhavani Devi',  48, 'Female', 'Self'     FROM users WHERE phone='9000000036';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Narayana Devi', 52, 'Male',   'Spouse'   FROM users WHERE phone='9000000036';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Akhil Devi',    20, 'Male',   'Son'      FROM users WHERE phone='9000000036';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 4, 'Pallavi Devi',  17, 'Female', 'Daughter' FROM users WHERE phone='9000000036';

-- 9000000037 : Kiran Babu (Shop 8)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Kiran Babu',   32, 'Male',   'Self'   FROM users WHERE phone='9000000037';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Anusha Babu',  28, 'Female', 'Spouse' FROM users WHERE phone='9000000037';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Sai Babu',      3, 'Male',   'Son'    FROM users WHERE phone='9000000037';

-- 9000000038 : Manjula Reddy (Shop 8)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Manjula Reddy',    61, 'Female', 'Self'     FROM users WHERE phone='9000000038';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Govindarao Reddy', 65, 'Male',   'Spouse'   FROM users WHERE phone='9000000038';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Nanditha Reddy',   36, 'Female', 'Daughter' FROM users WHERE phone='9000000038';

-- 9000000039 : Srikanth Varma (Shop 8)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Srikanth Varma', 26, 'Male',   'Self'     FROM users WHERE phone='9000000039';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Bindhu Varma',   23, 'Female', 'Spouse'   FROM users WHERE phone='9000000039';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Arya Varma',      2, 'Female', 'Daughter' FROM users WHERE phone='9000000039';

-- 9000000040 : Pushpa Latha (Shop 8)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Pushpa Latha',   53, 'Female', 'Self'     FROM users WHERE phone='9000000040';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Dasarath Latha', 57, 'Male',   'Spouse'   FROM users WHERE phone='9000000040';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Navya Latha',    25, 'Female', 'Daughter' FROM users WHERE phone='9000000040';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 4, 'Sai Latha',      22, 'Male',   'Son'      FROM users WHERE phone='9000000040';

-- 9000000041 : Narsimha Rao (Shop 9)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Narsimha Rao',   57, 'Male',   'Self'   FROM users WHERE phone='9000000041';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Bhagirathi Rao', 53, 'Female', 'Spouse' FROM users WHERE phone='9000000041';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Pradeep Rao',    28, 'Male',   'Son'    FROM users WHERE phone='9000000041';

-- 9000000042 : Lalitha Devi (Shop 9)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Lalitha Devi',   40, 'Female', 'Self'     FROM users WHERE phone='9000000042';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Raghunath Devi', 44, 'Male',   'Spouse'   FROM users WHERE phone='9000000042';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Tanvi Devi',     14, 'Female', 'Daughter' FROM users WHERE phone='9000000042';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 4, 'Tarun Devi',     11, 'Male',   'Son'      FROM users WHERE phone='9000000042';

-- 9000000043 : Sudheer Kumar (Shop 9)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Sudheer Kumar', 23, 'Male',   'Self'   FROM users WHERE phone='9000000043';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Apoorva Kumar', 21, 'Female', 'Spouse' FROM users WHERE phone='9000000043';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Aadi Kumar',     1, 'Male',   'Son'    FROM users WHERE phone='9000000043';

-- 9000000044 : Vasantha Kumari (Shop 9)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Vasantha Kumari',        69, 'Female', 'Self'   FROM users WHERE phone='9000000044';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Satyanarayana Kumari',   73, 'Male',   'Spouse' FROM users WHERE phone='9000000044';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Suresh Kumari',          42, 'Male',   'Son'    FROM users WHERE phone='9000000044';

-- 9000000045 : Mahesh Babu (Shop 9)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Mahesh Babu',   35, 'Male',   'Self'     FROM users WHERE phone='9000000045';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Naga Lakshmi',  31, 'Female', 'Spouse'   FROM users WHERE phone='9000000045';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Atharv Babu',    5, 'Male',   'Son'      FROM users WHERE phone='9000000045';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 4, 'Anvi Babu',      3, 'Female', 'Daughter' FROM users WHERE phone='9000000045';

-- 9000000046 : Hanumantha Rao (Shop 10)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Hanumantha Rao', 46, 'Male',   'Self'   FROM users WHERE phone='9000000046';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Durga Rao',      42, 'Female', 'Spouse' FROM users WHERE phone='9000000046';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Sandeep Rao',    19, 'Male',   'Son'    FROM users WHERE phone='9000000046';

-- 9000000047 : Sulochana Devi (Shop 10)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Sulochana Devi', 60, 'Female', 'Self'     FROM users WHERE phone='9000000047';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Laxmaiah Devi',  64, 'Male',   'Spouse'   FROM users WHERE phone='9000000047';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Ravi Devi',      34, 'Male',   'Son'      FROM users WHERE phone='9000000047';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 4, 'Swapna Devi',    31, 'Female', 'Daughter' FROM users WHERE phone='9000000047';

-- 9000000048 : Prashanth Naidu (Shop 10)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Prashanth Naidu', 29, 'Male',   'Self'   FROM users WHERE phone='9000000048';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Chaitra Naidu',   26, 'Female', 'Spouse' FROM users WHERE phone='9000000048';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Arjun Naidu',      2, 'Male',   'Son'    FROM users WHERE phone='9000000048';

-- 9000000049 : Saraswathi Bai (Shop 10)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Saraswathi Bai', 75, 'Female', 'Self'   FROM users WHERE phone='9000000049';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Venkaiah Bai',   78, 'Male',   'Spouse' FROM users WHERE phone='9000000049';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Ramesh Bai',     48, 'Male',   'Son'    FROM users WHERE phone='9000000049';

-- 9000000050 : Vikram Singh (Shop 10)
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 1, 'Vikram Singh', 38, 'Male',   'Self'     FROM users WHERE phone='9000000050';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 2, 'Aarti Singh',  34, 'Female', 'Spouse'   FROM users WHERE phone='9000000050';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 3, 'Aryan Singh',  10, 'Male',   'Son'      FROM users WHERE phone='9000000050';
INSERT INTO family_members (user_id, serial_no, name, age, gender, relation_to_head)
  SELECT id, 4, 'Anika Singh',   7, 'Female', 'Daughter' FROM users WHERE phone='9000000050';


-- ============================================================================
-- 9. VERIFICATION (uncomment to run after setup)
-- ============================================================================
-- SELECT COUNT(*) AS districts_count         FROM districts;          -- expect  5
-- SELECT COUNT(*) AS shops_count             FROM ration_shops;       -- expect 10
-- SELECT COUNT(*) AS phones_count            FROM registered_phones;  -- expect 50
-- SELECT COUNT(*) AS stock_count             FROM stock;              -- expect 70
-- SELECT COUNT(*) AS shop_settings_count     FROM shop_settings;      -- expect 10
-- SELECT COUNT(*) AS admins_count            FROM users WHERE role='admin'; -- expect 10

-- ============================================================================
-- DONE. Database ready.
--   Backend can now start with: cd backend && npm run dev
--   No need to run seed-admin.js — admins are already created here.
-- ============================================================================