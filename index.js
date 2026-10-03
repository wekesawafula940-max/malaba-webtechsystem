import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { database, databasePath, transaction } from './database.js';
import { initiateStkPush, verifyStkCallback } from './daraja.js';
import {
  adminOnly,
  createSession,
  destroySession,
  emailIsValid,
  getSession,
  hashPassword,
  publicUser,
  requireAuth,
  requireCsrf,
  tenantOnly,
  verifyPassword,
  writeAdmin,
  writeTenant
} from './auth.js';

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(serverDirectory, '..');
const uploadsDirectory = path.resolve(process.env.UPLOADS_DIRECTORY || path.join(rootDirectory, 'uploads'));
mkdirSync(uploadsDirectory, { recursive: true });

app.get('/',(req, res) => {
  res.send('API is running');
};

const app = express();
const port = Number(process.env.PORT) || 3000;
const requiresAdminSetupKey = process.env.NODE_ENV === 'production' || Boolean(process.env.ADMIN_SETUP_KEY);
const serviceFee = () => Number(database.prepare("SELECT value FROM settings WHERE key = 'service_fee'").get()?.value || 0);
const publicProperty = (row) => row && ({
  id: row.id,
  title: row.title,
  unit: row.unit,
  neighborhood: row.neighborhood,
  city: row.city,
  state: row.country,
  price: row.monthly_rent,
  deposit: row.deposit,
  beds: row.bedrooms,
  baths: row.bathrooms,
  area: row.area_m2,
  status: row.status,
  description: row.description,
  amenities: JSON.parse(row.amenities || '[]'),
  photos: JSON.parse(row.photos || '[]'),
  image: row.image
});
const publicBooking = (row) => row && ({
  id: row.booking_ref,
  bookingId: row.id,
  userId: row.user_id,
  accountEmail: row.tenant_email,
  tenantEmail: row.tenant_email,
  tenantName: row.tenant_name,
  phone: row.phone,
  guestCount: row.guest_count,
  unitId: row.property_id,
  unitTitle: row.unit_title,
  moveInDate: formatDate(row.move_in_date),
  moveOutDate: formatDate(row.move_out_date),
  durationMonths: row.duration_months,
  rent: row.monthly_rent,
  rentAmount: row.rent_amount,
  deposit: row.deposit,
  serviceFee: row.service_fee,
  total: row.total,
  paidAmount: row.paid_amount,
  message: row.message,
  status: row.status,
  paymentStatus: row.payment_status,
  processedBy: row.processed_by_name || null,
  processedAt: row.processed_at,
  createdOn: formatDate(row.created_at.slice(0, 10))
});
const bookingSelect = `SELECT b.*, p.title AS unit_title, COALESCE(admin.name, '') AS processed_by_name
  FROM bookings b JOIN properties p ON p.id = b.property_id LEFT JOIN users admin ON admin.id = b.processed_by`;
const cleanUser = (user) => ({ id: user.id, name: user.name, email: user.email, role: user.role });

function parseDate(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^([0-9]{2})\/([0-9]{2})\/([0-9]{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  return `${year}-${month}-${day}`;
}

function formatDate(value) {
  if (!value) return '';
  const [year, month, day] = value.slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

function durationMonths(moveIn, moveOut) {
  const [startYear, startMonth, startDay] = moveIn.split('-').map(Number);
  const [endYear, endMonth, endDay] = moveOut.split('-').map(Number);
  const months = (endYear - startYear) * 12 + endMonth - startMonth + (endDay > startDay ? 1 : 0);
  return Math.max(1, months);
}

function validateNewUser(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (name.length < 2 || name.length > 100) return { error: 'Enter a name between 2 and 100 characters.' };
  if (!emailIsValid(email)) return { error: 'Enter a valid email address.' };
  if (password.length < 10 || password.length > 200) return { error: 'Password must be at least 10 characters.' };
  return { name, email, password };
}

function parsePropertyBody(body) {
  const title = String(body.title || '').trim();
  const neighborhood = String(body.neighborhood || '').trim();
  const city = String(body.city || 'Nairobi').trim();
  const price = Number(body.price);
  const deposit = Number(body.deposit);
  const beds = Number(body.beds);
  const baths = Number(body.baths);
  const area = Number(body.area);
  const status = String(body.status || 'Available');
  if (!title || title.length > 120 || !neighborhood || neighborhood.length > 100 || !city || city.length > 100) return { error: 'Property name and location are required.' };
  if (![price, deposit, beds, baths, area].every(Number.isFinite) || price < 0 || deposit < 0 || beds < 0 || baths < 0 || area <= 0) return { error: 'Enter valid rent, deposit, room counts, and area.' };
  if (!['Available', 'Booked', 'Maintenance'].includes(status)) return { error: 'Select a valid availability status.' };
  let amenities = body.amenities || [];
  if (typeof amenities === 'string') amenities = [amenities];
  if (!Array.isArray(amenities) || amenities.length > 20 || amenities.some((amenity) => typeof amenity !== 'string' || amenity.length > 50)) return { error: 'Invalid amenities list.' };
  return { title, neighborhood, city, price, deposit, beds, baths, area, status, amenities, description: String(body.description || '').trim().slice(0, 3000) };
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, uploadsDirectory),
    filename: (_request, file, callback) => {
      const extension = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/avif': '.avif' })[file.mimetype];
      if (!extension) return callback(new Error('Only JPEG, PNG, WebP, and AVIF images are allowed.'));
      callback(null, `${randomBytes(20).toString('hex')}${extension}`);
    }
  }),
  limits: { files: 4, fileSize: 4 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => callback(null, /^image\/(jpeg|png|webp|avif)$/.test(file.mimetype))
});

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'https://images.unsplash.com', 'data:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com']
    }
  }
}));
app.use(express.json({ limit: '256kb' }));
app.use('/uploads', express.static(uploadsDirectory, { dotfiles: 'deny', index: false, maxAge: '1d' }));
app.get('/', (_request, response) => response.sendFile(path.join(rootDirectory, 'index.html')));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many attempts. Wait a few minutes and try again.' } });
const setupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many setup attempts.' } });
const stkLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many M-Pesa prompts. Wait a few minutes and try again.' } });
const manualPaymentLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many payment submissions. Wait a few minutes and try again.' } });
const callbackLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Callback rate limit reached.' } });
const tenantCount = database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'tenant'");

app.get('/api/health', (_request, response) => response.json({ status: 'ok', database: path.basename(databasePath) }));
app.get('/api/admin/setup', (_request, response) => {
  const count = database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count;
  response.json({ needsSetup: count === 0, requiresSetupKey: requiresAdminSetupKey });
});

app.post('/api/admin/setup', setupLimiter, async (request, response, next) => {
  try {
    const adminCount = database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count;
    if (adminCount !== 0) return response.status(409).json({ error: 'Administrator setup is already complete. Sign in instead.' });
    if (requiresAdminSetupKey && (!process.env.ADMIN_SETUP_KEY || request.get('x-admin-setup-key') !== process.env.ADMIN_SETUP_KEY)) return response.status(403).json({ error: 'A valid one-time administrator setup key is required.' });
    if (!requiresAdminSetupKey && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) return response.status(403).json({ error: 'Initial administrator setup is available only from the local machine.' });
    const input = validateNewUser(request.body || {});
    if (input.error) return response.status(400).json({ error: input.error });
    const credentials = await hashPassword(input.password);
    const user = transaction(() => {
      if (database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count !== 0) throw Object.assign(new Error('Administrator setup is already complete.'), { status: 409 });
      const result = database.prepare("INSERT INTO users (email, name, role, password_salt, password_hash) VALUES (?, ?, 'admin', ?, ?)").run(input.email, input.name, credentials.salt, credentials.hash);
      return database.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(result.lastInsertRowid);
    });
    const csrfToken = createSession(user.id, response);
    response.status(201).json({ user: cleanUser(user), csrfToken });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return response.status(409).json({ error: 'An account with this email already exists.' });
    next(error);
  }
});

app.post('/api/auth/register', authLimiter, async (request, response, next) => {
  try {
    const input = validateNewUser(request.body || {});
    if (input.error) return response.status(400).json({ error: input.error });
    const credentials = await hashPassword(input.password);
    const result = database.prepare("INSERT INTO users (email, name, role, password_salt, password_hash) VALUES (?, ?, 'tenant', ?, ?)").run(input.email, input.name, credentials.salt, credentials.hash);
    const user = database.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(result.lastInsertRowid);
    const csrfToken = createSession(user.id, response);
    response.status(201).json({ user: cleanUser(user), csrfToken });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return response.status(409).json({ error: 'An account with this email already exists.' });
    next(error);
  }
});

app.post('/api/auth/login', authLimiter, async (request, response) => {
  const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  const password = typeof request.body?.password === 'string' ? request.body.password : '';
  const user = database.prepare('SELECT id, email, name, role, password_salt, password_hash FROM users WHERE email = ? COLLATE NOCASE').get(email);
  if (!user || !await verifyPassword(password, user.password_salt, user.password_hash)) return response.status(401).json({ error: 'Email or password is incorrect.' });
  const csrfToken = createSession(user.id, response);
  response.json({ user: cleanUser(user), csrfToken });
});

app.get('/api/auth/session', (request, response) => response.json(getSession(request) || { user: null, csrfToken: null }));
app.post('/api/auth/logout', requireAuth, requireCsrf, (request, response) => {
  destroySession(request, response);
  response.status(204).end();
});

app.get('/api/properties', (request, response) => {
  const rows = database.prepare("SELECT * FROM properties WHERE status = 'Available' ORDER BY id").all();
  const location = String(request.query.location || '').trim().toLowerCase();
  const maxPrice = Number(request.query.maxPrice) || Infinity;
  const minBeds = Number(request.query.minBeds) || 0;
  response.json(rows.map(publicProperty).filter((property) => {
    const searchable = `${property.neighborhood} ${property.city} ${property.state}`.toLowerCase();
    return (!location || searchable.includes(location)) && property.price <= maxPrice && property.beds >= minBeds;
  }));
});

app.get('/api/settings', (_request, response) => response.json({ serviceFee: serviceFee() }));

app.get('/api/bookings', tenantOnly, (request, response) => {
  const rows = database.prepare(`${bookingSelect} WHERE b.user_id = ? ORDER BY b.created_at DESC`).all(request.auth.user.id);
  response.json(rows.map((row) => {
    const submission = database.prepare(`SELECT amount, receipt_no, sender_phone, status, created_at
      FROM manual_payment_submissions WHERE booking_id = ? ORDER BY id DESC LIMIT 1`).get(row.id);
    return {
      ...publicBooking(row),
      paymentSubmission: submission ? {
        amount: submission.amount,
        receipt: submission.receipt_no,
        senderPhone: submission.sender_phone,
        status: submission.status,
        submittedAt: formatDate(submission.created_at.slice(0, 10))
      } : null
    };
  }));
});

app.post('/api/bookings', writeTenant, (request, response) => {
  const body = request.body || {};
  const propertyId = Number(body.unitId);
  const propertyRow = database.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId);
  if (!propertyRow || propertyRow.status !== 'Available') return response.status(409).json({ error: 'This home is no longer available.' });
  const moveIn = parseDate(body.moveInDate);
  const moveOut = parseDate(body.moveOutDate);
  const guestCount = Number(body.guestCount);
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const tenantName = typeof body.tenantName === 'string' ? body.tenantName.trim() : '';
  const tenantEmail = typeof body.tenantEmail === 'string' ? body.tenantEmail.trim().toLowerCase() : request.auth.user.email;
  if (!moveIn || !moveOut || moveOut <= moveIn) return response.status(400).json({ error: 'Enter valid DD/MM/YYYY dates; move-out must be after move-in.' });
  if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 20) return response.status(400).json({ error: 'Guest count must be between 1 and 20.' });
  if (!tenantName || tenantName.length > 100 || !emailIsValid(tenantEmail)) return response.status(400).json({ error: 'Enter a valid tenant name and email.' });
  if (!/^\+?[0-9][0-9 ()-]{7,19}$/.test(phone)) return response.status(400).json({ error: 'Enter a valid phone number.' });
  const months = durationMonths(moveIn, moveOut);
  const rentAmount = propertyRow.monthly_rent * months;
  const serviceFeeValue = serviceFee();
  const total = rentAmount + propertyRow.deposit + serviceFeeValue;
  const reference = `JAR-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
  const createBooking = () => transaction(() => {
    const conflict = database.prepare(`SELECT 1 FROM bookings WHERE property_id = ? AND status = 'Confirmed'
      AND move_in_date < ? AND move_out_date > ? LIMIT 1`).get(propertyId, moveOut, moveIn);
    if (conflict) throw Object.assign(new Error('This home is booked for part of those dates.'), { status: 409 });
    const result = database.prepare(`INSERT INTO bookings (booking_ref, user_id, property_id, tenant_name, tenant_email, phone, guest_count, move_in_date, move_out_date, duration_months, monthly_rent, rent_amount, deposit, service_fee, total, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(reference, request.auth.user.id, propertyId, tenantName, tenantEmail, phone, guestCount, moveIn, moveOut, months, propertyRow.monthly_rent, rentAmount, propertyRow.deposit, serviceFeeValue, total, String(body.message || '').trim().slice(0, 2000));
    const bookingId = Number(result.lastInsertRowid);
    const addLedger = database.prepare('INSERT INTO ledger_entries (user_id, booking_id, entry_date, description, charge, created_by) VALUES (?, ?, ?, ?, ?, ?)');
    addLedger.run(request.auth.user.id, bookingId, moveIn, `${propertyRow.title} rent (${months} month(s))`, rentAmount, request.auth.user.id);
    addLedger.run(request.auth.user.id, bookingId, moveIn, `${propertyRow.title} security deposit`, propertyRow.deposit, request.auth.user.id);
    addLedger.run(request.auth.user.id, bookingId, moveIn, `${propertyRow.title} service fee`, serviceFeeValue, request.auth.user.id);
    return database.prepare(`${bookingSelect} WHERE b.id = ?`).get(bookingId);
  });
  try {
    const booking = createBooking();
    response.status(201).json(publicBooking(booking));
  } catch (error) {
    if (error.status) return response.status(error.status).json({ error: error.message });
    response.status(500).json({ error: 'Unable to create booking request.' });
  }
});

app.post('/api/bookings/:reference/payments/manual', writeTenant, manualPaymentLimiter, (request, response) => {
  const booking = database.prepare('SELECT * FROM bookings WHERE booking_ref = ? AND user_id = ?').get(request.params.reference, request.auth.user.id);
  if (!booking) return response.status(404).json({ error: 'Booking not found.' });
  if (['Cancelled', 'Rejected'].includes(booking.status)) return response.status(409).json({ error: 'This booking cannot accept a payment.' });
  const amount = Number(request.body?.amount);
  const receipt = typeof request.body?.receipt === 'string' ? request.body.receipt.trim().toUpperCase() : '';
  const senderPhone = typeof request.body?.senderPhone === 'string' ? request.body.senderPhone.trim() : '';
  const outstanding = booking.total - booking.paid_amount;
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > outstanding) return response.status(400).json({ error: `Enter an amount from KSh 1 up to the outstanding balance of KSh ${Math.max(0, outstanding)}.` });
  if (!/^[A-Z0-9]{3,32}$/.test(receipt)) return response.status(400).json({ error: 'Enter a valid M-Pesa transaction code.' });
  if (senderPhone && !/^\+?[0-9][0-9 ()-]{7,19}$/.test(senderPhone)) return response.status(400).json({ error: 'Enter a valid sender phone number or leave it blank.' });
  if (database.prepare("SELECT 1 FROM manual_payment_submissions WHERE booking_id = ? AND status = 'Pending'").get(booking.id)) {
    return response.status(409).json({ error: 'You already have a payment waiting for admin review.' });
  }
  if (database.prepare('SELECT 1 FROM payments WHERE lower(receipt_no) = lower(?)').get(receipt)) return response.status(409).json({ error: 'This M-Pesa transaction code has already been recorded.' });
  try {
    const result = database.prepare(`INSERT INTO manual_payment_submissions (booking_id, user_id, amount, receipt_no, sender_phone)
      VALUES (?, ?, ?, ?, ?)`).run(booking.id, request.auth.user.id, amount, receipt, senderPhone);
    response.status(201).json({ id: Number(result.lastInsertRowid), status: 'Pending', amount, receipt });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return response.status(409).json({ error: 'This M-Pesa transaction code has already been submitted.' });
    throw error;
  }
});

app.post('/api/bookings/:reference/payments/stk', writeTenant, stkLimiter, async (request, response) => {
  const booking = database.prepare('SELECT * FROM bookings WHERE booking_ref = ? AND user_id = ?').get(request.params.reference, request.auth.user.id);
  if (!booking) return response.status(404).json({ error: 'Booking not found.' });
  if (['Cancelled', 'Rejected'].includes(booking.status)) return response.status(409).json({ error: 'This booking cannot accept a payment.' });
  const outstanding = booking.total - booking.paid_amount;
  if (outstanding <= 0 || booking.payment_status === 'Paid') return response.status(409).json({ error: 'This booking is already fully paid.' });

  const pendingAttempt = database.prepare(`SELECT id, status, checkout_request_id FROM stk_pushes
    WHERE booking_id = ? AND status IN ('Initiating', 'Pending') ORDER BY id DESC LIMIT 1`).get(booking.id);
  if (pendingAttempt) return response.status(409).json({ error: 'An M-Pesa request is already in progress for this booking.', status: pendingAttempt.status, checkoutRequestId: pendingAttempt.checkout_request_id });

  let attemptId;
  try {
    const initiationId = `INIT-${randomBytes(16).toString('hex')}`;
    attemptId = Number(database.prepare(`INSERT INTO stk_pushes (booking_id, user_id, merchant_request_id, checkout_request_id, phone, amount, status)
      VALUES (?, ?, ?, ?, ?, ?, 'Pending')`).run(booking.id, request.auth.user.id, initiationId, initiationId, request.body?.phone || booking.phone, outstanding).lastInsertRowid);
    const push = await initiateStkPush({
      phone: request.body?.phone || booking.phone,
      amount: outstanding,
      accountReference: 'test',
      description: 'test'
    });
    database.prepare(`UPDATE stk_pushes SET merchant_request_id = ?, checkout_request_id = ?, phone = ?, status = 'Pending'
      WHERE id = ?`).run(push.merchantRequestId, push.checkoutRequestId, push.phone, attemptId);
    database.prepare("UPDATE bookings SET payment_status = 'Pending' WHERE id = ? AND paid_amount = 0").run(booking.id);
    response.status(202).json({ status: 'Pending', checkoutRequestId: push.checkoutRequestId, amount: outstanding, phone: push.phone, message: push.customerMessage });
  } catch (error) {
    if (attemptId) database.prepare("UPDATE stk_pushes SET status = 'Failed', result_description = ? WHERE id = ?").run(String(error.message || 'STK Push failed').slice(0, 250), attemptId);
    response.status(error.status || 502).json({ error: error.message || 'Could not start M-Pesa payment.' });
  }
});

app.get('/api/bookings/:reference/payment-status', tenantOnly, (request, response) => {
  const booking = database.prepare('SELECT id, payment_status, paid_amount, total FROM bookings WHERE booking_ref = ? AND user_id = ?').get(request.params.reference, request.auth.user.id);
  if (!booking) return response.status(404).json({ error: 'Booking not found.' });
  const attempt = database.prepare(`SELECT status, amount, phone, result_code, result_description, mpesa_receipt, created_at
    FROM stk_pushes WHERE booking_id = ? ORDER BY id DESC LIMIT 1`).get(booking.id);
  response.json({
    paymentStatus: booking.payment_status,
    paidAmount: booking.paid_amount,
    outstanding: Math.max(0, booking.total - booking.paid_amount),
    attempt: attempt ? { status: attempt.status, amount: attempt.amount, phone: attempt.phone, resultCode: attempt.result_code, message: attempt.result_description, receipt: attempt.mpesa_receipt, createdAt: attempt.created_at } : null
  });
});

app.post('/api/payments/daraja/callback', callbackLimiter, async (request, response) => {
  const callback = request.body?.Body?.stkCallback;
  const checkoutId = callback?.CheckoutRequestID;
  if (!checkoutId || !Number.isInteger(Number(callback?.ResultCode))) return response.status(400).json({ ResultCode: 1, ResultDesc: 'Invalid callback payload.' });
  const attempt = database.prepare('SELECT * FROM stk_pushes WHERE checkout_request_id = ?').get(String(checkoutId));
  if (!attempt) return response.status(200).json({ ResultCode: 0, ResultDesc: 'Callback acknowledged.' });
  if (String(callback.MerchantRequestID || '') !== attempt.merchant_request_id) return response.status(409).json({ ResultCode: 1, ResultDesc: 'Callback merchant request did not match.' });
  if (['Completed', 'Failed'].includes(attempt.status)) return response.status(200).json({ ResultCode: 0, ResultDesc: 'Callback already processed.' });

  const resultCode = Number(callback.ResultCode);
  try {
    if (!await verifyStkCallback(String(checkoutId), resultCode)) return response.status(409).json({ ResultCode: 1, ResultDesc: 'Callback result did not match Safaricom transaction status.' });
  } catch (error) {
    return response.status(503).json({ ResultCode: 1, ResultDesc: error.message || 'Safaricom callback verification is temporarily unavailable.' });
  }
  const metadata = callback.CallbackMetadata?.Item || [];
  const metadataValue = (name) => metadata.find((item) => item.Name === name)?.Value;
  const callbackAmount = Number(metadataValue('Amount'));
  const receipt = String(metadataValue('MpesaReceiptNumber') || '').trim();
  const callbackPhone = String(metadataValue('PhoneNumber') || '');
  try {
    transaction(() => {
      const currentAttempt = database.prepare('SELECT * FROM stk_pushes WHERE id = ?').get(attempt.id);
      if (currentAttempt.status !== 'Pending') return;
      const booking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(attempt.booking_id);
      if (resultCode === 0 && Number.isSafeInteger(callbackAmount) && callbackAmount === attempt.amount && callbackAmount <= booking.total - booking.paid_amount && receipt) {
        const paidAmount = booking.paid_amount + callbackAmount;
        const paymentStatus = paidAmount >= booking.total ? 'Paid' : 'Partially Paid';
        const paymentDate = new Date().toISOString().slice(0, 10);
        database.prepare(`UPDATE stk_pushes SET status = 'Completed', result_code = 0, result_description = ?, mpesa_receipt = ?, callback_received_at = datetime('now') WHERE id = ?`)
          .run(String(callback.ResultDesc || 'Payment received').slice(0, 250), receipt, attempt.id);
        database.prepare('UPDATE bookings SET paid_amount = ?, payment_status = ? WHERE id = ?').run(paidAmount, paymentStatus, booking.id);
        database.prepare(`INSERT INTO payments (receipt_no, booking_id, amount, method, status, payment_date)
          VALUES (?, ?, ?, 'M-Pesa', 'Paid', ?)`).run(receipt, booking.id, callbackAmount, paymentDate);
        database.prepare(`INSERT INTO ledger_entries (user_id, booking_id, entry_date, description, payment, method, receipt_no)
          VALUES (?, ?, ?, ?, ?, 'M-Pesa', ?)`).run(booking.user_id, booking.id, paymentDate, `M-Pesa payment${callbackPhone ? ` from ${callbackPhone}` : ''}`, callbackAmount, receipt);
      } else {
        const description = resultCode === 0 ? 'Safaricom payment amount, receipt, or outstanding balance did not match the request.' : String(callback.ResultDesc || 'M-Pesa payment was not completed.');
        database.prepare(`UPDATE stk_pushes SET status = 'Failed', result_code = ?, result_description = ?, callback_received_at = datetime('now') WHERE id = ?`)
          .run(resultCode, description.slice(0, 250), attempt.id);
        if (booking.paid_amount === 0) database.prepare("UPDATE bookings SET payment_status = 'Failed' WHERE id = ?").run(booking.id);
      }
    });
  } catch (error) {
    if (error.code !== 'SQLITE_CONSTRAINT_UNIQUE') console.error('Daraja callback processing failed:', error.message);
  }
  response.status(200).json({ ResultCode: 0, ResultDesc: 'Callback acknowledged.' });
});

app.get('/api/admin/overview', ...adminOnly, (_request, response) => {
  const homes = database.prepare("SELECT COUNT(*) AS count, SUM(status = 'Available') AS available, SUM(status = 'Booked') AS booked FROM properties").get();
  const bookings = database.prepare("SELECT COUNT(*) AS count, SUM(status = 'Pending') AS pending FROM bookings").get();
  const tenants = tenantCount.get().count;
  const payments = database.prepare('SELECT COALESCE(SUM(amount), 0) AS collected FROM payments WHERE amount > 0').get().collected;
  response.json({ properties: homes.count, available: homes.available || 0, booked: homes.booked || 0, bookings: bookings.count, pendingBookings: bookings.pending || 0, tenants, paymentsCollected: payments });
});

app.get('/api/admin/bootstrap', ...adminOnly, (_request, response) => {
  const properties = database.prepare('SELECT * FROM properties ORDER BY id').all().map(publicProperty);
  const bookings = database.prepare(`${bookingSelect} ORDER BY b.created_at DESC`).all().map(publicBooking);
  const tenants = database.prepare(`SELECT id, name, email, created_at FROM users WHERE role = 'tenant' ORDER BY created_at DESC`).all().map((tenant) => ({
    ...tenant,
    bookings: bookings.filter((booking) => booking.userId === tenant.id)
  }));
  const payments = database.prepare(`SELECT p.*, b.booking_ref, b.tenant_name, b.tenant_email, b.property_id, pr.title AS unit_title
    FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN properties pr ON pr.id = b.property_id ORDER BY p.id DESC`).all().map((payment) => ({
    id: payment.id,
    bookingId: payment.booking_ref,
    receipt: payment.receipt_no,
    amount: payment.amount,
    method: payment.method,
    status: payment.status,
    date: formatDate(payment.payment_date),
    isoDate: payment.payment_date
  }));
  const paymentSubmissions = database.prepare(`SELECT s.id, s.booking_id, s.amount, s.receipt_no, s.sender_phone, s.status, s.created_at,
      b.booking_ref, b.tenant_name, b.tenant_email, pr.title AS unit_title
    FROM manual_payment_submissions s JOIN bookings b ON b.id = s.booking_id
    JOIN properties pr ON pr.id = b.property_id ORDER BY s.id DESC`).all().map((submission) => ({
    id: submission.id,
    bookingId: submission.booking_ref,
    amount: submission.amount,
    receipt: submission.receipt_no,
    senderPhone: submission.sender_phone,
    status: submission.status,
    submittedAt: formatDate(submission.created_at.slice(0, 10)),
    tenantName: submission.tenant_name,
    tenantEmail: submission.tenant_email,
    unitTitle: submission.unit_title
  }));
  const ledger = database.prepare(`SELECT l.*, u.email, b.booking_ref FROM ledger_entries l
    JOIN users u ON u.id = l.user_id LEFT JOIN bookings b ON b.id = l.booking_id ORDER BY l.entry_date, l.id`).all().map((entry) => ({
    id: entry.id,
    email: entry.email,
    date: entry.entry_date,
    description: entry.description,
    charge: entry.charge,
    payment: entry.payment,
    method: entry.method,
    receipt: entry.receipt_no,
    bookingId: entry.booking_ref
  }));
  const admins = database.prepare('SELECT id, name, email, created_at FROM users WHERE role = \'admin\' ORDER BY id').all();
  response.json({ properties, bookings, tenants, payments, paymentSubmissions, ledger, admins, settings: { serviceFee: serviceFee() } });
});

app.get('/api/admin/properties', ...adminOnly, (_request, response) => {
  response.json(database.prepare('SELECT * FROM properties ORDER BY id').all().map(publicProperty));
});

app.post('/api/admin/properties', ...writeAdmin, upload.array('photos', 4), (request, response) => {
  const input = parsePropertyBody(request.body || {});
  if (input.error) return response.status(400).json({ error: input.error });
  const nextId = Number(database.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM properties').get().id);
  const unit = String(nextId).padStart(2, '0');
  const photos = (request.files || []).map((file) => `/uploads/${file.filename}`);
  const image = `photo-1600607687939-ce8a6c25118c`;
  const result = database.prepare(`INSERT INTO properties (title, unit, neighborhood, city, monthly_rent, deposit, bedrooms, bathrooms, area_m2, status, description, amenities, photos, image)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.title, unit, input.neighborhood, input.city, input.price, input.deposit, input.beds, input.baths, input.area, input.status, input.description, JSON.stringify(input.amenities), JSON.stringify(photos), image);
  response.status(201).json(publicProperty(database.prepare('SELECT * FROM properties WHERE id = ?').get(result.lastInsertRowid)));
});

app.put('/api/admin/properties/:id', ...writeAdmin, upload.array('photos', 4), (request, response) => {
  const id = Number(request.params.id);
  const current = database.prepare('SELECT * FROM properties WHERE id = ?').get(id);
  if (!current) return response.status(404).json({ error: 'Home not found.' });
  const input = parsePropertyBody(request.body || {});
  if (input.error) return response.status(400).json({ error: input.error });
  const photos = request.files?.length ? request.files.map((file) => `/uploads/${file.filename}`) : JSON.parse(current.photos || '[]');
  database.prepare(`UPDATE properties SET title = ?, neighborhood = ?, city = ?, monthly_rent = ?, deposit = ?, bedrooms = ?, bathrooms = ?, area_m2 = ?, status = ?, description = ?, amenities = ?, photos = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(input.title, input.neighborhood, input.city, input.price, input.deposit, input.beds, input.baths, input.area, input.status, input.description, JSON.stringify(input.amenities), JSON.stringify(photos), id);
  response.json(publicProperty(database.prepare('SELECT * FROM properties WHERE id = ?').get(id)));
});

app.delete('/api/admin/properties/:id', ...writeAdmin, (request, response) => {
  const id = Number(request.params.id);
  const property = database.prepare('SELECT id FROM properties WHERE id = ?').get(id);
  if (!property) return response.status(404).json({ error: 'Home not found.' });
  const hasBookings = database.prepare('SELECT 1 FROM bookings WHERE property_id = ? LIMIT 1').get(id);
  if (hasBookings) return response.status(409).json({ error: 'This home has booking history. Mark it Maintenance instead so records remain intact.' });
  database.prepare('DELETE FROM properties WHERE id = ?').run(id);
  response.status(204).end();
});

app.get('/api/admin/bookings', ...adminOnly, (request, response) => {
  const status = String(request.query.status || 'All');
  const rows = status === 'All'
    ? database.prepare(`${bookingSelect} ORDER BY b.created_at DESC`).all()
    : database.prepare(`${bookingSelect} WHERE b.status = ? ORDER BY b.created_at DESC`).all(status);
  response.json(rows.map(publicBooking));
});

app.patch('/api/admin/bookings/:reference', ...writeAdmin, (request, response) => {
  const status = String(request.body?.status || '');
  if (!['Pending', 'Approved', 'Confirmed', 'Rejected', 'Cancelled'].includes(status)) return response.status(400).json({ error: 'Invalid booking status.' });
  const booking = database.prepare(`${bookingSelect} WHERE b.booking_ref = ?`).get(request.params.reference);
  if (!booking) return response.status(404).json({ error: 'Booking not found.' });
  const update = () => transaction(() => {
    if (status === 'Confirmed') {
      const conflict = database.prepare(`SELECT 1 FROM bookings WHERE property_id = ? AND booking_ref != ? AND status = 'Confirmed'
        AND move_in_date < ? AND move_out_date > ? LIMIT 1`).get(booking.property_id, booking.booking_ref, booking.move_out_date, booking.move_in_date);
      if (conflict) throw Object.assign(new Error('Another confirmed booking overlaps this date range.'), { status: 409 });
      database.prepare("UPDATE properties SET status = 'Booked', updated_at = datetime('now') WHERE id = ?").run(booking.property_id);
    } else if (booking.status === 'Confirmed' && status !== 'Confirmed') {
      database.prepare(`UPDATE properties SET status = CASE
        WHEN status = 'Maintenance' THEN 'Maintenance'
        WHEN EXISTS (SELECT 1 FROM bookings WHERE property_id = ? AND booking_ref != ? AND status = 'Confirmed') THEN 'Booked'
        ELSE 'Available' END, updated_at = datetime('now') WHERE id = ?`)
        .run(booking.property_id, booking.booking_ref, booking.property_id);
    }
    database.prepare('UPDATE bookings SET status = ?, processed_by = ?, processed_at = datetime(\'now\') WHERE booking_ref = ?').run(status, request.auth.user.id, booking.booking_ref);
    return database.prepare(`${bookingSelect} WHERE b.booking_ref = ?`).get(booking.booking_ref);
  });
  try {
    response.json(publicBooking(update()));
  } catch (error) {
    response.status(error.status || 500).json({ error: error.message || 'Unable to update booking.' });
  }
});

app.get('/api/admin/tenants', ...adminOnly, (_request, response) => {
  const rows = database.prepare(`SELECT u.id, u.name, u.email, COUNT(b.id) AS booking_count,
      MAX(b.tenant_name) AS tenant_name, MAX(b.phone) AS phone, MAX(b.monthly_rent) AS monthly_rent,
      MAX(b.payment_status) AS payment_status, MAX(b.property_id) AS property_id
    FROM users u LEFT JOIN bookings b ON b.user_id = u.id WHERE u.role = 'tenant'
    GROUP BY u.id ORDER BY u.created_at DESC`).all();
  response.json(rows);
});

app.get('/api/admin/payments', ...adminOnly, (_request, response) => {
  const rows = database.prepare(`SELECT p.*, b.booking_ref, b.total, b.tenant_name, b.tenant_email, b.property_id, pr.title AS unit_title
    FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN properties pr ON pr.id = b.property_id ORDER BY p.id DESC`).all();
  const bookings = database.prepare(`${bookingSelect} ORDER BY b.created_at DESC`).all().map(publicBooking);
  response.json({ payments: rows, bookings });
});

app.post('/api/admin/payments', ...writeAdmin, (request, response) => {
  const booking = database.prepare('SELECT * FROM bookings WHERE booking_ref = ?').get(String(request.body?.bookingId || ''));
  if (!booking) return response.status(404).json({ error: 'Booking not found.' });
  const targetAmount = Number(request.body?.amount);
  const status = String(request.body?.status || '');
  const method = String(request.body?.method || '').trim().slice(0, 80) || 'Manual entry';
  const statuses = ['Unpaid', 'Pending', 'Paid', 'Partially Paid', 'Overdue', 'Failed', 'Refunded'];
  if (!Number.isInteger(targetAmount) || targetAmount < 0 || targetAmount > booking.total) return response.status(400).json({ error: 'Enter a valid amount up to the total due.' });
  if (!statuses.includes(status)) return response.status(400).json({ error: 'Select a valid payment status.' });
  const previousAmount = booking.paid_amount;
  let paidAmount = targetAmount;
  if (status === 'Paid') paidAmount = booking.total;
  if (['Unpaid', 'Pending', 'Overdue', 'Failed'].includes(status)) paidAmount = previousAmount;
  if (status === 'Refunded') paidAmount = 0;
  const finalStatus = status === 'Paid' && paidAmount < booking.total ? 'Partially Paid' : status;
  const difference = paidAmount - previousAmount;
  const savePayment = () => transaction(() => {
    database.prepare('UPDATE bookings SET paid_amount = ?, payment_status = ? WHERE id = ?').run(paidAmount, finalStatus, booking.id);
    let receipt = null;
    if (difference !== 0) {
      receipt = `REC-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
      const date = new Date().toISOString().slice(0, 10);
      database.prepare('INSERT INTO payments (receipt_no, booking_id, amount, method, status, payment_date, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(receipt, booking.id, difference, method, finalStatus, date, request.auth.user.id);
      database.prepare('INSERT INTO ledger_entries (user_id, booking_id, entry_date, description, charge, payment, method, receipt_no, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(booking.user_id, booking.id, date, difference < 0 ? `Refund for ${booking.booking_ref}` : `Payment for ${booking.booking_ref}`, difference < 0 ? Math.abs(difference) : 0, difference > 0 ? difference : 0, method, receipt, request.auth.user.id);
    }
    return { booking: database.prepare(`${bookingSelect} WHERE b.id = ?`).get(booking.id), receipt };
  });
  const result = savePayment();
  response.status(201).json({ booking: publicBooking(result.booking), receipt: result.receipt });
});

app.post('/api/admin/payment-submissions/:id/review', ...writeAdmin, (request, response) => {
  const submissionId = Number(request.params.id);
  const decision = String(request.body?.status || '');
  if (!Number.isSafeInteger(submissionId) || submissionId < 1 || !['Approved', 'Rejected'].includes(decision)) {
    return response.status(400).json({ error: 'Choose whether to approve or reject this payment submission.' });
  }
  try {
    const result = transaction(() => {
      const submission = database.prepare('SELECT * FROM manual_payment_submissions WHERE id = ?').get(submissionId);
      if (!submission) throw Object.assign(new Error('Payment submission not found.'), { status: 404 });
      if (submission.status !== 'Pending') throw Object.assign(new Error('This payment submission has already been reviewed.'), { status: 409 });
      if (decision === 'Rejected') {
        database.prepare("UPDATE manual_payment_submissions SET status = 'Rejected', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
          .run(request.auth.user.id, submissionId);
        return { status: 'Rejected' };
      }
      const booking = database.prepare('SELECT * FROM bookings WHERE id = ?').get(submission.booking_id);
      if (!booking || submission.amount > booking.total - booking.paid_amount) {
        throw Object.assign(new Error('The submitted amount is now greater than the outstanding balance. Review the booking balance before recording payment.'), { status: 409 });
      }
      if (database.prepare('SELECT 1 FROM payments WHERE lower(receipt_no) = lower(?)').get(submission.receipt_no)) {
        throw Object.assign(new Error('This M-Pesa transaction code has already been recorded.'), { status: 409 });
      }
      const paidAmount = booking.paid_amount + submission.amount;
      const paymentStatus = paidAmount >= booking.total ? 'Paid' : 'Partially Paid';
      const date = new Date().toISOString().slice(0, 10);
      database.prepare(`INSERT INTO payments (receipt_no, booking_id, amount, method, status, payment_date, recorded_by)
        VALUES (?, ?, ?, 'M-Pesa manual', 'Paid', ?, ?)`).run(submission.receipt_no, booking.id, submission.amount, date, request.auth.user.id);
      database.prepare('UPDATE bookings SET paid_amount = ?, payment_status = ? WHERE id = ?').run(paidAmount, paymentStatus, booking.id);
      database.prepare(`INSERT INTO ledger_entries (user_id, booking_id, entry_date, description, payment, method, receipt_no, created_by)
        VALUES (?, ?, ?, ?, ?, 'M-Pesa manual', ?, ?)`).run(booking.user_id, booking.id, date, `Verified M-Pesa payment${submission.sender_phone ? ` from ${submission.sender_phone}` : ''}`, submission.amount, submission.receipt_no, request.auth.user.id);
      database.prepare("UPDATE manual_payment_submissions SET status = 'Approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
        .run(request.auth.user.id, submissionId);
      return { status: 'Approved', paymentStatus, paidAmount };
    });
    response.json(result);
  } catch (error) {
    if (error.status) return response.status(error.status).json({ error: error.message });
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return response.status(409).json({ error: 'This M-Pesa transaction code has already been recorded.' });
    throw error;
  }
});

app.get('/api/admin/ledger', ...adminOnly, (request, response) => {
  const userId = Number(request.query.userId);
  if (!Number.isInteger(userId) || userId < 1) return response.status(400).json({ error: 'Select a tenant.' });
  const entries = database.prepare(`SELECT l.*, b.booking_ref, p.title AS property_title FROM ledger_entries l
    LEFT JOIN bookings b ON b.id = l.booking_id LEFT JOIN properties p ON p.id = b.property_id
    WHERE l.user_id = ? ORDER BY l.entry_date, l.id`).all(userId);
  response.json(entries);
});

app.post('/api/admin/ledger', ...writeAdmin, (request, response) => {
  const userId = Number(request.body?.userId);
  const date = parseDate(request.body?.date);
  const description = String(request.body?.description || '').trim();
  const charge = Number(request.body?.charge) || 0;
  const payment = Number(request.body?.payment) || 0;
  const method = String(request.body?.method || '').trim().slice(0, 80);
  if (!database.prepare("SELECT id FROM users WHERE id = ? AND role = 'tenant'").get(userId)) return response.status(404).json({ error: 'Tenant not found.' });
  if (!date || !description || description.length > 250 || charge < 0 || payment < 0 || (!charge && !payment)) return response.status(400).json({ error: 'Enter a date, description, and a charge or payment amount.' });
  const receipt = payment ? `REC-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}` : '';
  const result = database.prepare('INSERT INTO ledger_entries (user_id, entry_date, description, charge, payment, method, receipt_no, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(userId, date, description, charge, payment, method, receipt, request.auth.user.id);
  response.status(201).json(database.prepare('SELECT * FROM ledger_entries WHERE id = ?').get(result.lastInsertRowid));
});

app.get('/api/admin/settings', ...adminOnly, (_request, response) => response.json({ serviceFee: serviceFee() }));
app.put('/api/admin/settings', ...writeAdmin, (request, response) => {
  const fee = Number(request.body?.serviceFee);
  if (!Number.isInteger(fee) || fee < 0 || fee > 1000000) return response.status(400).json({ error: 'Enter a valid service fee.' });
  database.prepare("INSERT INTO settings (key, value) VALUES ('service_fee', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(fee));
  response.json({ serviceFee: fee });
});

app.get('/api/admin/admins', ...adminOnly, (_request, response) => {
  response.json(database.prepare("SELECT id, name, email, created_at FROM users WHERE role = 'admin' ORDER BY id").all());
});

app.post('/api/admin/admins', ...writeAdmin, async (request, response, next) => {
  try {
    const input = validateNewUser(request.body || {});
    if (input.error) return response.status(400).json({ error: input.error });
    const credentials = await hashPassword(input.password);
    const result = database.prepare("INSERT INTO users (email, name, role, password_salt, password_hash) VALUES (?, ?, 'admin', ?, ?)").run(input.email, input.name, credentials.salt, credentials.hash);
    response.status(201).json(database.prepare('SELECT id, name, email, created_at FROM users WHERE id = ?').get(result.lastInsertRowid));
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return response.status(409).json({ error: 'An account with this email already exists.' });
    next(error);
  }
});

app.get('/api/admin/reports', ...adminOnly, (request, response) => {
  const type = String(request.query.type || 'Tenant Ledger Report');
  const tenantId = Number(request.query.tenantId) || null;
  const propertyId = Number(request.query.propertyId) || null;
  const from = parseDate(request.query.from) || String(request.query.from || '');
  const to = parseDate(request.query.to) || String(request.query.to || '');
  if (type === 'Property Booking Report') {
    const properties = database.prepare('SELECT * FROM properties ORDER BY id').all().map((property) => ({
      ...publicProperty(property),
      bookings: database.prepare('SELECT COUNT(*) AS count FROM bookings WHERE property_id = ?').get(property.id).count,
      tenant: database.prepare(`${bookingSelect} WHERE b.property_id = ? ORDER BY b.created_at DESC LIMIT 1`).get(property.id)?.tenant_name || null
    })).filter((property) => !propertyId || property.id === propertyId);
    return response.json({ type, properties });
  }
  let query = `${bookingSelect} WHERE 1 = 1`;
  const parameters = [];
  if (tenantId) { query += ' AND b.user_id = ?'; parameters.push(tenantId); }
  if (propertyId) { query += ' AND b.property_id = ?'; parameters.push(propertyId); }
  if (from) { query += ' AND b.created_at >= ?'; parameters.push(`${from} 00:00:00`); }
  if (to) { query += ' AND b.created_at <= ?'; parameters.push(`${to} 23:59:59`); }
  const bookings = database.prepare(`${query} ORDER BY b.created_at DESC`).all(...parameters).map(publicBooking);
  if (type === 'Payment Report') return response.json({ type, bookings, payments: database.prepare(`SELECT p.*, b.booking_ref, b.tenant_name, pr.title AS property_title FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN properties pr ON pr.id = b.property_id ORDER BY p.payment_date DESC`).all() });
  const userIds = [...new Set(bookings.map((booking) => booking.userId))];
  const ledger = userIds.flatMap((userId) => database.prepare('SELECT * FROM ledger_entries WHERE user_id = ? ORDER BY entry_date, id').all(userId));
  response.json({ type: 'Tenant Ledger Report', bookings, ledger });
});

app.use((_request, response) => response.status(404).json({ error: 'Route not found.' }));
app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError) return response.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Each image must be 4 MB or smaller.' : 'Invalid image upload.' });
  if (error.message?.startsWith('Only JPEG')) return response.status(400).json({ error: error.message });
  if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return response.status(409).json({ error: 'That email or property unit already exists.' });
  console.error(error);
  response.status(500).json({ error: 'An unexpected server error occurred.' });
});

if (!existsSync(path.join(rootDirectory, 'index.html'))) throw new Error('index.html was not found in the project root.');
app.listen(port, () => console.log(`Janice Apartments API ready at http://localhost:${port}`));
app.listen(port, '0.0.0.0' () =>{
           console.log('server listening on port ${port}');
});
           
