"use strict";

const { ShopifyAdmin } = require("../lib/shopify-admin");

const apply = process.argv.includes("--apply");
const daysArg = process.argv.find((value) => value.startsWith("--days="));
const olderThanDays = daysArg ? Number(daysArg.split("=")[1]) : 30;

new ShopifyAdmin().cleanupOrderFiles({ olderThanDays, apply })
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
