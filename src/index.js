require("dotenv").config();

const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const express = require("express");
const { MongoClient } = require("mongodb");

const DEFAULT_API_HOST = "127.0.0.1";
const DEFAULT_API_PORT = 3072;
const DEFAULT_MONGODB_SERVER_SELECTION_TIMEOUT_MS = 5_000;
const DEFAULT_MONGODB_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_MONGODB_SOCKET_TIMEOUT_MS = 10_000;
const MIN_API_AUTH_TOKEN_LENGTH = 32;

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
  apiHost: process.env.API_HOST || DEFAULT_API_HOST,
  apiPort: readPort("API_PORT", DEFAULT_API_PORT),
  apiAuthToken: (process.env.API_AUTH_TOKEN || "").trim(),
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
let server;
let isShuttingDown = false;

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exitCode = 1;
});

async function main() {
  const startupErrors = validateStartupConfig();

  if (startupErrors.length > 0) {
    console.error(`Invalid configuration:\n${startupErrors.join("\n")}`);
    process.exitCode = 1;
    return;
  }

  const app = createApp();

  server = app.listen(config.apiPort, config.apiHost, () => {
    console.log(
      `MongoDB health API listening on http://${config.apiHost}:${config.apiPort}`,
    );
    console.log(`Loaded ${checks.length} database checks.`);
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(setBaseHeaders);
  app.use(allowOnlyGetAndHead);
  app.use(authenticate);

  app.get("/", (_request, response) => {
    response.json(buildApiIndex());
  });

  app.get("/health", (_request, response) => {
    response.json(buildApiIndex());
  });

  app.get("/health/all", async (_request, response, next) => {
    try {
      const results = await Promise.all(checks.map(checkMongoDatabase));
      const isUp = results.every((result) => result.status === "up");

      response.status(isUp ? 200 : 503).json({
        status: isUp ? "up" : "down",
        checkedAt: new Date().toISOString(),
        checks: results,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/health/:key", async (request, response, next) => {
    try {
      const check = checks.find((candidate) => candidate.key === request.params.key);

      if (!check) {
        response.status(404).json({
          status: "error",
          message: `Unknown database check: ${request.params.key}`,
        });
        return;
      }

      const result = await checkMongoDatabase(check);

      response.status(result.status === "up" ? 200 : 503).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.use((_request, response) => {
    response.status(404).json({
      status: "error",
      message: "Not found",
    });
  });

  app.use((error, _request, response, _next) => {
    console.error("Unexpected API request failure:", error);

    response.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  });

  return app;
}

function validateStartupConfig() {
  const errors = [];

  if (checks.length === 0) {
    errors.push("- No database checks configured");
  }

  if (!config.apiAuthToken) {
    errors.push("- Missing API_AUTH_TOKEN");
  } else if (config.apiAuthToken.length < MIN_API_AUTH_TOKEN_LENGTH) {
    errors.push(
      `- API_AUTH_TOKEN must have at least ${MIN_API_AUTH_TOKEN_LENGTH} characters`,
    );
  }

  return errors;
}

function loadChecks() {
  const configErrors = [];
  const loadedChecks = [];

  for (const check of RAW_CHECKS) {
    const mongoUriEnv = `${check.prefix}_MONGODB_URI`;
    const databaseEnv = `${check.prefix}_MONGODB_DATABASE`;
    const mongoUri = process.env[mongoUriEnv];

    if (!mongoUri) {
      configErrors.push(`- Missing ${mongoUriEnv}`);
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
      endpoint: `/health/${check.key}`,
    });
  }

  if (configErrors.length > 0) {
    console.error(`Invalid database configuration:\n${configErrors.join("\n")}`);
    return [];
  }

  return loadedChecks;
}

async function checkMongoDatabase(check) {
  const startedAt = performance.now();
  const checkedAt = new Date().toISOString();

  try {
    const client = getMongoClient(check);
    await client.connect();
    await client.db(check.databaseName).command({ ping: 1 });

    return {
      key: check.key,
      name: check.name,
      database: check.databaseName,
      status: "up",
      message: "OK",
      pingMs: Math.round(performance.now() - startedAt),
      checkedAt,
    };
  } catch (error) {
    await resetMongoClient(check.key);

    return {
      key: check.key,
      name: check.name,
      database: check.databaseName,
      status: "down",
      message: `MongoDB check failed: ${formatErrorMessage(error)}`,
      pingMs: null,
      checkedAt,
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

function buildApiIndex() {
  return {
    service: "mongodb-health-checker",
    status: "up",
    authentication: {
      type: "bearer",
      header: "Authorization: Bearer <API_AUTH_TOKEN>",
    },
    endpoints: {
      api: "/health",
      allDatabases: "/health/all",
      databases: checks.map((check) => ({
        key: check.key,
        name: check.name,
        endpoint: check.endpoint,
      })),
    },
  };
}

function isAuthorized(request) {
  const authorization = request.headers.authorization;

  if (!authorization) {
    return false;
  }

  const [scheme, ...tokenParts] = authorization.trim().split(/\s+/);

  if (!scheme || scheme.toLowerCase() !== "bearer") {
    return false;
  }

  return secureCompare(tokenParts.join(" "), config.apiAuthToken);
}

function secureCompare(value, expectedValue) {
  const valueHash = crypto.createHash("sha256").update(value).digest();
  const expectedHash = crypto
    .createHash("sha256")
    .update(expectedValue)
    .digest();

  return crypto.timingSafeEqual(valueHash, expectedHash);
}

function setBaseHeaders(_request, response, next) {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");

  next();
}

function allowOnlyGetAndHead(request, response, next) {
  if (request.method === "GET" || request.method === "HEAD") {
    next();
    return;
  }

  response.setHeader("Allow", "GET, HEAD");
  response.status(405).json({
    status: "error",
    message: "Method not allowed",
  });
}

function authenticate(request, response, next) {
  if (isAuthorized(request)) {
    next();
    return;
  }

  response.setHeader("WWW-Authenticate", 'Bearer realm="mongodb-health"');
  response.status(401).json({
    status: "error",
    message: "Unauthorized",
  });
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

function readPort(envName, fallback) {
  const port = readPositiveInteger(envName, fallback);

  if (port > 65_535) {
    console.warn(`${envName} must be a valid TCP port. Falling back to ${fallback}.`);
    return fallback;
  }

  return port;
}

function formatErrorMessage(error) {
  if (!error) {
    return "Unknown error";
  }

  return error.message || String(error);
}

async function shutdown() {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log("Shutting down MongoDB health API...");

  await Promise.allSettled([closeHttpServer(), closeMongoClients()]);

  process.exit(0);
}

function closeHttpServer() {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }

    server.close(resolve);
  });
}

function closeMongoClients() {
  return Promise.allSettled(
    Array.from(clients.keys()).map((key) => resetMongoClient(key)),
  );
}
