# MongoDB Health Checker

Small Node.js service that checks six MongoDB databases every 60 seconds and pushes the result to Uptime Kuma push monitors.

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

3. Copy `.env.example` to `.env` and fill in each MongoDB URI and Uptime Kuma push URL.
4. Start the checker:

```bash
npm start
```

## How It Reports

For each configured database, the app runs a MongoDB `ping` command and sends a simple GET request to the matching Uptime Kuma URL.

The database name is read from the MongoDB connection URI path, for example:

```text
mongodb+srv://user:password@cluster.example.com/ratot_discord_prod?retryWrites=true&w=majority
```

If you ever need to override it, you can still add a matching optional variable, such as `RATOT_DISCORD_PROD_MONGODB_DATABASE=ratot_discord_prod`.

When the database is reachable:

```text
status=up&msg=OK&ping=<latency_ms>
```

When the database is not reachable:

```text
status=down&msg=<failure_reason>&ping=
```

The default interval is 60 seconds. You can change it with `CHECK_INTERVAL_MS` in `.env`.
