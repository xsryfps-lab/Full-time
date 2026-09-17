const crypto = require("crypto");
const { newId, now } = require("./utils");
const mongo = require("./db/mongo");

// Simple, dependency-free auth: username/password accounts with two roles
// (admin/friend), in-memory sessions (a server restart logging everyone out
// is an acceptable tradeoff — it avoids a second stateful store), and
// manual cookie parsing/setting. No bcrypt, no cookie-parser, no
// express-session — just Node built-ins plus the MongoDB driver for the
// one thing that actually needs to survive a restart: accounts.

const SESSION_COOKIE = "ft_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// -----------------------------------------------------------------------
// User store — in-memory cache loaded once from MongoDB at startup.
// Reads (findUserByUsername, findUserById, listUsers) stay fully
// synchronous, same as every other module in this app that made this
// tradeoff. Every mutation writes to MongoDB FIRST and only updates the
// cache once that succeeds, so the cache can never drift ahead of what's
// actually persisted.
// -----------------------------------------------------------------------

let _users = null;

async function init() {
  const docs = await mongo.collection("users").find({}).toArray();
  _users = docs.map((d) => {
    const { _id, ...rest } = d;
    return { id: _id, ...rest };
  });
}

function requireInit() {
  if (!_users) throw new Error("auth.init() must be awaited at startup before auth functions are used.");
  return _users;
}

function findUserByUsername(username) {
  if (!username) return null;
  const users = requireInit();
  const lower = String(username).toLowerCase();
  return users.find((u) => u.username.toLowerCase() === lower) || null;
}

function findUserById(id) {
  if (!id) return null;
  return requireInit().find((u) => u.id === id) || null;
}

function listUsers() {
  return requireInit();
}

function countAdmins(users) {
  return users.filter((u) => u.role === "admin").length;
}

// -----------------------------------------------------------------------
// Password hashing — Node's built-in scrypt, no bcrypt dependency needed.
// -----------------------------------------------------------------------

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function makeCredentials(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(password, salt);
  return { salt, passwordHash };
}

function verifyPassword(user, password) {
  if (!user || typeof password !== "string") return false;
  const candidateHash = hashPassword(password, user.salt);
  const a = Buffer.from(candidateHash, "hex");
  const b = Buffer.from(user.passwordHash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// -----------------------------------------------------------------------
// User management
// -----------------------------------------------------------------------

function validateUsername(username) {
  const cleaned = (username || "").trim();
  if (cleaned.length < 3) throw new Error("Username must be at least 3 characters.");
  if (!/^[a-zA-Z0-9_.-]+$/.test(cleaned)) throw new Error("Username can only contain letters, numbers, underscores, dots, and hyphens.");
  return cleaned;
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 6) throw new Error("Password must be at least 6 characters.");
  return password;
}

function validateDailyLimit(dailyLimit) {
  if (dailyLimit === null || dailyLimit === undefined) return null;
  const n = Number(dailyLimit);
  if (!Number.isFinite(n) || n < 0) throw new Error("Daily limit must be a non-negative number, or null for unlimited.");
  return Math.round(n);
}

/** Create a new account. role: "admin" | "friend" (defaults to "friend"). */
async function createUser({ username, password, role = "friend", dailyLimit = null }) {
  const cleanUsername = validateUsername(username);
  validatePassword(password);
  if (role !== "admin" && role !== "friend") throw new Error('Role must be "admin" or "friend".');
  const cleanDailyLimit = validateDailyLimit(dailyLimit);

  if (findUserByUsername(cleanUsername)) throw new Error(`Username "${cleanUsername}" is already taken.`);

  const { salt, passwordHash } = makeCredentials(password);
  const user = { id: newId(), username: cleanUsername, salt, passwordHash, role, dailyLimit: cleanDailyLimit, createdAt: now() };

  const { id, ...rest } = user;
  await mongo.collection("users").insertOne({ _id: id, ...rest });
  requireInit().push(user);
  return user;
}

/** Update role and/or dailyLimit for an existing user. Refuses to demote the last remaining admin. */
async function updateUser(id, patch = {}) {
  const users = requireInit();
  const user = users.find((u) => u.id === id);
  if (!user) throw new Error("User not found.");

  let nextRole = user.role;
  if (patch.role !== undefined) {
    if (patch.role !== "admin" && patch.role !== "friend") throw new Error('Role must be "admin" or "friend".');
    if (user.role === "admin" && patch.role !== "admin" && countAdmins(users) <= 1) {
      throw new Error("Cannot demote the last remaining admin account.");
    }
    nextRole = patch.role;
  }
  const nextDailyLimit = patch.dailyLimit !== undefined ? validateDailyLimit(patch.dailyLimit) : user.dailyLimit;

  await mongo.collection("users").updateOne({ _id: id }, { $set: { role: nextRole, dailyLimit: nextDailyLimit } });
  user.role = nextRole;
  user.dailyLimit = nextDailyLimit;
  return user;
}

/** Delete a user account. Refuses to delete the last remaining admin. */
async function deleteUser(id) {
  const users = requireInit();
  const user = users.find((u) => u.id === id);
  if (!user) throw new Error("User not found.");
  if (user.role === "admin" && countAdmins(users) <= 1) {
    throw new Error("Cannot delete the last remaining admin account.");
  }
  await mongo.collection("users").deleteOne({ _id: id });
  _users = users.filter((u) => u.id !== id);
  destroyAllSessionsForUser(id);
  return true;
}

/** Self-service password change — requires knowing the current password. */
async function changePassword(userId, oldPassword, newPassword) {
  const user = requireInit().find((u) => u.id === userId);
  if (!user) throw new Error("User not found.");
  if (!verifyPassword(user, oldPassword)) throw new Error("Current password is incorrect.");
  validatePassword(newPassword);
  const { salt, passwordHash } = makeCredentials(newPassword);
  await mongo.collection("users").updateOne({ _id: userId }, { $set: { salt, passwordHash } });
  user.salt = salt;
  user.passwordHash = passwordHash;
  return true;
}

/** Admin-initiated password reset — no old password required. */
async function resetPassword(userId, newPassword) {
  const user = requireInit().find((u) => u.id === userId);
  if (!user) throw new Error("User not found.");
  validatePassword(newPassword);
  const { salt, passwordHash } = makeCredentials(newPassword);
  await mongo.collection("users").updateOne({ _id: userId }, { $set: { salt, passwordHash } });
  user.salt = salt;
  user.passwordHash = passwordHash;
  return true;
}

/** Strip sensitive fields before ever sending a user object to the client. */
function publicUser(user) {
  if (!user) return null;
  const { id, username, role, dailyLimit, createdAt } = user;
  return { id, username, role, dailyLimit, createdAt };
}

// -----------------------------------------------------------------------
// Bootstrap — auto-create one admin account on a completely fresh install.
// -----------------------------------------------------------------------

async function bootstrapAdminIfNeeded() {
  if (requireInit().length > 0) return;

  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString("base64url");
  await createUser({ username, password, role: "admin", dailyLimit: null });

  console.log("=".repeat(70));
  console.log("First run detected — created an admin account:");
  console.log(`  Username: ${username}`);
  if (process.env.ADMIN_PASSWORD) {
    console.log("  Password: (from ADMIN_PASSWORD in your .env)");
  } else {
    console.log(`  Password: ${password}`);
    console.log("  This password was generated randomly and is shown ONLY ONCE.");
    console.log("  Save it now — set ADMIN_USERNAME/ADMIN_PASSWORD in .env to control it yourself next time.");
  }
  console.log("=".repeat(70));
}

// -----------------------------------------------------------------------
// Sessions — in-memory only. A server restart logs everyone out; that's an
// accepted, simple tradeoff rather than adding a second persisted store.
// -----------------------------------------------------------------------

const sessions = new Map(); // token -> { userId, expiresAt }

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

function destroyAllSessionsForUser(userId) {
  for (const [token, session] of sessions.entries()) {
    if (session.userId === userId) sessions.delete(token);
  }
}

/** Resolve a session token to a public user object, or null if invalid/expired/deleted. */
function getSessionUser(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  const user = findUserById(session.userId);
  if (!user) {
    sessions.delete(token); // account was deleted since the session was issued
    return null;
  }
  return publicUser(user);
}

// -----------------------------------------------------------------------
// Manual cookie handling — no cookie-parser dependency.
// -----------------------------------------------------------------------

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

function setSessionCookie(res, token) {
  const maxAgeSec = Math.round(SESSION_TTL_MS / 1000);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`);
}

// -----------------------------------------------------------------------
// Express middleware
// -----------------------------------------------------------------------

function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  const user = getSessionUser(token);
  if (!user) {
    return res.status(401).json({ error: "Not authenticated. Please log in." });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Not authenticated. Please log in." });
  }
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

module.exports = {
  SESSION_COOKIE,
  init,
  bootstrapAdminIfNeeded,
  findUserByUsername,
  findUserById,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  changePassword,
  resetPassword,
  verifyPassword,
  publicUser,
  createSession,
  destroySession,
  getSessionUser,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  requireAdmin,
};
