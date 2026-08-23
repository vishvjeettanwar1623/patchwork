import fs from "fs";
import path from "path";
import { isBinaryFile } from "./scanner.js";

/**
 * Supported file extensions for progressive evolution scaffolding.
 */
const CODE_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".rb", ".php", ".go", ".rs", ".java",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".swift",
  ".kt", ".dart", ".vue", ".svelte", ".html", ".css", ".scss"
]);

/**
 * Check if a file is eligible for progressive multi-pass commits.
 *
 * @param {string} filePath - Absolute path to file.
 * @param {string} relativePath - Relative path in project.
 * @returns {boolean}
 */
export function isEligibleForProgressiveEvolution(filePath, relativePath) {
  if (isBinaryFile(relativePath)) return false;
  
  const ext = path.extname(relativePath).toLowerCase();
  if (!CODE_EXTENSIONS.has(ext)) return false;

  // Avoid config or lock files
  const filename = path.basename(relativePath).toLowerCase();
  if (
    filename.startsWith(".") ||
    filename.includes("config") ||
    filename.includes("package") ||
    filename.includes("tsconfig") ||
    filename.includes("webpack") ||
    filename.includes("vite") ||
    filename.includes("rollup")
  ) {
    return false;
  }

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter(l => l.trim().length > 0);
    // Only evolve files with meaningful substance (at least 30 non-empty lines)
    return lines.length >= 30;
  } catch {
    return false;
  }
}

/**
 * Generate a realistic early-stage scaffold version of a source code file.
 * This simulates a developer writing imports, types, signatures, and initial stubs.
 *
 * @param {string} fullContent - Full file content.
 * @param {string} relativePath - File path.
 * @returns {string} Early-stage scaffold content.
 */
export function generateScaffoldContent(fullContent, relativePath) {
  const lines = fullContent.split("\n");
  const ext = path.extname(relativePath).toLowerCase();

  // If very short, return 50% of lines
  if (lines.length <= 40) {
    const half = Math.max(15, Math.floor(lines.length * 0.5));
    return lines.slice(0, half).join("\n") + "\n";
  }

  const scaffoldLines = [];
  let inImportsOrHeader = true;
  let linesCollected = 0;
  const maxInitialLines = Math.floor(lines.length * 0.45); // First 40-45%

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Always keep imports, requires, directives, and header comments
    if (
      trimmed.startsWith("import ") ||
      trimmed.startsWith("from ") ||
      trimmed.startsWith("require(") ||
      trimmed.startsWith("package ") ||
      trimmed.startsWith("using ") ||
      trimmed.startsWith("#include") ||
      trimmed.startsWith("#!") ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("*/") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith('"""')
    ) {
      scaffoldLines.push(line);
      continue;
    }

    if (inImportsOrHeader && trimmed.length > 0) {
      inImportsOrHeader = false;
    }

    scaffoldLines.push(line);
    linesCollected++;

    if (linesCollected >= maxInitialLines) {
      break;
    }
  }

  // Add a clean closing or trailing comment if appropriate
  let result = scaffoldLines.join("\n").trimEnd() + "\n";
  return result;
}

/**
 * Select a subset of files to progressively evolve across days.
 *
 * @param {string[]} files - Relative file paths.
 * @param {string} projectDir - Base directory.
 * @param {number} totalDays - Number of days.
 * @returns {Set<string>} Set of relative file paths to progressively evolve.
 */
export function selectProgressiveFiles(files, projectDir, totalDays) {
  const progressiveFiles = new Set();
  if (totalDays < 2) return progressiveFiles;

  const eligible = [];
  for (const file of files) {
    const fullPath = path.join(projectDir, file);
    if (isEligibleForProgressiveEvolution(fullPath, file)) {
      eligible.push(file);
    }
  }

  // Evolve up to 25% of eligible files (minimum 1 if available, max 8)
  const countToSelect = Math.min(8, Math.max(1, Math.floor(eligible.length * 0.25)));

  for (let i = 0; i < Math.min(countToSelect, eligible.length); i++) {
    progressiveFiles.add(eligible[i]);
  }

  return progressiveFiles;
}
