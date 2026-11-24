// Runs offline before the web service starts. Never changes an existing account.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");

function bootstrap() {
  const credentials = JSON.parse(
    fs.readFileSync("/run/secrets/admin_credentials", "utf8"),
  );
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(credentials.email) ||
    typeof credentials.password !== "string" ||
    credentials.password.length < 16
  )
    throw new Error("Invalid initial administrator credentials");

  // Resolve from declared package dependencies, independently of the pnpm layout/version.
  const workerRequire = createRequire("/app/apps/workers/package.json");
  const Database = workerRequire("better-sqlite3");
  const authRequire = createRequire(
    workerRequire.resolve("@karakeep/trpc/package.json"),
  );
  const bcrypt = authRequire("bcryptjs");
  const dataDir = process.env.DATA_DIR;
  if (!dataDir || dataDir !== "/data")
    throw new Error("Unexpected data directory");
  fs.mkdirSync(dataDir, { recursive: true });
  execFileSync(process.execPath, ["/db_migrations/index.js"], {
    cwd: "/db_migrations",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const db = new Database(path.join(dataDir, "db.db"));
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 10000");
  try {
    return db
      .transaction(() => {
        if (db.prepare("SELECT COUNT(*) AS n FROM user").get().n !== 0)
          return { created: false, message: "Existing accounts preserved" };
        const userId = crypto.randomBytes(12).toString("hex");
        const accountId = crypto.randomBytes(12).toString("hex");
        const now = Date.now();
        const passwordHash = bcrypt.hashSync(credentials.password, 10);
        db.prepare(`INSERT INTO user
        (id, name, email, emailVerified, role, timezone, bookmarkClickAction, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          userId,
          "Admin",
          credentials.email.toLowerCase(),
          0,
          "admin",
          "Asia/Shanghai",
          "expand_bookmark_preview",
          now,
          now,
        );
        db.prepare(`INSERT INTO account
        (id, accountId, providerId, userId, password, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          accountId,
          userId,
          "credential",
          userId,
          passwordHash,
          now,
          now,
        );
        return { created: true, message: "Initial administrator created" };
      })
      .immediate();
  } finally {
    db.close();
  }
}

try {
  console.log(JSON.stringify(bootstrap()));
} catch {
  console.error(
    "Administrator initialization failed; no credential values were logged.",
  );
  process.exitCode = 1;
}
