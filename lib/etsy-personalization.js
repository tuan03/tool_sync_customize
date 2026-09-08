"use strict";

const crypto = require("crypto");

const SCHEMA_VERSION = 2;
const QUESTION_TYPES = new Set(["text_input", "dropdown", "unlabeled_upload", "labeled_upload"]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function normalizeMoney(value) {
  if (!value || typeof value !== "object") return null;
  let amount = Number(value.amount);
  if (value.divisor != null) {
    const divisor = Number(value.divisor);
    amount = divisor > 0 ? amount / divisor : NaN;
  }
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    amount: Math.round(amount * 100) / 100,
    currencyCode: String(value.currencyCode || value.currency_code || "USD").toUpperCase(),
  };
}

function normalizeOptions(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).map((option, index) => ({
    id: String(option?.id || option?.option_id || `option-${index + 1}`),
    label: String(option?.label || "").trim(),
  })).filter((option) => {
    const key = option.label.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeQuestion(item, index) {
  const type = String(item?.type || item?.question_type || "text_input");
  if (!QUESTION_TYPES.has(type)) throw new Error(`Unsupported Etsy personalization question type: ${type}`);
  const question = {
    id: String(item?.id || item?.question_id || `question-${index + 1}`),
    type,
    label: String(item?.label || item?.question_text || `Personalization ${index + 1}`).trim(),
    instructions: String(item?.instructions || ""),
    required: Boolean(item?.required),
    maxCharacters: null,
    maxFiles: null,
    options: normalizeOptions(item?.options),
    addOnPrice: normalizeMoney(item?.addOnPrice || item?.add_on_price),
  };
  if (!question.label) throw new Error(`Question ${index + 1} is missing a label.`);
  if (type === "text_input") {
    const max = Number(item?.maxCharacters ?? item?.max_allowed_characters ?? 1024);
    question.maxCharacters = Math.min(1024, Math.max(1, Number.isFinite(max) ? Math.floor(max) : 1024));
  }
  if (type === "dropdown" && !question.options.length) throw new Error(`${question.label} has no dropdown options.`);
  if (type === "unlabeled_upload" || type === "labeled_upload") {
    const max = Number(item?.maxFiles ?? item?.max_allowed_files ?? 1);
    question.maxFiles = Math.min(10, Math.max(type === "labeled_upload" ? 2 : 1, Number.isFinite(max) ? Math.floor(max) : 1));
    if (type === "labeled_upload" && question.options.length !== question.maxFiles) {
      throw new Error(`${question.label} must have one label for each upload slot.`);
    }
  }
  if (question.addOnPrice && (type !== "text_input" || question.required)) {
    throw new Error(`${question.label} has add-on pricing but is not an optional text input.`);
  }
  return question;
}

function surchargeTotals(questions) {
  const amounts = questions.map((question) => Number(question.addOnPrice?.amount || 0)).filter((amount) => amount > 0);
  let totals = new Set([0]);
  for (const amount of amounts) {
    totals = new Set([...totals, ...[...totals].map((total) => Math.round((total + amount) * 100) / 100)]);
  }
  return [...totals].filter((amount) => amount > 0).sort((left, right) => left - right);
}

function normalizeEtsyPersonalization(personalization, { listingId = "", sourceUrl = "", profileSlug = "" } = {}) {
  if (!personalization || typeof personalization !== "object" || Array.isArray(personalization)) {
    throw new Error("Etsy personalization must be an object.");
  }
  const rawQuestions = personalization.questions || personalization.personalization_questions || [];
  if (!Array.isArray(rawQuestions) || !rawQuestions.length) throw new Error("Etsy listing has no personalization questions.");
  if (rawQuestions.length > 5) throw new Error("Etsy supports at most 5 personalization questions.");
  const questions = rawQuestions.map(normalizeQuestion);
  const uploadCount = questions.filter((question) => question.type.endsWith("_upload")).length;
  if (uploadCount > 1) throw new Error("Etsy supports at most one upload question per listing.");
  const currencies = new Set(questions.map((question) => question.addOnPrice?.currencyCode).filter(Boolean));
  if (currencies.size > 1) throw new Error("Etsy personalization add-on prices use multiple currencies.");
  const source = {
    platform: "etsy",
    listingId: String(listingId || ""),
    sourceUrl: String(sourceUrl || ""),
    profileSlug: String(profileSlug || ""),
  };
  const sourceFingerprint = fingerprint({ source, questions });
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: "personalization_form",
    source: { ...source, fingerprint: sourceFingerprint },
    questions,
    pricing: {
      mode: "addon_product",
      currencyCode: [...currencies][0] || "USD",
      amounts: surchargeTotals(questions),
      addonProduct: null,
    },
    warnings: [],
  };
}

function personalizationPlan(personalization, options = {}) {
  const blockers = [];
  const warnings = [];
  let config = null;
  try {
    config = normalizeEtsyPersonalization(personalization, options);
  } catch (error) {
    blockers.push(error.message);
  }
  if (config && config.questions.some((question) => question.instructions.length > 120)) {
    warnings.push("Etsy returned legacy instructions longer than 120 characters; the storefront will preserve them.");
  }
  return {
    ok: blockers.length === 0,
    config,
    blockers,
    warnings,
    summary: config ? {
      questionCount: config.questions.length,
      requiredCount: config.questions.filter((question) => question.required).length,
      uploadCount: config.questions.filter((question) => question.type.endsWith("_upload")).length,
      surchargeAmounts: config.pricing.amounts,
      sourceFingerprint: config.source.fingerprint,
    } : null,
  };
}

module.exports = {
  SCHEMA_VERSION,
  QUESTION_TYPES,
  fingerprint,
  normalizeMoney,
  normalizeEtsyPersonalization,
  surchargeTotals,
  personalizationPlan,
};
