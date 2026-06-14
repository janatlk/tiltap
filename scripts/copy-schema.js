const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "src", "db", "schema.sql");
const dest = path.join(__dirname, "..", "dist", "db", "schema.sql");

if (fs.existsSync(src)) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log("Copied schema.sql to dist/db/schema.sql");
} else {
  console.error("schema.sql not found at", src);
  process.exit(1);
}
