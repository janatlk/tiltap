#!/usr/bin/env node
/**
 * Generate ADMIN_PASSWORD_HASH for the admin panel.
 *
 * The password is read from stdin rather than argv so it does not land in the
 * shell history or in the process list, and only the hash is ever printed.
 *
 * Finishes on the first line instead of waiting for end-of-input: over an SSH
 * command that would mean pressing Ctrl+D, which is not obvious and does not
 * behave the same on every client.
 *
 *   node scripts/hash-admin-password.js
 *   (type the password, press Enter)
 */
const { randomBytes, scrypt } = require("crypto");
const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.once("line", (line) => {
  rl.close();
  const password = line.trim();

  if (password.length < 10) {
    console.error("Пароль слишком короткий: нужно минимум 10 символов.");
    process.exit(1);
  }

  const salt = randomBytes(16);
  scrypt(password, salt, 64, (err, key) => {
    if (err) throw err;
    console.log("");
    console.log("Впишите эту строку в /opt/tiltap/.env:");
    console.log("");
    console.log(`ADMIN_PASSWORD_HASH=scrypt$${salt.toString("hex")}$${key.toString("hex")}`);
    console.log("");
    console.log("Затем перезапустите: systemctl restart tiltab-backend");
  });
});

if (process.stdin.isTTY) {
  process.stderr.write("Введите пароль и нажмите Enter: ");
}
