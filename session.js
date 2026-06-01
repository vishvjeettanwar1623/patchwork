import fs from "fs-extra";
import path from "path";

const SESSION_FILE = "patchwork-session.json";

/**
 * Check if a session file exists in the current working directory.
 */
export function sessionExists() {
  return fs.existsSync(path.resolve(SESSION_FILE));
}

/**
 * Load the session data from disk.
 *
 * @returns {object|null} The parsed session data, or null if not found/invalid.
 */
export function loadSession() {
  try {
    const data = fs.readJsonSync(path.resolve(SESSION_FILE));
    return data;
  } catch {
    return null;
  }
}

/**
 * Save session data to disk.
 * Never stores the PAT — only stores state needed to resume.
 *
 * @param {object} data - Session state to save.
 */
export function saveSession(data) {
  // Ensure PAT is never stored
  const safeData = { ...data };
  delete safeData.pat;

  fs.writeJsonSync(path.resolve(SESSION_FILE), safeData, { spaces: 2 });
}

/**
 * Delete the session file.
 */
export function deleteSession() {
  try {
    fs.removeSync(path.resolve(SESSION_FILE));
  } catch {
    // Silently ignore if file doesn't exist
  }
}
