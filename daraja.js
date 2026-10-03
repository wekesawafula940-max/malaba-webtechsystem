import 'dotenv/config';

let cachedToken = null;
let tokenExpiresAt = 0;

const darajaHosts = {
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke'
};

export function normalizeKenyanPhone(value) {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/[^0-9]/g, '');
  if (/^0[17][0-9]{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^[17][0-9]{8}$/.test(digits)) return `254${digits}`;
  if (/^254[17][0-9]{8}$/.test(digits)) return digits;
  return null;
}

export function getDarajaConfig(env = process.env) {
  const environment = env.SAFARICOM_ENV || 'sandbox';
  if (!darajaHosts[environment]) throw Object.assign(new Error('SAFARICOM_ENV must be sandbox or production.'), { status: 503 });
  const required = ['DARAJA_CONSUMER_KEY', 'DARAJA_CONSUMER_SECRET', 'DARAJA_SHORTCODE', 'DARAJA_PASSKEY', 'DARAJA_CALLBACK_URL'];
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length) throw Object.assign(new Error('Safaricom Daraja is not configured on the server.'), { status: 503, missing });
  let callback;
  try { callback = new URL(env.DARAJA_CALLBACK_URL); } catch { throw Object.assign(new Error('DARAJA_CALLBACK_URL must be a valid public URL.'), { status: 503 }); }
  if (environment === 'production' && callback.protocol !== 'https:') throw Object.assign(new Error('DARAJA_CALLBACK_URL must use HTTPS in production.'), { status: 503 });
  const transactionType = env.DARAJA_TRANSACTION_TYPE || 'CustomerPayBillOnline';
  if (!['CustomerPayBillOnline', 'CustomerBuyGoodsOnline'].includes(transactionType)) throw Object.assign(new Error('DARAJA_TRANSACTION_TYPE is invalid.'), { status: 503 });
  return {
    environment,
    host: darajaHosts[environment],
    consumerKey: env.DARAJA_CONSUMER_KEY.trim(),
    consumerSecret: env.DARAJA_CONSUMER_SECRET.trim(),
    shortcode: env.DARAJA_SHORTCODE.trim(),
    passkey: env.DARAJA_PASSKEY.trim(),
    callbackUrl: callback.toString(),
    transactionType,
    partyB: (env.DARAJA_PARTY_B || env.DARAJA_SHORTCODE).trim()
  };
}

function getTimestamp(now = new Date()) {
  const nairobiOffset = 3 * 60 * 60 * 1000;
  const shifted = new Date(now.getTime() + nairobiOffset);
  return `${shifted.getUTCFullYear()}${String(shifted.getUTCMonth() + 1).padStart(2, '0')}${String(shifted.getUTCDate()).padStart(2, '0')}${String(shifted.getUTCHours()).padStart(2, '0')}${String(shifted.getUTCMinutes()).padStart(2, '0')}${String(shifted.getUTCSeconds()).padStart(2, '0')}`;
}

async function getAccessToken(config) {
  if (cachedToken && tokenExpiresAt > Date.now() + 30_000) return cachedToken;
  const authorization = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64');
  let response;
  try {
    response = await fetch(`${config.host}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${authorization}` },
      signal: AbortSignal.timeout(12_000)
    });
  } catch {
    throw Object.assign(new Error('Could not reach Safaricom Daraja OAuth.'), { status: 502 });
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw Object.assign(new Error('Safaricom Daraja OAuth failed; check the server credentials.'), { status: 502 });
  cachedToken = body.access_token;
  tokenExpiresAt = Date.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000;
  return cachedToken;
}

export async function initiateStkPush({ phone, amount, accountReference, description = 'Janice rent' }) {
  const config = getDarajaConfig();
  const normalizedPhone = normalizeKenyanPhone(phone);
  if (!normalizedPhone) throw Object.assign(new Error('Enter a valid Kenyan M-Pesa number, such as 0712345678 or 254712345678.'), { status: 400 });
  if (!Number.isSafeInteger(amount) || amount < 1) throw Object.assign(new Error('The payment amount must be a positive whole number of Kenya shillings.'), { status: 400 });
  const timestamp = getTimestamp();
  const password = Buffer.from(`${config.shortcode}${config.passkey}${timestamp}`).toString('base64');
  const accessToken = await getAccessToken(config);
  let response;
  try {
    response = await fetch(`${config.host}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: config.shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: config.transactionType,
        Amount: amount,
        PartyA: normalizedPhone,
        PartyB: config.partyB,
        PhoneNumber: normalizedPhone,
        CallBackURL: config.callbackUrl,
        AccountReference: String(accountReference).slice(0, 12),
        TransactionDesc: String(description).slice(0, 13)
      }),
      signal: AbortSignal.timeout(20_000)
    });
  } catch {
    throw Object.assign(new Error('Could not reach Safaricom Daraja STK Push.'), { status: 502 });
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ResponseCode !== '0' || !body.CheckoutRequestID || !body.MerchantRequestID) {
    throw Object.assign(new Error(body.errorMessage || body.ResponseDescription || 'Safaricom did not accept the STK Push request.'), { status: 502 });
  }
  return {
    phone: normalizedPhone,
    merchantRequestId: body.MerchantRequestID,
    checkoutRequestId: body.CheckoutRequestID,
    customerMessage: body.CustomerMessage || 'Enter your M-Pesa PIN on your phone to complete payment.'
  };
}

export async function verifyStkCallback(checkoutRequestId, callbackResultCode) {
  const config = getDarajaConfig();
  const timestamp = getTimestamp();
  const password = Buffer.from(`${config.shortcode}${config.passkey}${timestamp}`).toString('base64');
  const accessToken = await getAccessToken(config);
  let response;
  try {
    response = await fetch(`${config.host}/mpesa/stkpushquery/v1/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: config.shortcode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId
      }),
      signal: AbortSignal.timeout(12_000)
    });
  } catch {
    throw Object.assign(new Error('Could not verify the M-Pesa callback with Safaricom.'), { status: 503 });
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || String(body.ResponseCode) !== '0' || !Number.isInteger(Number(body.ResultCode))) {
    throw Object.assign(new Error('Safaricom could not verify the M-Pesa callback yet.'), { status: 503 });
  }
  return Number(body.ResultCode) === Number(callbackResultCode);
}
