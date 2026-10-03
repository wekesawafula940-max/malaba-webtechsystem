# Janice Apartments

Janice Apartments is a single-property rental and booking system for 25 homes in Kilimani, Nairobi. The browser UI is served by a same-origin Node.js API; account, property, booking, payment, and ledger records are stored on the server rather than in browser storage.

## Backend Stack

- Node.js 24 LTS (Node 22.13+ also provides the built-in `node:sqlite` module)
- Express 5 for HTTP routes and static page delivery
- SQLite in WAL mode for the current single-property, low-to-moderate traffic workload
- Node `scrypt` password hashes, HttpOnly/SameSite session cookies, CSRF tokens, and rate-limited login/setup routes
- Multer for bounded property-photo uploads
- Safaricom Daraja OAuth, STK Push, STK Query callback verification, and M-Pesa receipt/ledger recording

SQLite avoids operating a separate database service for one 25-home property. It is appropriate while the application runs as one server instance and write concurrency is modest. If the system grows to multiple buildings, multiple API instances, or sustained concurrent payment/booking writes, migrate the relational schema to PostgreSQL and use a shared session store.

## Run Locally

Requirements: Node.js 22.13 or newer and npm.

```powershell
npm ci
npm start
```

Open http://localhost:3000. The first administrator can be created from the **Admin** button when visiting locally. Tenant accounts are created from a unit's **Book home** flow.

For development with automatic server restarts:

```powershell
npm run dev
```

## Deploy To Render

The root `render.yaml` configures a Node web service with a persistent disk for the SQLite database and uploaded photos. A persistent disk requires a paid Render web-service plan; do not deploy this stateful app on an ephemeral filesystem because data can be lost during a restart or deploy.

1. Push this project to a **private** GitHub repository. Do not include `.env`, `data/`, or `uploads/`.
2. In Render, choose **New → Blueprint**, connect GitHub, select the repository, and apply the `render.yaml` Blueprint.
3. Wait for the first deploy to pass its `/api/health` check. In the Render service's environment settings, reveal the generated `ADMIN_SETUP_KEY`, open the service URL, select **Admin**, and use that one-time key to create the first administrator.
4. After administrator setup is complete, remove `ADMIN_SETUP_KEY` from the Render environment and redeploy. Subsequent admin sign-in does not need it.
5. If enabling M-Pesa, add the Daraja credentials as Render environment variables and set `DARAJA_CALLBACK_URL` to `https://<your-render-domain>/api/payments/daraja/callback`. Never put production credentials in GitHub.

Render disk data is separate from the repository and is not copied from a local installation. If the current local database contains real tenants or bookings, arrange a secure backup and migration before switching users to the hosted service. Back up the hosted database and uploads regularly.

## Safaricom Daraja M-Pesa

Copy `.env.example` to `.env` and fill it with the Daraja app credentials issued in the Safaricom Developer Portal. Keep `.env` private and never commit it. Start with `SAFARICOM_ENV=sandbox`; use a sandbox shortcode, passkey, and consumer key/secret. Configure `DARAJA_CALLBACK_URL` as a public HTTPS URL ending in `/api/payments/daraja/callback`. A local `localhost` address cannot receive Safaricom callbacks; use a trusted HTTPS tunnel for sandbox testing.

For production, set `SAFARICOM_ENV=production`, use the approved production shortcode/passkey and Daraja app credentials, and point the callback URL at the deployed HTTPS domain. Set `DARAJA_TRANSACTION_TYPE` to `CustomerPayBillOnline` for a PayBill or `CustomerBuyGoodsOnline` for a Till. `DARAJA_PARTY_B` is optional and defaults to `DARAJA_SHORTCODE`.

The tenant's **Proceed to Payment with M-Pesa** button requests an STK Push for the outstanding amount. The server stores the request, and the UI polls its status. A payment is only recorded after the callback matches a stored CheckoutRequestID and Safaricom's STK Query confirms the result. The callback then records the M-Pesa receipt and tenant-ledger payment. Without valid Daraja credentials and a reachable callback, the API rejects the request and the UI reports the configuration error; it never pretends payment succeeded.

Tenants can also submit the M-Pesa transaction code and amount after sending money manually. These submissions remain pending and do not change the balance until an administrator checks the Safaricom account and approves them in **Payments**. Rejected submissions can be replaced with a new transaction code. A receipt code is accepted only once.

## Production Setup

Run behind HTTPS and a reverse proxy. Set `NODE_ENV=production` and provide a one-time `ADMIN_SETUP_KEY` through the hosting provider's secret/environment settings before creating the first administrator. The first-admin setup endpoint is disabled without that key in production. Do not commit the setup key or passwords to the repository.

Example PowerShell setup:

```powershell
$env:NODE_ENV = "production"
$env:ADMIN_SETUP_KEY = "use-a-long-random-one-time-secret"
npm start
```

After the first administrator is created, remove `ADMIN_SETUP_KEY` from the service environment and restart it. Administrator creation after bootstrap requires an authenticated admin.

## Data And Backups

SQLite data is stored in `data/janice.sqlite`; uploaded property photos are stored in `uploads/`. Both locations are excluded from Git. Back up the database and uploads together using a SQLite-aware backup (or stop the service during a file copy). Keep backups off the application host and periodically verify a restore.

Online checkout requires valid Daraja credentials and a publicly reachable HTTPS callback. Administrators review manually submitted M-Pesa receipt codes in the Payments view; submitting a code alone never marks a booking as paid.

Administrators can cancel a booking from **Bookings** using **Cancel booking** or the status selector. Cancellation blocks new tenant payment submissions and preserves the booking and payment history. Any refund must be recorded separately by an administrator.

## API Areas

- `/api/auth/*`: tenant/admin login, registration, session, logout
- `/api/admin/setup`: one-time initial administrator setup
- `/api/properties`, `/api/bookings`: public inventory, tenant booking requests, and owned payment status
- `/api/admin/bookings/:reference`: protected booking status updates, including cancellation
- `/api/bookings/:reference/payments/stk`: tenant-owned M-Pesa STK Push initiation
- `/api/payments/daraja/callback`: Safaricom callback, independently verified using STK Query
- `/api/admin/*`: protected property, booking, payment, tenant, ledger, settings, and report operations
- `/api/health`: service/database health check

Run the schema and frontend parser tests with `npm test`.
