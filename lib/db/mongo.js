const { MongoClient } = require("mongodb");

// Single shared connection for the whole app. Every storage module
// (database.js, auth.js, settings.js, metrics.js, rateLimiter.js) gets its
// collection handle through here rather than opening its own connection —
// one pooled client, reused everywhere, matching how the MongoDB driver is
// meant to be used (it manages its own internal connection pool per
// MongoClient instance).
//
// MONGODB_URI is the connection string from MongoDB Atlas (or any other
// MongoDB-compatible host) — see .env.example for where to get one.
// MONGODB_DB_NAME lets you point at a specific database name on that
// cluster; defaults to "fulltime" if not set.

let client = null;
let db = null;

async function connect() {
  if (db) return db;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "MONGODB_URI is not set. Add your MongoDB Atlas connection string to .env — see .env.example for instructions on getting one (free forever, no credit card)."
    );
  }

  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10000, // fail fast with a clear error rather than hanging on a bad URI/network block
  });

  await client.connect();
  // A ping confirms the connection is actually usable (credentials valid,
  // IP allowlisted, cluster reachable) rather than just "constructed".
  await client.db("admin").command({ ping: 1 });

  db = client.db(process.env.MONGODB_DB_NAME || "fulltime");
  console.log(`Connected to MongoDB (database: "${db.databaseName}").`);
  return db;
}

/** Get a collection handle. Throws a clear error if connect() hasn't run yet — every module should await connect() once at startup before using this. */
function collection(name) {
  if (!db) {
    throw new Error(`MongoDB not connected yet — cannot access collection "${name}". connect() must be awaited at server startup before any storage module is used.`);
  }
  return db.collection(name);
}

async function close() {
  if (client) await client.close();
  client = null;
  db = null;
}

async function healthCheck() {
  try {
    if (!db) return { ok: false, error: "Not connected." };
    await db.command({ ping: 1 });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { connect, collection, close, healthCheck };
