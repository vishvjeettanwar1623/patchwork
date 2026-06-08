import inquirer from "inquirer";
import fs from "fs";
import { execSync } from "child_process";
import { showError } from "./display.js";

/**
 * Helper to get git config values.
 */
function getGitConfig(key) {
  try {
    const gitBin = process.platform === "win32" ? "git.exe" : "git";
    return execSync(`${gitBin} config --get ${key}`, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function getGlobalGitConfig(key) {
  try {
    const gitBin = process.platform === "win32" ? "git.exe" : "git";
    return execSync(`${gitBin} config --global --get ${key}`, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/**
 * Convert SSH repo URLs to HTTPS.
 */
function normalizeRepoUrl(url) {
  let trimmed = url.trim().replace(/\.git$/, "");
  if (trimmed.startsWith("git@github.com:")) {
    trimmed = trimmed.replace("git@github.com:", "https://github.com/");
  }
  return trimmed;
}

/**
 * Prompt for the project folder path. Re-prompts on invalid path.
 */
export async function askFolderPath() {
  while (true) {
    const { folderPath } = await inquirer.prompt([
      {
        type: "input",
        name: "folderPath",
        message: "Path to your project folder:",
        validate(input) {
          if (!input.trim()) return "Please enter a path.";
          return true;
        },
      },
    ]);

    const resolved = fs.existsSync(folderPath.trim())
      ? fs.realpathSync(folderPath.trim())
      : null;

    if (!resolved || !fs.statSync(resolved).isDirectory()) {
      showError(`Folder not found: ${folderPath.trim()}`);
      continue;
    }

    return resolved;
  }
}

/**
 * Prompt for GitHub repository URL. Validates HTTPS format.
 */
export async function askRepoUrl() {
  const { repoUrl } = await inquirer.prompt([
    {
      type: "input",
      name: "repoUrl",
      message: "GitHub repository URL (HTTPS):",
      validate(input) {
        const trimmed = input.trim();
        if (!trimmed) return "Please enter a URL.";
        const pattern = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/;
        if (!pattern.test(trimmed)) {
          return "Invalid format. Expected: https://github.com/username/repo or https://github.com/username/repo.git";
        }
        return true;
      },
    },
  ]);

  // Normalize: strip trailing .git if present, we'll add it when needed
  return repoUrl.trim().replace(/\.git$/, "");
}

/**
 * Prompt for GitHub username.
 */
export async function askUsername() {
  const envUsername = process.env.GITHUB_USERNAME;
  if (envUsername && envUsername.trim()) {
    console.log(`\x1b[32m✔\x1b[39m GitHub username: \x1b[36m${envUsername.trim()}\x1b[39m \x1b[90m[Loaded from .env]\x1b[39m`);
    return envUsername.trim();
  }

  const { username } = await inquirer.prompt([
    {
      type: "input",
      name: "username",
      message: "GitHub username:",
      validate(input) {
        if (!input.trim()) return "Username cannot be empty.";
        return true;
      },
    },
  ]);

  return username.trim();
}

/**
 * Prompt for GitHub PAT (hidden input or environment variable).
 */
export async function askPAT() {
  const envPat = process.env.GITHUB_PAT;
  if (envPat && envPat.trim()) {
    console.log(`\x1b[32m✔\x1b[39m GitHub Personal Access Token (PAT): \x1b[36m[Loaded from .env]\x1b[39m`);
    return envPat.trim();
  }

  const { pat } = await inquirer.prompt([
    {
      type: "password",
      name: "pat",
      message: "GitHub Personal Access Token (PAT):",
      mask: "*",
      validate(input) {
        if (!input.trim()) return "PAT cannot be empty.";
        return true;
      },
    },
  ]);

  return pat.trim();
}

/**
 * Prompt for number of days to spread commits across.
 */
export async function askDays() {
  const { days } = await inquirer.prompt([
    {
      type: "number",
      name: "days",
      message: "How many days to spread commits across? (1-30):",
      default: 7,
      validate(input) {
        const n = Number(input);
        if (isNaN(n) || n < 1 || n > 30) {
          return "Please enter a number between 1 and 30.";
        }
        return true;
      },
    },
  ]);

  return Math.max(1, Math.min(30, Math.round(days)));
}

/**
 * Prompt for direction: past (backdate) or future (day by day).
 */
export async function askDirection() {
  const { direction } = await inquirer.prompt([
    {
      type: "list",
      name: "direction",
      message: "Spread commits into:",
      choices: [
        { name: "Past (backdate commits)", value: "past" },
        { name: "Future (day by day from today)", value: "future" },
      ],
    },
  ]);

  return direction;
}

/**
 * Prompt for large project confirmation.
 */
export async function askLargeProjectConfirm() {
  const { proceed } = await inquirer.prompt([
    {
      type: "confirm",
      name: "proceed",
      message: "Do you want to continue?",
      default: true,
    },
  ]);

  return proceed;
}

/**
 * Prompt for session resume or fresh start.
 */
export async function askResumeOrFresh() {
  const { choice } = await inquirer.prompt([
    {
      type: "list",
      name: "choice",
      message: "A previous PatchWork session was found. What would you like to do?",
      choices: [
        { name: "Resume previous session", value: "resume" },
        { name: "Start fresh", value: "fresh" },
      ],
    },
  ]);

  return choice;
}

/**
 * Collect all user inputs sequentially.
 */
export async function collectInputs() {
  // 1. Auto-detect folder path (CWD)
  const folderPath = process.cwd();
  console.log(`\x1b[32m✔\x1b[39m Path to your project folder: \x1b[36m${folderPath}\x1b[39m`);

  // 2. Auto-detect GitHub username
  let username = process.env.GITHUB_USERNAME;
  if (username && username.trim()) {
    console.log(`\x1b[32m✔\x1b[39m GitHub username: \x1b[36m${username.trim()}\x1b[39m \x1b[90m[Loaded from .env]\x1b[39m`);
  } else {
    username = getGitConfig("user.name") || getGlobalGitConfig("user.name");
    if (username) {
      console.log(`\x1b[32m✔\x1b[39m GitHub username: \x1b[36m${username}\x1b[39m`);
    } else {
      username = await askUsername();
    }
  }

  // 3. Auto-detect Repo URL
  let rawRepoUrl = getGitConfig("remote.origin.url");
  let repoUrl = "";
  if (rawRepoUrl) {
    repoUrl = normalizeRepoUrl(rawRepoUrl);
    console.log(`\x1b[32m✔\x1b[39m GitHub repository URL (HTTPS): \x1b[36m${repoUrl}\x1b[39m`);
  } else {
    repoUrl = await askRepoUrl();
  }

  // 4. Load PAT
  const pat = await askPAT();

  // 5. Ask for days and direction
  const days = await askDays();
  const direction = await askDirection();

  return { folderPath, repoUrl, username, pat, days, direction };
}
