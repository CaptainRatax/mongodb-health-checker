require("dotenv").config();

const { performance } = require("node:perf_hooks");
const { MongoClient } = require("mongodb");

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MONGODB_SERVER_SELECTION_TIMEOUT_MS = 5_000;
const DEFAULT_MONGODB_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_MONGODB_SOCKET_TIMEOUT_MS = 10_000;

const RAW_CHECKS = [
  {
    key: "disflux_sync_dev",
    name: "DisFlux Sync Dev",
    prefix: "DISFLUX_SYNC_DEV",
  },
  {
    key: "disflux_sync_prod",
    name: "DisFlux Sync Prod",
    prefix: "DISFLUX_SYNC_PROD",
  },
  {
    key: "ratot_discord_dev",
    name: "Ratot Discord Dev",
    prefix: "RATOT_DISCORD_DEV",
  },
  {
    key: "ratot_discord_prod",
    name: "Ratot Discord Prod",
    prefix: "RATOT_DISCORD_PROD",
  },
  {
    key: "ratot_fluxer_dev",
    name: "Ratot Fluxer Dev",
    prefix: "RATOT_FLUXER_DEV",
  },
  {
    key: "ratot_fluxer_prod",
    name: "Ratot Fluxer Prod",
    prefix: "RATOT_FLUXER_PROD",
  },
];

const clients = new Map();

const config = {
  intervalMs: readPositiveInteger("CHECK_INTERVAL_MS", DEFAULT_INTERVAL_MS),
  requestTimeoutMs: readPositiveInteger(
    "REQUEST_TIMEOUT_MS",
    DEFAULT_REQUEST_TIMEOUT_MS,
  ),
  mongodbServerSelectionTimeoutMs: readPositiveInteger(
    "MONGODB_SERVER_SELECTION_TIMEOUT_MS",
    DEFAULT_MONGODB_SERVER_SELECTION_TIMEOUT_MS,
  ),
  mongodbConnectTimeoutMs: readPositiveInteger(
    "MONGODB_CONNECT_TIMEOUT_MS",
    DEFAULT_MONGODB_CONNECT_TIMEOUT_MS,
  ),
  mongodbSocketTimeoutMs: readPositiveInteger(
    "MONGODB_SOCKET_TIMEOUT_MS",
    DEFAULT_MONGODB_SOCKET_TIMEOUT_MS,
  ),
};

const checks = loadChecks();
let isCycleRunning = false;
let intervalHandle;

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exitCode = 1;
});

async function main() {
  if (checks.length === 0) {
    console.error("No checks configured. Please fill in the .env file first.");
    process.exitCode = 1;
    return;
  }

  console.log(
    `MongoDB health checker started with ${checks.length} checks every ${config.intervalMs}ms.`,
  );

  await runCycle();
  intervalHandle = setInterval(runCycle, config.intervalMs);

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function loadChecks() {
  const configErrors = [];
  const loadedChecks = [];

  for (const check of RAW_CHECKS) {
    const mongoUriEnv = `${check.prefix}_MONGODB_URI`;
    const databaseEnv = `${check.prefix}_MONGODB_DATABASE`;
    const pushUrlEnv = `${check.prefix}_UPTIME_KUMA_PUSH_URL`;
    const mongoUri = process.env[mongoUriEnv];
    const pushUrl = process.env[pushUrlEnv];

    if (!mongoUri) {
      configErrors.push(`- Missing ${mongoUriEnv}`);
    }

    if (!pushUrl) {
      configErrors.push(`- Missing ${pushUrlEnv}`);
    }

    if (!mongoUri || !pushUrl) {
      continue;
    }

    const databaseName =
      process.env[databaseEnv] || getDatabaseNameFromMongoUri(mongoUri);

    if (!databaseName) {
      configErrors.push(
        `- ${mongoUriEnv} must include a database path, or set ${databaseEnv}`,
      );
      continue;
    }

    loadedChecks.push({
      ...check,
      mongoUri,
      databaseName,
      pushUrl,
    });
  }

  if (configErrors.length > 0) {
    console.error(`Invalid configuration:\n${configErrors.join("\n")}`);
    process.exitCode = 1;
    return [];
  }

  return loadedChecks;
}

async function runCycle() {
  if (isCycleRunning) {
    console.warn("Previous health check cycle is still running. Skipping tick.");
    return;
  }

  isCycleRunning = true;
  const startedAt = new Date();
  console.log(`[${startedAt.toISOString()}] Running health checks...`);

  try {
    const results = await Promise.allSettled(checks.map(runCheck));

    for (const result of results) {
      if (result.status === "rejected") {
        console.error("Unexpected check failure:", result.reason);
      }
    }
  } finally {
    isCycleRunning = false;
  }
}

async function runCheck(check) {
  const result = await checkMongoDatabase(check);

  try {
    await pushToUptimeKuma(check, result);
    console.log(
      `[${check.key}] ${result.status.toUpperCase()} - ${result.message}${
        result.pingMs === null ? "" : ` (${result.pingMs}ms)`
      }`,
    );
  } catch (error) {
    console.error(
      `[${check.key}] Failed to push status to Uptime Kuma: ${formatErrorMessage(
        error,
      )}`,
    );
  }
}

async function checkMongoDatabase(check) {
  const startedAt = performance.now();

  try {
    const client = getMongoClient(check);
    await client.connect();
    await client.db(check.databaseName).command({ ping: 1 });

    return {
      status: "up",
      message: "OK",
      pingMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    await resetMongoClient(check.key);

    return {
      status: "down",
      message: `MongoDB check failed: ${formatErrorMessage(error)}`,
      pingMs: null,
    };
  }
}

function getMongoClient(check) {
  const existingClient = clients.get(check.key);

  if (existingClient) {
    return existingClient;
  }

  const client = new MongoClient(check.mongoUri, {
    appName: "mongodb-health-checker",
    maxPoolSize: 1,
    serverSelectionTimeoutMS: config.mongodbServerSelectionTimeoutMs,
    connectTimeoutMS: config.mongodbConnectTimeoutMs,
    socketTimeoutMS: config.mongodbSocketTimeoutMs,
  });

  clients.set(check.key, client);
  return client;
}

async function resetMongoClient(key) {
  const client = clients.get(key);

  if (!client) {
    return;
  }

  clients.delete(key);

  try {
    await client.close(true);
  } catch (error) {
    console.warn(`[${key}] Failed to close MongoDB client:`, error.message);
  }
}

async function pushToUptimeKuma(check, result) {
  const url = buildUptimeKumaUrl(check.pushUrl, result);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `HTTP ${response.status} ${response.statusText}${
          body ? ` - ${body.slice(0, 200)}` : ""
        }`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

function buildUptimeKumaUrl(pushUrl, result) {
  const url = new URL(pushUrl);

  url.searchParams.set("status", result.status);
  url.searchParams.set("msg", result.message);

  if (Number.isFinite(result.pingMs)) {
    url.searchParams.set("ping", String(result.pingMs));
  } else {
    url.searchParams.set("ping", "");
  }

  return url.toString();
}

function getDatabaseNameFromMongoUri(mongoUri) {
  try {
    const url = new URL(mongoUri);
    const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));

    return databaseName || null;
  } catch {
    return null;
  }
}

function readPositiveInteger(envName, fallback) {
  const rawValue = process.env[envName];

  if (!rawValue) {
    return fallback;
  }

  const value = Number.parseInt(rawValue, 10);

  if (!Number.isFinite(value) || value <= 0) {
    console.warn(
      `${envName} must be a positive integer. Falling back to ${fallback}.`,
    );
    return fallback;
  }

  return value;
}

function formatErrorMessage(error) {
  if (!error) {
    return "Unknown error";
  }

  if (error.name === "AbortError") {
    return "Request timed out";
  }

  return error.message || String(error);
}

async function shutdown() {
  console.log("Shutting down MongoDB health checker...");

  if (intervalHandle) {
    clearInterval(intervalHandle);
  }

  await Promise.allSettled(
    Array.from(clients.keys()).map((key) => resetMongoClient(key)),
  );

  process.exit(0);
}
