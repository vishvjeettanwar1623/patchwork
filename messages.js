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
  "You are a developer writing a real Git commit message. Based on the filenames and partial content provided, write a single concise commit message in imperative tone (e.g. 'Add user authentication middleware'). Max 72 characters. No prefix like 'feat:' unless it fits naturally. Return only the commit message, nothing else.";

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
    // Try up to clients.length different keys for this model
    for (let attempt = 0; attempt < clients.length; attempt++) {
      // Rotate clients to distribute requests across keys
      const client = clients[clientIndex % clients.length];
      clientIndex++;

      try {
        const response = await client.chat.completions.create({
          model: modelName,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content },
          ],
          max_tokens: 150,
          temperature: 0.7,
        });

        const message = response.choices[0]?.message?.content?.trim();

        if (message) {
          return message.substring(0, 72);
        }
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error("All models failed");
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
