#!/usr/bin/env node
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const screenshotDir = process.argv[2] ?? process.env.E2E_SCREENSHOT_DIR;

if (screenshotDir === undefined || screenshotDir.length === 0) {
  console.error("Usage: node scripts/analyze-e2e-screenshots.cjs <screenshot-dir>");
  process.exit(2);
}

function readPngDimensions(filePath) {
  const handle = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(24);
    fs.readSync(handle, header, 0, header.length, 0);
    const pngSignature = "89504e470d0a1a0a";
    if (header.subarray(0, 8).toString("hex") !== pngSignature) {
      return { width: 0, height: 0 };
    }
    return {
      width: header.readUInt32BE(16),
      height: header.readUInt32BE(20)
    };
  } finally {
    fs.closeSync(handle);
  }
}

function hashFile(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function ocrText(filePath) {
  try {
    return execFileSync("tesseract", [filePath, "stdout", "--psm", "6"], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000
    })
      .replace(/\s+/gu, " ")
      .trim();
  } catch {
    return "";
  }
}

function labelFromFile(filePath) {
  return path.basename(filePath, ".png").replace(/^[0-9]{4}-/u, "");
}

function includesLabel(labels, expected) {
  return labels.some((label) => label.includes(expected));
}

const files = fs
  .readdirSync(screenshotDir)
  .filter((entry) => entry.endsWith(".png"))
  .map((entry) => path.join(screenshotDir, entry))
  .sort();

if (files.length === 0) {
  console.error(`No screenshots found in ${screenshotDir}`);
  process.exit(2);
}

const entries = [];
let previousHash;

for (const filePath of files) {
  const stats = fs.statSync(filePath);
  const hash = hashFile(filePath);
  const text = ocrText(filePath);
  const dimensions = readPngDimensions(filePath);
  const label = labelFromFile(filePath);
  const visualChangedFromPrevious =
    previousHash === undefined ? true : previousHash !== hash;

  entries.push({
    file: path.basename(filePath),
    label,
    bytes: stats.size,
    width: dimensions.width,
    height: dimensions.height,
    ocrLength: text.length,
    ocrPreview: text.slice(0, 160),
    visualChangedFromPrevious
  });

  previousHash = hash;
}

const labels = entries.map((entry) => entry.label);
const scenarioChecks = [
  {
    scenario: "compile-error-repair",
    requiredLabels: [
      "click-button-compile-project",
      "click-button-log",
      "click-button-problems",
      "replace-model-main.tex",
      "click-button-save-file"
    ]
  },
  {
    scenario: "agent-patch-review",
    requiredLabels: ["set-agent-prompt", "click-button-send", "click-button-allow"]
  },
  {
    scenario: "section-file-creation",
    requiredLabels: [
      "click-button-new-folder",
      "click-button-new-file",
      "replace-editor-sections-evaluation.tex"
    ]
  },
  {
    scenario: "pdf-search-and-prose-fix",
    requiredLabels: [
      "set-pdf-search-rag",
      "click-button-search-pdf",
      "replace-terminology-main.tex"
    ]
  },
  {
    scenario: "multi-file-save-all",
    requiredLabels: [
      "click-file-method.tex",
      "click-file-results.tex",
      "click-button-save-all-files"
    ]
  }
].map((check) => ({
  ...check,
  missingLabels: check.requiredLabels.filter(
    (requiredLabel) => !includesLabel(labels, requiredLabel)
  )
}));

const invalidScreenshots = entries.filter(
  (entry) => entry.bytes <= 0 || entry.width <= 0 || entry.height <= 0
);
const unchangedActionScreenshots = entries
  .slice(1)
  .filter((entry) => !entry.visualChangedFromPrevious);
const failedScenarios = scenarioChecks.filter(
  (check) => check.missingLabels.length > 0
);

const report = {
  screenshotDir,
  screenshotCount: entries.length,
  invalidScreenshotCount: invalidScreenshots.length,
  ocrReadableCount: entries.filter((entry) => entry.ocrLength > 0).length,
  unchangedAdjacentCount: unchangedActionScreenshots.length,
  scenarioChecks,
  invalidScreenshots,
  unchangedActionScreenshots,
  entries
};

console.log(JSON.stringify(report, null, 2));

if (invalidScreenshots.length > 0 || failedScenarios.length > 0) {
  process.exit(1);
}
