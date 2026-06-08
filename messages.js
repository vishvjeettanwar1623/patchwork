import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { isBinaryFile } from "./scanner.js";
import { showWarning } from "./display.js";

let apiKeys = [];
let clients = [];
let primaryModel = null;
let apiAvailable = false;
let warnedOnce = false;

const FREE_MODELS = [
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
 * @returns {Promise<string>} The commit message.
 */
export async function generateMessage(files, sourceDir) {
  // Build cache key
  const cacheKey = [...files].sort().join("|");

  if (messageCache.has(cacheKey)) {
    return messageCache.get(cacheKey);
  }

  // If API is not available, use fallback immediately
  if (!apiAvailable) {
    const fallback = buildFallbackMessage(files);
    messageCache.set(cacheKey, fallback);
    return fallback;
  }

  try {
    const message = await callAPI(files, sourceDir);
    messageCache.set(cacheKey, message);
    return message;
  } catch (error) {
    // Fallback on any API failure — never crash
    if (!warnedOnce) {
      showWarning(`AI Message Generation failed: ${error.message}. Using fallback commit messages.`);
      warnedOnce = true;
    }
    const fallback = buildFallbackMessage(files);
    messageCache.set(cacheKey, fallback);
    return fallback;
  }
}

let clientIndex = 0;

/**
 * Call the OpenRouter API to generate a commit message.
 * Rotates clients and falls back to alternative free models on error.
 */
async function callAPI(files, sourceDir) {
  // Build the user content: filenames + first 30 lines of text files
  let content = "Files in this commit:\n";

  for (const file of files) {
    content += `\n--- ${file} ---\n`;

    if (isBinaryFile(file)) {
      content += "(binary file)\n";
      continue;
    }

    // Read first 30 lines of text files
    try {
      const fullPath = path.join(sourceDir, file);
      const text = fs.readFileSync(fullPath, "utf-8");
      const lines = text.split("\n").slice(0, 30);
      content += lines.join("\n") + "\n";
    } catch {
      content += "(unable to read file)\n";
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

/**
 * Build a fallback commit message when API is unavailable.
 */
function buildFallbackMessage(files) {
  if (files.length === 1) {
    const name = path.basename(files[0]);
    return `Add ${name}`;
  }

  // Try to find a common directory
  const dirs = files.map((f) => path.dirname(f)).filter((d) => d !== ".");
  if (dirs.length > 0) {
    const commonDir = dirs[0].split("/")[0];
    return `Add ${files.length} files to ${commonDir}`;
  }

  return `Add ${files.length} project files`;
}

/**
 * Small delay to avoid rate limiting.
 */
export function delay(ms = 200) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
