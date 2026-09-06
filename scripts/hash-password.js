// Generates an ADMIN_PASSWORD_HASH value for .env.
// Usage: node scripts/hash-password.js '<your password>'

const crypto = require("crypto");

const password = process.argv[2];
if (!password) {
  console.error("Usage: node scripts/hash-password.js '<your password>'");
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(password, salt, 32);
console.log(`ADMIN_PASSWORD_HASH=scrypt$${salt.toString("hex")}$${hash.toString("hex")}`);
