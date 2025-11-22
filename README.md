# ValueVisuals API

Node/Express API providing crypto, metals, Polymarket, portfolio, and account endpoints for the valuevisuals app.

## Overview

* **Auth:** Firebase ID tokens via `Authorization: Bearer <idToken>` (see *Authentication*).
* **Mail:** Postmark for transactional emails (welcome, volunteer notifications).
* **Uploads:** Single-file upload endpoint for volunteer applications.
* **Rate limiting & CORS:** Configurable via environment variables.
* **Health:** `/health` for readiness checks.

> **Project Structure**
```
api.valuevisuals.org/
    ├── Dockerfile
    ├── firebase-service-account.json
    ├── index.js
    ├── package-lock.json
    ├── package.json
    ├── secrets.txt
    ├── wallets.txt
    ├── config/
    │   ├── firebase.js
    │   └── upload.js
    ├── controllers/
    │   ├── core.controller.js
    │   │   - (fn) addCareers()
    │   │   - (fn) applyVolunteer()
    │   │   - (fn) getCareer()
    │   │   - (fn) getCareers()
    │   │   - (fn) health()
    │   │   - (fn) listVolunteers()
    │   │   - (fn) me()
    │   │   - (fn) mirrorAuthedEmail()
    │   │   - (fn) signin()
    │   │   - (fn) signout()
    │   │   - (fn) signup()
    │   │   - (fn) subscribe()
    │   │   - (fn) subscriberCount()
    │   ├── crypto.controller.js
    │   │   - (fn) getChart()
    │   │   - (fn) getGlobal()
    │   │   - (fn) getSummary()
    │   ├── metals.controller.js
    │   │   - (fn) getChart()
    │   │   - (fn) getSummary()
    │   ├── polymarket.controller.js
    │   │   - (fn) getPolymarketBitcoin()
    │   │   - (fn) getPolymarketEthereum()
    │   │   - (fn) getPolymarketGold()
    │   │   - (fn) getPolymarketSilver()
    │   ├── portfolio.btc.data.controller.js
    │   │   - (fn) getPortfolioChart()
    │   │   - (fn) getPortfolioSummary()
    │   ├── portfolio.eth.data.controller.js
    │   │   - (fn) getPortfolioChart()
    │   │   - (fn) getPortfolioSummary()
    │   └── user.portfolio.controller.js
    │       - (fn) deletePreciousHolding()
    │       - (fn) deleteUserWallet()
    │       - (fn) getPreciousHoldings()
    │       - (fn) getUserWallets()
    │       - (fn) savePreciousHolding()
    │       - (fn) saveUserWallet()
    │       - (fn) updatePreciousHolding()
    │       - (fn) updateUserWallet()
    ├── mail/
    │   └── postmark.js
    │       - (fn) notifyAdminOfVolunteer()
    │       - (fn) sendVolunteerApplicationReceipt()
    │       - (fn) sendWelcomeEmail()
    ├── middlewares/
    │   ├── auth.js
    │   │   - (fn) requireAuth()
    │   └── error.js
    │       - (fn) errorHandler()
    │       - (fn) notFound()
    └── routes/
        └── routes.js
```

## Tech Stack

* **Runtime:** Node.js
* **Framework:** Express
* **Auth:** Firebase Admin (service account JSON)
* **Mail:** Postmark
* **File Uploads:** Multer (via `upload.js` config)
* **Misc:** CORS, rate limiting, structured error handling

## Requirements

* Node 18+ (recommended)
* A Firebase service account JSON: `firebase-service-account.json` at repo root
* Postmark server token (if using mail features)

## Getting Started

### 1) Install

```bash
npm install
```

### 2) Environment

Create a `.env` with the following keys (discovered from the codebase):

```env
# Server
PORT=5015
CORS_ORIGINS=http://localhost:3000, https://yourdomain.org, https://app.yourdomain.org
GOOGLE_APPLICATION_CREDENTIALS=./firebase-service-account.json
TURNSTILE_SECRET_KEY=

# Storage
STORAGE_BUCKET=yourdomain.firebasestorage.app

# Mail (Postmark)
POSTMARK_TOKEN=
FROM_EMAIL=email@yourdomain.org
POSTMARK_MESSAGE_STREAM=outbound

# Firebase
FIREBASE_WEB_API_KEY=

# bitcoin blockstream data
MEMPOOL_API_BASE=https://blockstream.info/api
ENTERPRISE_MEMPOOL_API_BASE=https://enterprise.blockstream.info/api
BLOCKSTREAM_ENTERPRISE_LOGIN_URL=https://login.blockstream.com/realms/blockstream-public/protocol/openid-connect/token
BLOCKSTREAM_CLIENT_ID=
BLOCKSTREAM_CLIENT_SECRET=

# Crypto APIs
ETHERSCAN_API_KEY=
ETHERSCAN_API_BASE=https://api.etherscan.io/v2/api
ETHERSCAN_CHAIN_ID=1

# Metals Data Providers
METALS_PROVIDER=goldapi
GOLD_API_KEY=
METALS_CACHE_TTL_MS=30000
METALS_API_KEY=
TWELVE_DATA_METALS_API_KEY=
ALLOW_SYNTHETIC_PRICES=true

# Commodities Data Providers
API_NINJA_API_KEY=

```

> The Firebase Admin SDK will load credentials from `firebase-service-account.json` at the project root.

### 3) Run (development)

```bash
npm run dev
```

### 4) Run (production)

```bash
npm start
# equivalent to: NODE_ENV=production node index.js
```

### 5) Docker (optional)

```bash
# Build and run
docker build -t yourdomain-api .
docker run --rm -p 3001:3001 --env-file .env -v "$(pwd)"/firebase-service-account.json:/app/firebase-service-account.json:ro yourdomain-api
```

## Authentication

Most data endpoints require Firebase authentication:

* Send the Firebase ID token from your frontend sign-in flow in the **Authorization** header:

  ```
  Authorization: Bearer <FIREBASE_ID_TOKEN>
  ```
* The middleware `requireAuth` verifies the token and attaches the user to the request.

### Test your token

```bash
curl -i http://localhost:3001/me \
  -H "Authorization: Bearer $ID_TOKEN"
```

## Endpoints (High-Level)

> See `routes/routes.js` and controller files in `controllers/` for full details.

### Public

* `GET /health` — readiness check
* `POST /auth/signup` — create account
* `POST /auth/signin` — sign in
* `POST /subscribe` — newsletter subscription
* `GET /subscribers/count` — count of subscribers
* `GET /get-careers` — list careers
* `GET /get-career/:id` — single career
* `GET /volunteers` — list volunteers
* `POST /volunteers/apply` — submit application (multipart upload)

### Requires Auth (`Authorization: Bearer <token>`)

* **Auth & Profile**

  * `POST /auth/signout`
  * `GET /me`
  * `PUT /user/email/mirror`
* **Crypto**

  * `GET /crypto/global`, `GET /crypto/summary`, `GET /crypto/chart`
* **Metals**

  * `GET /metals/summary`, `GET /metals/chart`
* **Polymarket**

  * `GET /polymarket/bitcoin`, `GET /polymarket/ethereum`, `GET /polymarket/gold`, `GET /polymarket/silver`
* **Portfolio**

  * BTC: `GET /portfolio/btc/summary`, `GET /portfolio/btc/chart`
  * ETH: `GET /portfolio/eth/summary`, `GET /portfolio/eth/chart`
* **User Wallets (crypto)**

  * `GET /user/wallets`, `POST /user/wallets`, `PUT /user/wallets`, `DELETE /user/wallets`
* **User Metals Wallet**

  * `GET /user/metalswallet`, `POST /user/metalswallet`, `PUT /user/metalswallet`, `DELETE /user/metalswallet`

## Example Requests

### Sign in (public)

```bash
curl -X POST http://localhost:3001/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"hunter2"}'
```

### Get crypto summary (auth)

```bash
curl http://localhost:3001/crypto/summary \
  -H "Authorization: Bearer $ID_TOKEN"
```

### Submit volunteer application (public upload)

```bash
curl -X POST http://localhost:3001/volunteers/apply \
  -H "Content-Type: multipart/form-data" \
  -F "resume=@/path/to/resume.pdf" \
  -F "name=Alice"
```

### Manage wallets (auth)

```bash
# create
curl -X POST http://localhost:3001/user/wallets \
  -H "Authorization: Bearer $ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"address":"0x...","label":"Main"}'

# list
curl http://localhost:3001/user/wallets \
  -H "Authorization: Bearer $ID_TOKEN"
```

## Scripts

```json
{
  "scripts": {
    "dev": "nodemon index.js",
    "start": "NODE_ENV=production node index.js"
  }
}
```

## Error Handling

* Centralized error and 404 handling provided by `middlewares/error.js` (`errorHandler`, `notFound`).
* Non-2xx responses include standardized error messages.

## Rate Limiting & CORS

* **Rate limit:** configured via `RATE_LIMIT_MAX`.
* **CORS:** allowed origins via `CORS_ORIGINS` (comma-separated list).

## Mail

* Implemented via `mail/postmark.js`.
* Requires `POSTMARK_TOKEN`, `POSTMARK_MESSAGE_STREAM`, and `FROM_EMAIL`.


## Endpoint summary
```
| Method | Path                     | Controller Function                | Auth Required |
| ------ | ------------------------ | ---------------------------------- | ------------- |
| GET    | `/health`                | `core.health`                      | No            |
| POST   | `/auth/signup`           | `core.signup`                      | No            |
| POST   | `/auth/signin`           | `core.signin`                      | No            |
| POST   | `/auth/signout`          | `core.signout`                     | Yes           |
| GET    | `/me`                    | `core.me`                          | Yes           |
| POST   | `/subscribe`             | `core.subscribe`                   | No            |
| GET    | `/subscribers/count`     | `core.subscriberCount`             | No            |
| GET    | `/get-careers`           | `core.getCareers`                  | No            |
| GET    | `/get-career/:id`        | `core.getCareer`                   | No            |
| POST   | `/add-careers`           | `core.addCareers`                  | Yes           |
| GET    | `/volunteers`            | `core.listVolunteers`              | No            |
| POST   | `/volunteers/apply`      | `core.applyVolunteer`              | No            |
| GET    | `/crypto/global`         | `crypto.getGlobal`                 | Yes           |
| GET    | `/crypto/summary`        | `crypto.getSummary`                | Yes           |
| GET    | `/crypto/chart`          | `crypto.getChart`                  | Yes           |
| GET    | `/polymarket/bitcoin`    | `polymarket.getPolymarketBitcoin`  | Yes           |
| GET    | `/polymarket/ethereum`   | `polymarket.getPolymarketEthereum` | Yes           |
| GET    | `/polymarket/gold`       | `polymarket.getPolymarketGold`     | Yes           |
| GET    | `/polymarket/silver`     | `polymarket.getPolymarketSilver`   | Yes           |
| GET    | `/metals/summary`        | `metals.getSummary`                | Yes           |
| GET    | `/metals/chart`          | `metals.getChart`                  | Yes           |
| GET    | `/portfolio/btc/summary` | `portfolioBTC.getPortfolioSummary` | Yes           |
| GET    | `/portfolio/btc/chart`   | `portfolioBTC.getPortfolioChart`   | Yes           |
| GET    | `/portfolio/eth/summary` | `portfolioETH.getPortfolioSummary` | Yes           |
| GET    | `/portfolio/eth/chart`   | `portfolioETH.getPortfolioChart`   | Yes           |
| GET    | `/user/wallets`          | `user.getUserWallets`              | Yes           |
| PUT    | `/user/wallets`          | `user.updateUserWallet`            | Yes           |
| POST   | `/user/wallets`          | `user.saveUserWallet`              | Yes           |
| DELETE | `/user/wallets`          | `user.deleteUserWallet`            | Yes           |
| GET    | `/user/metalswallet`     | `user.getPreciousHoldings`         | Yes           |
| PUT    | `/user/metalswallet`     | `user.updatePreciousHolding`       | Yes           |
| POST   | `/user/metalswallet`     | `user.savePreciousHolding`         | Yes           |
| DELETE | `/user/metalswallet`     | `user.deletePreciousHolding`       | Yes           |
| PUT    | `/user/email/mirror`     | `core.mirrorAuthedEmail`           | Yes           |

```