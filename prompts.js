import inquirer from "inquirer";
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
 * Prompt for commit scheduling type: default backdating or custom start date.
 */
export async function askSchedule() {
  const { scheduleType } = await inquirer.prompt([
    {
      type: "list",
      name: "scheduleType",
      message: "Choose commit date scheduling:",
      choices: [
        { name: "Backdate from today (Default)", value: "default" },
        { name: "Custom start date", value: "custom" },
      ],
    },
  ]);

  return scheduleType;
}

/**
 * Prompt for custom start date and validate it.
 */
export async function askCustomStartDate() {
  const { startDateStr } = await inquirer.prompt([
    {
      type: "input",
      name: "startDateStr",
      message: "Enter start date (YYYY-MM-DD):",
      validate(input) {
        const trimmed = input.trim();
        if (!trimmed) return "Please enter a date.";
        const pattern = /^\d{4}-\d{2}-\d{2}$/;
        if (!pattern.test(trimmed)) {
          return "Invalid format. Expected: YYYY-MM-DD";
        }
        const dateObj = new Date(trimmed);
        if (isNaN(dateObj.getTime())) {
          return "Invalid date. Please enter a valid calendar date.";
        }
        return true;
      },
    },
  ]);

  // Set the time zone to local midnight
  return new Date(startDateStr.trim() + "T00:00:00");
}

/**
 * Prompt for GitHub email address.
 */
export async function askEmail() {
  const { email } = await inquirer.prompt([
    {
      type: "input",
      name: "email",
      message: "GitHub email address (for commit graph attribution):",
      validate(input) {
        const trimmed = input.trim();
        if (!trimmed) return "Email cannot be empty.";
        const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!pattern.test(trimmed)) {
          return "Please enter a valid email address.";
        }
        return true;
      },
    },
  ]);

  return email.trim();
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

  // 4b. Auto-detect or load GitHub email
  let email = process.env.GITHUB_EMAIL;
  if (email && email.trim()) {
    console.log(`\x1b[32m✔\x1b[39m GitHub email: \x1b[36m${email.trim()}\x1b[39m \x1b[90m[Loaded from .env]\x1b[39m`);
    email = email.trim();
  } else {
    email = getGitConfig("user.email") || getGlobalGitConfig("user.email");
    if (email && email.trim()) {
      console.log(`\x1b[32m✔\x1b[39m GitHub email: \x1b[36m${email.trim()}\x1b[39m \x1b[90m[Auto-detected]\x1b[39m`);
      email = email.trim();
    } else {
      email = await askEmail();
    }
  }

  // 5. Ask for days
  const days = await askDays();

  // 6. Ask for schedule type
  const scheduleType = await askSchedule();
  let startDate;

  if (scheduleType === "custom") {
    startDate = await askCustomStartDate();
  } else {
    // Default: Backdate from today
    startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    startDate.setDate(startDate.getDate() - (days - 1));
  }

  return { folderPath, repoUrl, username, email, pat, days, startDate };
}
