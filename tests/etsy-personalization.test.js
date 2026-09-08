"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeEtsyPersonalization,
  personalizationPlan,
  surchargeTotals,
} = require("../lib/etsy-personalization");

test("normalizes all Etsy personalization question types", () => {
  const config = normalizeEtsyPersonalization({ questions: [
    { id: "name", type: "text_input", label: "Name", required: true, maxCharacters: 50 },
    { id: "font", type: "dropdown", label: "Font", required: true, options: [{ id: "1", label: "Arial" }] },
    { id: "photos", type: "labeled_upload", label: "Photos", required: true, maxFiles: 2, options: [{ label: "Left" }, { label: "Right" }] },
  ] }, { listingId: "123", profileSlug: "rug_hy" });
  assert.equal(config.schemaVersion, 2);
  assert.equal(config.questions.length, 3);
  assert.equal(config.questions[2].maxFiles, 2);
  assert.match(config.source.fingerprint, /^[a-f0-9]{64}$/);
});

test("converts Etsy Money and builds unique subset surcharge totals", () => {
  const config = normalizeEtsyPersonalization({ questions: [
    { id: "a", type: "text_input", label: "Line one", required: false, addOnPrice: { amount: 500, divisor: 100, currency_code: "USD" } },
    { id: "b", type: "text_input", label: "Line two", required: false, addOnPrice: { amount: 3, currencyCode: "USD" } },
  ] }, { listingId: "123", profileSlug: "rug_hy" });
  assert.deepEqual(config.pricing.amounts, [3, 5, 8]);
  assert.deepEqual(surchargeTotals(config.questions), [3, 5, 8]);
});

test("rejects invalid add-on pricing and multiple upload questions", () => {
  assert.throws(() => normalizeEtsyPersonalization({ questions: [
    { type: "text_input", label: "Required name", required: true, addOnPrice: { amount: 5 } },
  ] }), /optional text input/);
  assert.throws(() => normalizeEtsyPersonalization({ questions: [
    { type: "unlabeled_upload", label: "Photo", maxFiles: 1 },
    { type: "unlabeled_upload", label: "Logo", maxFiles: 1 },
  ] }), /at most one upload question/);
});

test("keeps the normalizer profile-neutral", () => {
  const plan = personalizationPlan({ questions: [{ type: "text_input", label: "Name" }] }, { profileSlug: "future_profile" });
  assert.equal(plan.ok, true);
  assert.equal(plan.config.source.profileSlug, "future_profile");
});
