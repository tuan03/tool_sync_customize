"use strict";

const fs = require("fs");
const path = require("path");

function loadEnv(file = path.join(process.cwd(), ".env.shopify")) {
  if (!fs.existsSync(file)) return process.env;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
  return process.env;
}

module.exports = { loadEnv };
