# MongoDB Health Checker

Authenticated Express.js HTTP API for Uptime Kuma to check the health of multiple MongoDB databases with `GET` requests.

This version does not use Uptime Kuma push monitors. Uptime Kuma should call this API over HTTPS, usually through a Cloudflare Tunnel.

## Databases

- `disflux_sync_dev`
- `disflux_sync_prod`
- `ratot_discord_dev`
- `ratot_discord_prod`
- `ratot_fluxer_dev`
- `ratot_fluxer_prod`

## Setup

1. Install Node.js 18.17 or newer.
2. Install dependencies:

```bash
npm install
```

3. Create `.env` from the example file:

```bash
cp .env.example .env
```

4. Fill in the API variables in `.env`:

```env
API_HOST=127.0.0.1
API_PORT=3072
API_AUTH_TOKEN="a-long-random-token"
```

To generate a secure token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

5. Fill in each database `*_MONGODB_URI` variable.
6. Start the API:

```bash
npm start
```

By default, the API listens on:

```text
http://127.0.0.1:3072
```

If the Cloudflare Tunnel runs on the same machine, point the tunnel to `http://127.0.0.1:3072`.

## Authentication

The API requires a Bearer Token on every endpoint.

Required header:

```http
Authorization: Bearer <API_AUTH_TOKEN>
```

In Uptime Kuma, configure this in one of these ways:

- Authentication Method: `Bearer Token`, using the `API_AUTH_TOKEN` value.
- Or a manual header: `Authorization` with the value `Bearer <API_AUTH_TOKEN>`.

Bearer Token is the recommended option here because the token is not placed in the URL, works well with HTTPS and Cloudflare Tunnel, and is simple to configure in Uptime Kuma.

## Endpoints

All endpoints use `GET`, do not receive a request body, and require the authentication header.

### API

```http
GET /health
```

Returns API information and the list of available endpoints. It does not ping the databases.

`200` response:

```json
{
  "service": "mongodb-health-checker",
  "status": "up",
  "authentication": {
    "type": "bearer",
    "header": "Authorization: Bearer <API_AUTH_TOKEN>"
  },
  "endpoints": {
    "api": "/health",
    "allDatabases": "/health/all",
    "databases": []
  }
}
```

### All Databases

```http
GET /health/all
```

Pings all configured databases.

- Returns `200` if every database is `up`.
- Returns `503` if at least one database is `down`.

### Single Database

```http
GET /health/disflux_sync_dev
GET /health/disflux_sync_prod
GET /health/ratot_discord_dev
GET /health/ratot_discord_prod
GET /health/ratot_fluxer_dev
GET /health/ratot_fluxer_prod
```

Each endpoint runs a MongoDB `ping` only against the matching database.

Successful response, with HTTP `200`:

```json
{
  "key": "ratot_discord_prod",
  "name": "Ratot Discord Prod",
  "database": "ratot_discord_prod",
  "status": "up",
  "message": "OK",
  "pingMs": 12,
  "checkedAt": "2026-04-29T21:00:00.000Z"
}
```

Failure response, with HTTP `503`:

```json
{
  "key": "ratot_discord_prod",
  "name": "Ratot Discord Prod",
  "database": "ratot_discord_prod",
  "status": "down",
  "message": "MongoDB check failed: <reason>",
  "pingMs": null,
  "checkedAt": "2026-04-29T21:00:00.000Z"
}
```

## Uptime Kuma Setup

Create one HTTP(s) monitor per database:

- Monitor Type: `HTTP(s)`
- Method: `GET`
- URL: `https://<your-tunnel-domain>/health/<database_key>`
- Authentication: `Bearer Token`
- Token: value of `API_AUTH_TOKEN`

Example URL:

```text
https://mongodb-health.example.com/health/ratot_discord_prod
```

Uptime Kuma should consider the monitor `up` when it receives HTTP `200`. If the database check fails, the API returns HTTP `503` and Uptime Kuma marks the monitor as `down`.

## Environment Variables

```env
API_HOST=127.0.0.1
API_PORT=3072
API_AUTH_TOKEN="token-with-at-least-32-characters"
MONGODB_SERVER_SELECTION_TIMEOUT_MS=5000
MONGODB_CONNECT_TIMEOUT_MS=5000
MONGODB_SOCKET_TIMEOUT_MS=10000
```

The database name is read automatically from the MongoDB URI path:

```text
mongodb://user:password@host:27017/ratot_discord_prod?authSource=ratot_discord_prod
```

If you need to override it, define the optional matching variable:

```env
RATOT_DISCORD_PROD_MONGODB_DATABASE=ratot_discord_prod
```
