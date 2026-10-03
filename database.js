import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.resolve(serverDirectory, '..', 'data');
export const databasePath = process.env.JANICE_DATABASE_PATH ? path.resolve(process.env.JANICE_DATABASE_PATH) : path.join(dataDirectory, 'janice.sqlite');
mkdirSync(path.dirname(databasePath), { recursive: true });
export const database = new DatabaseSync(databasePath);
database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
export function transaction(callback) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('tenant', 'admin')),
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    csrf_token TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS properties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    unit TEXT NOT NULL UNIQUE,
    neighborhood TEXT NOT NULL,
    city TEXT NOT NULL,
    country TEXT NOT NULL DEFAULT 'Kenya',
    monthly_rent INTEGER NOT NULL CHECK(monthly_rent >= 0),
    deposit INTEGER NOT NULL CHECK(deposit >= 0),
    bedrooms INTEGER NOT NULL CHECK(bedrooms >= 0),
    bathrooms INTEGER NOT NULL CHECK(bathrooms >= 0),
    area_m2 INTEGER NOT NULL CHECK(area_m2 > 0),
    status TEXT NOT NULL DEFAULT 'Available' CHECK(status IN ('Available', 'Booked', 'Maintenance')),
    description TEXT NOT NULL DEFAULT '',
    amenities TEXT NOT NULL DEFAULT '[]',
    photos TEXT NOT NULL DEFAULT '[]',
    image TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_ref TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    property_id INTEGER NOT NULL REFERENCES properties(id),
    tenant_name TEXT NOT NULL,
    tenant_email TEXT NOT NULL,
    phone TEXT NOT NULL,
    guest_count INTEGER NOT NULL CHECK(guest_count > 0),
    move_in_date TEXT NOT NULL,
    move_out_date TEXT NOT NULL,
    duration_months INTEGER NOT NULL CHECK(duration_months > 0),
    monthly_rent INTEGER NOT NULL,
    rent_amount INTEGER NOT NULL,
    deposit INTEGER NOT NULL,
    service_fee INTEGER NOT NULL,
    total INTEGER NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending', 'Approved', 'Confirmed', 'Rejected', 'Cancelled')),
    payment_status TEXT NOT NULL DEFAULT 'Unpaid' CHECK(payment_status IN ('Unpaid', 'Pending', 'Paid', 'Partially Paid', 'Overdue', 'Failed', 'Refunded')),
    paid_amount INTEGER NOT NULL DEFAULT 0,
    processed_by INTEGER REFERENCES users(id),
    processed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS bookings_property_dates_idx ON bookings(property_id, move_in_date, move_out_date, status);
  CREATE INDEX IF NOT EXISTS bookings_tenant_idx ON bookings(user_id, created_at);
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_no TEXT NOT NULL UNIQUE,
    booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    method TEXT NOT NULL,
    status TEXT NOT NULL,
    payment_date TEXT NOT NULL,
    recorded_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS payments_booking_idx ON payments(booking_id, payment_date);
  CREATE TABLE IF NOT EXISTS manual_payment_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL CHECK(amount > 0),
    receipt_no TEXT NOT NULL UNIQUE COLLATE NOCASE,
    sender_phone TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending', 'Approved', 'Rejected')),
    reviewed_by INTEGER REFERENCES users(id),
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS manual_payment_submissions_booking_idx ON manual_payment_submissions(booking_id, created_at);
  CREATE INDEX IF NOT EXISTS manual_payment_submissions_status_idx ON manual_payment_submissions(status, created_at);
  CREATE TABLE IF NOT EXISTS stk_pushes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL REFERENCES bookings(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    merchant_request_id TEXT,
    checkout_request_id TEXT UNIQUE,
    phone TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK(amount > 0),
    status TEXT NOT NULL DEFAULT 'Initiating' CHECK(status IN ('Initiating', 'Pending', 'Completed', 'Failed')),
    result_code INTEGER,
    result_description TEXT NOT NULL DEFAULT '',
    mpesa_receipt TEXT,
    callback_received_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS stk_pushes_booking_idx ON stk_pushes(booking_id, created_at);
  CREATE TABLE IF NOT EXISTS ledger_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
    entry_date TEXT NOT NULL,
    description TEXT NOT NULL,
    charge INTEGER NOT NULL DEFAULT 0,
    payment INTEGER NOT NULL DEFAULT 0,
    method TEXT NOT NULL DEFAULT '',
    receipt_no TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK(charge >= 0 AND payment >= 0)
  );
  CREATE INDEX IF NOT EXISTS ledger_tenant_date_idx ON ledger_entries(user_id, entry_date);
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const propertyCount = database.prepare('SELECT COUNT(*) AS count FROM properties').get().count;
if (propertyCount === 0) {
  const prices = [45000, 50000, 55000, 60000, 65000, 70000, 75000, 80000, 85000, 90000, 95000, 100000, 105000, 110000, 115000, 120000, 125000, 130000, 135000, 140000, 145000, 150000, 160000, 175000, 190000];
  const bedrooms = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3];
  const images = ['photo-1600607687939-ce8a6c25118c', 'photo-1600566753086-00f18fb6b3ea', 'photo-1600210491369-e753d80a41f3', 'photo-1600607687920-4e2a09cf159d', 'photo-1600566753190-17f0baa2a6c3'];
  const insert = database.prepare(`INSERT INTO properties (id, title, unit, neighborhood, city, monthly_rent, deposit, bedrooms, bathrooms, area_m2, status, description, amenities, image)
    VALUES (?, ?, ?, 'Kilimani', 'Nairobi', ?, ?, ?, ?, ?, 'Available', ?, ?, ?)`);
  transaction(() => {
    prices.forEach((price, index) => {
      const unit = String(index + 1).padStart(2, '0');
      const beds = bedrooms[index];
      const area = beds === 1 ? 42 + (index % 5) * 4 : beds === 2 ? 68 + (index % 5) * 5 : 98 + (index % 4) * 7;
      insert.run(index + 1, `Home ${unit} · ${beds}-bedroom apartment`, unit, price, price, beds, beds === 1 ? 1 : 2, area,
        `Home ${unit} is part of Janice Apartments, a 25-home community in Kilimani, Nairobi.`,
        JSON.stringify(['Parking', 'Water', 'Security', 'Kitchen']), images[index % images.length]);
    });
  });
}

database.prepare(`INSERT INTO settings (key, value) VALUES ('service_fee', '1000') ON CONFLICT(key) DO NOTHING`).run();

database.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
