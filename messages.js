import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { isBinaryFile } from "./scanner.js";
import { showWarning, showInfo } from "./display.js";

let apiKeys = [];
let clients = [];
let primaryModel = null;
let apiAvailable = false;
let warnedOnce = false;

const FREE_MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "openrouter/free",
  "meta-llama/llama-3.3-70b-instruct:free",
];

/**
 * Initialize the OpenRouter client array.
 * Must be called before generateMessage().
 */
export function initMessageClient() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const apiKeysList = process.env.OPENROUTER_API_KEYS;
  const modelName = process.env.OPENROUTER_MODEL;

  // Gather unique keys
  apiKeys = [];

  const addKeys = (str) => {
    if (!str) return;
    const splitKeys = str.split(",").map(k => k.trim()).filter(Boolean);
    for (const key of splitKeys) {
      if (!apiKeys.includes(key)) {
        apiKeys.push(key);
      }
    }
  };

  addKeys(apiKeysList);
  addKeys(apiKey);

  primaryModel = modelName || FREE_MODELS[0];

  if (process.env.DISABLE_AI === "true") {
    if (!warnedOnce) {
      showInfo("AI generation disabled via DISABLE_AI in .env — using local commit messages.");
      warnedOnce = true;
    }
    apiAvailable = false;
    return;
  }

  if (apiKeys.length === 0) {
    if (!warnedOnce) {
      showWarning("No OpenRouter API key found in .env — using fallback commit messages.");
      warnedOnce = true;
    }
    apiAvailable = false;
    return;
  }

  // Instantiate clients
  clients = apiKeys.map(key => new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: key,
  }));

  apiAvailable = true;
}

/**
 * Check if the AI API is configured and available.
 */
export function isAPIAvailable() {
  return apiAvailable;
}


/**
 * Cache for generated messages.
 * Key = sorted filenames joined by '|'.
 */
const messageCache = new Map();

/**
 * The system prompt for commit message generation.
 */
const SYSTEM_PROMPT =
  "You are a Git commit message generator. Your ONLY output must be a single commit message in imperative tone (e.g. 'Add user authentication'). " +
  "Rules: max 72 characters, no quotes, no punctuation at the end, no explanations, no reasoning, no preamble. " +
  "Output the commit message text ONLY — nothing before it, nothing after it.";

/**
 * Generate a commit message for a set of files.
 *
 * @param {string[]} files - Relative file paths in the commit.
 * @param {string} sourceDir - Absolute path to the source project folder.
 * @param {Record<string, string>} [fileStages] - Map of relative path to stage ('scaffold' | 'final').
 * @returns {Promise<string>} The commit message.
 */
export async function generateMessage(files, sourceDir, fileStages = {}) {
  // Build cache key including stage metadata
  const stagesStr = Object.entries(fileStages || {}).sort().map(([k, v]) => `${k}:${v}`).join(",");
  const cacheKey = `${[...files].sort().join("|")}#${stagesStr}`;

  if (messageCache.has(cacheKey)) {
    return messageCache.get(cacheKey);
  }

  // If API is not available, use fallback immediately
  if (!apiAvailable) {
    const fallback = buildFallbackMessage(files, sourceDir, fileStages);
    messageCache.set(cacheKey, fallback);
    return fallback;
  }

  try {
    const message = await callAPI(files, sourceDir, fileStages);
    messageCache.set(cacheKey, message);
    return message;
  } catch (error) {
    // Fallback on any API failure — never crash
    if (!warnedOnce) {
      showWarning(`AI Message Generation failed: ${error.message}. Using fallback commit messages.`);
      warnedOnce = true;
    }
    const fallback = buildFallbackMessage(files, sourceDir, fileStages);
    messageCache.set(cacheKey, fallback);
    return fallback;
  }
}

/**
 * Extract up to 8 significant symbols (classes, functions, constants) from a file.
 *
 * @param {string} fullPath - Absolute file path.
 * @param {string} category - File category.
 * @returns {string[]} An array of extracted symbols.
 */
function extractFileSymbols(fullPath, category) {
  if (!fs.existsSync(fullPath)) return [];
  try {
    if (category === "docs") {
      const content = fs.readFileSync(fullPath, "utf8");
      const lines = content.split("\n");
      const headings = [];
      for (let i = 0; i < Math.min(lines.length, 100); i++) {
        const line = lines[i].trim();
        const match = line.match(/^##?\s+(.+)$/);
        if (match) {
          headings.push(
            match[1]
              .replace(/[\[\]]/g, "")
              .replace(/\([^)]*\)/g, "")
              .trim()
          );
        }
      }
      return [...new Set(headings)].slice(0, 8);
    } else if (category === "source" || category === "component") {
      const content = fs.readFileSync(fullPath, "utf8");
      const lines = content.split("\n").slice(0, 150);
      const textToScan = lines.join("\n");
      const symbols = [];

     
      const classRegex = /(?:export\s+default\s+|export\s+)?class\s+([A-Za-z0-9_]+)/g;
      let match;
      while ((match = classRegex.exec(textToScan)) !== null) {
        symbols.push(match[1]);
      }

      
      const funcRegex = /(?:export\s+default\s+|export\s+)?function\s+([A-Za-z0-9_]+)/g;
      while ((match = funcRegex.exec(textToScan)) !== null) {
        symbols.push(match[1]);
      }

    
      const constRegex = /export\s+const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_]+)\s*=>/g;
      while ((match = constRegex.exec(textToScan)) !== null) {
        symbols.push(match[1]);
      }

      return [...new Set(symbols)].slice(0, 8);
    }
  } catch {
    // Ignore read errors
  }
  return [];
}

let clientIndex = 0;

/**
 * Call the OpenRouter API to generate a commit message.
 * Rotates clients and falls back to alternative free models on error.
 */
async function callAPI(files, sourceDir, fileStages = {}) {
  // 1. Retrieve project info from package.json
  let projectInfo = "";
  try {
    const pkgPath = path.join(sourceDir, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      projectInfo = `Project: ${pkg.name || "unknown"} - ${pkg.description || ""}\n`;
    }
  } catch {
    // Ignore reading error
  }

  // 2. Build files metadata list
  let content = projectInfo ? `${projectInfo}\nFiles in this commit:\n` : "Files in this commit:\n";

  for (const file of files) {
    content += `\n- ${file}\n`;

    const stage = fileStages[file];
    if (stage === "scaffold") {
      content += "  Stage: Initial scaffolding, types, interfaces, and function signatures\n";
    } else if (stage === "final") {
      content += "  Stage: Implementation and core functionality\n";
    }

    if (isBinaryFile(file)) {
      content += "  Type: binary file\n";
      continue;
    }

    const category = getFileCategory(file);
    content += `  Type: ${category}\n`;

    try {
      const fullPath = path.join(sourceDir, file);
      const symbols = extractFileSymbols(fullPath, category);
      if (symbols.length > 0) {
        content += `  Extracted symbols/headings: ${symbols.join(", ")}\n`;
      }
    } catch {
      // Ignore symbol extraction error
    }
  }

  // Build the list of models to try
  const modelsToTry = [primaryModel];
  for (const fallbackModel of FREE_MODELS) {
    if (fallbackModel !== primaryModel) {
      modelsToTry.push(fallbackModel);
    }
  }

  let lastError = null;

  // Try each model until one succeeds
  for (const modelName of modelsToTry) {
    let modelFailed = false;

    // Try up to clients.length different keys for this model.
    // Only rotate keys for rate-limit errors (429). For model-level
    // errors (empty output, 404, 400) break immediately and try next model.
    for (let attempt = 0; attempt < clients.length; attempt++) {
      const client = clients[clientIndex % clients.length];
      clientIndex++;

      try {
        const response = await client.chat.completions.create({
          model: modelName,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content },
          ],
          max_tokens: 300,
          temperature: 0.7,
        });

        const raw = response.choices[0]?.message?.content?.trim();
        const message = sanitizeMessage(raw);

        if (message) {
          return message;
        }

        // Model responded but with empty / unsanitizable content.
        // No point rotating keys — move straight to next model.
        modelFailed = true;
        break;

      } catch (error) {
        lastError = error;

        const status = error?.status ?? error?.response?.status ?? 0;
        const msg = error?.message ?? "";

        // 429 = rate limit → wait briefly, then try next key for same model.
        if (status === 429) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }

        // Any other error (400 bad request, 404 not found, empty output,
        // "model output must contain text", etc.) → skip this model entirely.
        modelFailed = true;
        break;
      }
    }

    if (modelFailed) continue; // outer loop: move to next model
  }

  throw lastError || new Error("All models failed");
}

/**
 * Sanitize a raw model response into a clean commit message.
 *
 * Reasoning models (e.g. DeepSeek R1 via openrouter/free) sometimes leak
 * their chain-of-thought into `content` before the final answer. This
 * function strips those artifacts and returns only the usable commit message.
 *
 * Returns null if no valid message can be extracted.
 */
function sanitizeMessage(raw) {
  if (!raw) return null;

  // Patterns that indicate reasoning leakage rather than a commit message.
  const REASONING_PREFIXES = [
    /^we need to/i,
    /^i need to/i,
    /^let me/i,
    /^let's/i,
    /^based on/i,
    /^looking at/i,
    /^the files? (in|include|show|contain)/i,
    /^this commit/i,
    /^to write/i,
    /^okay[,.]?/i,
    /^alright[,.]?/i,
    /^sure[,.]?/i,
    /^here('s| is)/i,
    /^so[,\s]/i,
    /^now[,\s]/i,
  ];

  // Split into lines and discard obvious reasoning lines.
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    // Skip lines that look like reasoning text.
    const isReasoning = REASONING_PREFIXES.some((re) => re.test(line));
    if (isReasoning) continue;

    // Skip lines that are too long (reasoning paragraphs) or too short.
    if (line.length > 100 || line.length < 3) continue;

    // Strip surrounding quotes if the model wrapped the message.
    const cleaned = line.replace(/^["'`]|["'`]$/g, "").trim();

    // Must start with a capital or common imperative verbs.
    if (!/^[A-Z]/.test(cleaned)) continue;

    return cleaned.substring(0, 72);
  }

  return null;
}

const CONFIG_FILES = new Set([
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'jsconfig.json',
  'webpack.config.js',
  'vite.config.js',
  'next.config.js',
  'rollup.config.js',
  'gulpfile.js',
  'Gruntfile.js',
  '.gitignore',
  '.gitattributes',
  '.env',
  '.env.example',
  '.env.local',
  '.env.development',
  '.env.production',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.json',
  '.prettierrc',
  '.prettierrc.json',
  'prettier.config.js',
  'babel.config.js',
  '.babelrc',
  'docker-compose.yml',
  'docker-compose.yaml',
  'Dockerfile',
  'cargo.toml',
  'cargo.lock',
  'go.mod',
  'go.sum',
  'gemfile',
  'gemfile.lock',
  'composer.json',
  'composer.lock',
  'requirements.txt'
]);

const CONFIG_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml', '.ini', '.xml', '.config']);
const DOCS_EXTENSIONS = new Set(['.md', '.txt', '.rst', '.adoc', '.pdf']);
const DOCS_FILES = new Set(['license', 'licence', 'license.md', 'contributing.md', 'changelog.md', 'readme', 'readme.md']);
const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less', '.styl', '.postcss']);
const TEST_PATTERNS = [/test/i, /spec/i, /__tests__/i, /__mocks__/i];

const ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico',
  '.mp3', '.wav', '.flac', '.mp4', '.mov', '.avi', '.mkv',
  '.woff', '.woff2', '.eot', '.ttf', '.otf'
]);

const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.rb',
  '.java', '.cs', '.php', '.cpp', '.c', '.h', '.hpp', '.sh',
  '.sql', '.graphql', '.gql', '.swift', '.kt', '.kts', '.scala',
  '.html', '.vue', '.svelte'
]);

/**
 * Categorize a file based on name and extension.
 */
function getFileCategory(file) {
  const base = path.basename(file);
  const baseLower = base.toLowerCase();
  const ext = path.extname(file).toLowerCase();

  if (TEST_PATTERNS.some(pat => pat.test(file))) {
    return 'test';
  }
  if (CONFIG_FILES.has(baseLower) || CONFIG_EXTENSIONS.has(ext) || baseLower.startsWith('.env')) {
    return 'config';
  }
  if (DOCS_FILES.has(baseLower) || DOCS_EXTENSIONS.has(ext)) {
    return 'docs';
  }
  if (STYLE_EXTENSIONS.has(ext)) {
    return 'style';
  }
  if (ASSET_EXTENSIONS.has(ext)) {
    return 'asset';
  }
  if (SOURCE_EXTENSIONS.has(ext)) {
    const normalizedPath = file.replace(/\\/g, '/');
    if (
      normalizedPath.includes('components/') ||
      normalizedPath.includes('views/') ||
      ['.jsx', '.tsx', '.vue', '.svelte'].includes(ext)
    ) {
      return 'component';
    }
    return 'source';
  }
  return 'other';
}

/**
 * Generate a commit message for a single file.
 */
function generateSingleFileMessage(file, sourceDir, stage = null) {
  const base = path.basename(file);
  const ext = path.extname(file).toLowerCase();
  const baseLower = base.toLowerCase();
  const nameWithoutExt = path.basename(file, ext);
  const cleanName = nameWithoutExt.replace(/\.(test|spec)$/i, '');

  // Check if file is deleted locally
  const fullPath = path.join(sourceDir, file);
  if (!fs.existsSync(fullPath)) {
    return `chore: Remove ${base}`;
  }

  if (stage === "scaffold") {
    return `feat: Scaffold initial ${cleanName} structure`;
  }

  if (baseLower === 'package.json' || baseLower === 'package-lock.json' || baseLower === 'yarn.lock' || baseLower === 'pnpm-lock.yaml') {
    return 'chore: Update project dependencies';
  }
  if (baseLower === '.gitignore') {
    return 'chore: Update gitignore configuration';
  }
  if (baseLower === 'readme.md') {
    return 'docs: Update README documentation';
  }
  if (baseLower === 'license' || baseLower === 'license.md') {
    return 'chore: Update project license';
  }
  if (baseLower.startsWith('.env')) {
    return 'chore: Update environment configuration';
  }
  if (baseLower === 'tsconfig.json' || baseLower === 'jsconfig.json') {
    return 'chore: Update compiler configurations';
  }
  const category = getFileCategory(file);

  const symbol = extractFileSymbol(file, category, sourceDir);

  if (stage === "final" && (category === "source" || category === "component")) {
    const target = symbol || cleanName;
    return `feat: Complete ${target} implementation and validation`;
  }

  if (category === 'test') {
    const targetSymbol = symbol || cleanName;
    return `test: Add tests for ${targetSymbol}`;
  }
  if (category === 'style') {
    return `style: Update styling for ${cleanName}`;
  }
  if (category === 'docs') {
    const targetDoc = symbol || base;
    return `docs: Update ${targetDoc}`;
  }
  if (category === 'asset') {
    return `chore: Add static asset ${base}`;
  }
  if (category === 'component') {
    const targetComp = symbol || cleanName;
    return `feat: Implement ${targetComp} component`;
  }
  if (category === 'config') {
    return `chore: Update config for ${cleanName}`;
  }
  if (category === 'source') {
    const targetFn = symbol || cleanName;
    return `feat: Implement ${targetFn} functionality`;
  }

  return `chore: Update ${base}`;
}

/**
 * Extract the first significant symbol (class/function/heading) from a file.
 */
function extractFileSymbol(file, category, sourceDir) {
  if (!sourceDir) return null;
  try {
    const fullPath = path.join(sourceDir, file);
    if (!fs.existsSync(fullPath)) return null;

    if (category === 'docs') {
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < Math.min(lines.length, 30); i++) {
        const line = lines[i].trim();
        const match = line.match(/^##?\s+(.+)$/);
        if (match) {
          return match[1].replace(/[\[\]]/g, '').replace(/\([^)]*\)/g, '').trim();
        }
      }
    } else if (category === 'source' || category === 'component') {
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n').slice(0, 100);
      const textToScan = lines.join('\n');

      const classMatch = textToScan.match(/(?:export\s+default\s+|export\s+)?class\s+([A-Za-z0-9_]+)/);
      if (classMatch) return classMatch[1];

      const funcMatch = textToScan.match(/(?:export\s+default\s+|export\s+)?function\s+([A-Za-z0-9_]+)/);
      if (funcMatch) return funcMatch[1];

      const constMatch = textToScan.match(/export\s+const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_]+)\s*=>/);
      if (constMatch) return constMatch[1];
    }
  } catch (err) {
    // Ignore read errors
  }
  return null;
}

/**
 * Map file category to Conventional Commits prefix.
 */
function getConventionalPrefix(category) {
  switch (category) {
    case 'docs': return 'docs';
    case 'config': return 'chore';
    case 'style': return 'style';
    case 'test': return 'test';
    case 'component': return 'feat';
    case 'source': return 'feat';
    case 'asset': return 'chore';
    default: return 'chore';
  }
}

/**
 * Build a fallback commit message when API is unavailable.
 */
export function buildFallbackMessage(files, sourceDir, fileStages = {}) {
  if (!files || files.length === 0) {
    return "chore: Update project files";
  }

  // Check if all files in this commit are deleted locally
  const allDeleted = files.every(f => !fs.existsSync(path.join(sourceDir, f)));
  if (allDeleted) {
    if (files.length === 1) {
      return `chore: Remove ${path.basename(files[0])}`;
    }
    return `chore: Remove ${files.length} project files`;
  }

  if (files.length === 1) {
    const stage = fileStages[files[0]];
    return generateSingleFileMessage(files[0], sourceDir, stage);
  }

  const categories = files.map(f => ({ file: f, cat: getFileCategory(f) }));
  const uniqueCategories = new Set(categories.map(c => c.cat));

  if (uniqueCategories.size === 1) {
    const singleCat = Array.from(uniqueCategories)[0];
    const prefix = getConventionalPrefix(singleCat);
    if (singleCat === 'docs') {
      return `${prefix}: Update project documentation`;
    }
    if (singleCat === 'config') {
      return `${prefix}: Update project configuration files`;
    }
    if (singleCat === 'style') {
      return `${prefix}: Update user interface styling and themes`;
    }
    if (singleCat === 'test') {
      return `${prefix}: Update and expand unit test suites`;
    }
    if (singleCat === 'asset') {
      return `${prefix}: Add project assets and design resources`;
    }
    if (singleCat === 'component') {
      return `${prefix}: Implement component upgrades and UI fixes`;
    }
  }

  // Common directory check
  const normalizedPaths = files.map(f => f.replace(/\\/g, '/'));
  const dirs = normalizedPaths.map(f => {
    const parts = f.split('/');
    if (parts.length > 1) {
      parts.pop();
      return parts.join('/');
    }
    return '';
  }).filter(Boolean);

  let commonDir = '';
  if (dirs.length > 0) {
    const firstDir = dirs[0];
    const allShareDir = dirs.every(d => d === firstDir);
    if (allShareDir) {
      commonDir = firstDir;
    }
  }

  const sourceFiles = categories.filter(c => c.cat === 'source' || c.cat === 'component');
  const configFiles = categories.filter(c => c.cat === 'config');
  const docsFiles = categories.filter(c => c.cat === 'docs');
  const styleFiles = categories.filter(c => c.cat === 'style');

  if (sourceFiles.length === 1) {
    const primaryFile = sourceFiles[0].file;
    const base = path.basename(primaryFile);
    const ext = path.extname(primaryFile).toLowerCase();
    const nameWithoutExt = path.basename(primaryFile, ext);
    const cleanName = nameWithoutExt.replace(/\.(test|spec)$/i, '');
    const symbol = extractFileSymbol(primaryFile, sourceFiles[0].cat, sourceDir);
    const targetName = symbol || cleanName;

    let prefix = 'feat';
    let action = 'Update';
    if (sourceFiles[0].cat === 'component') {
      action = 'Implement';
    }

    const hasConfig = configFiles.length > 0;
    const hasDocs = docsFiles.length > 0;
    const hasStyle = styleFiles.length > 0;
    const hasTest = categories.some(c => c.cat === 'test');
    const hasAsset = categories.some(c => c.cat === 'asset');

    if (files.length === 2) {
      if (hasStyle) {
        return `${prefix}: ${action} ${targetName} and update styling`;
      }
      if (hasTest) {
        return `${prefix}: ${action} ${targetName} and add tests`;
      }
      if (hasAsset) {
        return `${prefix}: ${action} ${targetName} and add assets`;
      }
    }

    const otherFilesCount = (hasConfig ? configFiles.length : 0) + (hasDocs ? docsFiles.length : 0);
    if (otherFilesCount === files.length - 1) {
      if (hasConfig && hasDocs) {
        return `${prefix}: ${action} ${targetName} and update config/docs`;
      }
      if (hasConfig) {
        return `${prefix}: ${action} ${targetName} and adjust configurations`;
      }
      if (hasDocs) {
        return `${prefix}: ${action} ${targetName} and update documentation`;
      }
    }
  }

  if (commonDir) {
    const lastPart = commonDir.split('/').pop();
    if (sourceFiles.length > 0) {
      return `feat: Update source files in ${lastPart}`;
    }
    return `chore: Update files in ${commonDir}`;
  }

  const counts = {};
  for (const c of categories) {
    counts[c.cat] = (counts[c.cat] || 0) + 1;
  }

  if (counts['source'] && counts['style']) {
    return `feat: Update source code and styles (${files.length} files)`;
  }
  if (counts['source'] && counts['config']) {
    return `feat: Update functionalities and project settings`;
  }

  return `chore: Add ${files.length} project files`;
}

/**
 * Small delay to avoid rate limiting.
 */
export function delay(ms = 200) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
