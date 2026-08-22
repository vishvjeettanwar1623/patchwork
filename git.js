import simpleGit from "simple-git";
import fs from "fs-extra";
import path from "path";
import os from "os";
import ora from "ora";
import { generateScaffoldContent } from "./progressive.js";

/**
 * Create a temp working directory and initialize a git repo for remote push.
 *
 * @param {string} repoUrl - GitHub repo URL (without .git suffix).
 * @param {string} username - GitHub username.
 * @param {string} pat - GitHub PAT.
 * @param {string} email - Committer email.
 * @returns {Promise<{ tempDir: string, git: SimpleGit, isIncremental: boolean }>}
 */
export async function setupRepo(repoUrl, username, pat, email) {
  // Create temp directory
  const tempDir = path.join(os.tmpdir(), `patchwork-${Date.now()}`);
  await fs.ensureDir(tempDir);

  const git = simpleGit(tempDir);
  const authUrl = buildAuthUrl(repoUrl, username, pat);
  let isIncremental = false;

  try {
    const spinner = ora({
      text: "  Checking remote repository history...",
      color: "cyan",
    }).start();

    // Attempt to clone the existing repository into the temp directory
    await simpleGit().clone(authUrl, tempDir);
    spinner.succeed("  Found existing remote repository history. Running in Incremental Mode!");
    isIncremental = true;
  } catch (error) {
    // If clone fails (e.g. empty repository), initialize a fresh one
    await git.init();
    await git.addRemote("origin", authUrl);
  }

  // Configure user identity
  await git.addConfig("user.name", username);
  await git.addConfig("user.email", email);

  return { tempDir, git, isIncremental };
}

/**
 * Initialize a local git repository in a temp directory for offline/local mode.
 *
 * @param {string} targetDir - Project folder path.
 * @param {string} username - Git committer username.
 * @param {string} email - Git committer email.
 * @returns {Promise<{ tempDir: string, git: SimpleGit, isIncremental: boolean }>}
 */
export async function setupLocalRepo(targetDir, username, email) {
  const tempDir = path.join(os.tmpdir(), `patchwork-local-${Date.now()}`);
  await fs.ensureDir(tempDir);

  const git = simpleGit(tempDir);
  await git.init();

  await git.addConfig("user.name", username);
  await git.addConfig("user.email", email);

  return { tempDir, git, isIncremental: false };
}

/**
 * Build an authenticated HTTPS URL.
 */
function buildAuthUrl(repoUrl, username, pat) {
  if (!repoUrl || (!repoUrl.startsWith("http://") && !repoUrl.startsWith("https://"))) {
    return repoUrl || "";
  }
  const urlObj = new URL(repoUrl.endsWith(".git") ? repoUrl : repoUrl + ".git");
  urlObj.username = username;
  urlObj.password = pat;
  return urlObj.toString();
}

/**
 * Copy specific files from the source directory to the temp directory,
 * preserving directory structure and respecting progressive evolution stages.
 *
 * @param {string} sourceDir - Absolute path to the user's project folder.
 * @param {string} tempDir - Absolute path to the temp git repo.
 * @param {string[]} files - Relative file paths to copy.
 * @param {Record<string, string>} [fileStages] - Map of relative path to stage ('scaffold' | 'final').
 */
export async function copyFilesToTemp(sourceDir, tempDir, files, fileStages = {}) {
  for (const file of files) {
    const src = path.join(sourceDir, file);
    const dest = path.join(tempDir, file);

    if (await fs.pathExists(src)) {
      await fs.ensureDir(path.dirname(dest));

      const stage = fileStages[file];
      if (stage === "scaffold") {
        try {
          const fullContent = await fs.readFile(src, "utf8");
          const scaffold = generateScaffoldContent(fullContent, file);
          await fs.writeFile(dest, scaffold, "utf8");
        } catch {
          // Fallback to copying whole file if read fails
          await fs.copy(src, dest);
        }
      } else {
        // Full file copy for final stage or standard commits
        await fs.copy(src, dest);
      }
    } else {
      // Mirror local deletion by removing the file in the temp directory if it exists
      await fs.remove(dest);
    }
  }
}

/**
 * Create a single commit with specific files and a custom timestamp.
 *
 * @param {SimpleGit} git - The simple-git instance.
 * @param {string} tempDir - The temp repo directory.
 * @param {string[]} files - Relative file paths to stage.
 * @param {string} message - Commit message.
 * @param {string} timestamp - ISO 8601 timestamp string.
 */
export async function createCommit(git, tempDir, files, message, timestamp) {
  // Stage only the specified files using force (-f) or git rm
  for (const file of files) {
    const dest = path.join(tempDir, file);
    if (await fs.pathExists(dest)) {
      await git.add(["-f", file]);
    } else {
      try {
        await git.rm(file);
      } catch {
        // If file is not tracked or already staged for deletion, ignore
      }
    }
  }

  // Set the author and committer date via environment variables
  await git.env("GIT_AUTHOR_DATE", timestamp);
  await git.env("GIT_COMMITTER_DATE", timestamp);

  // Create the commit
  await git.commit(message);
}

/**
 * Push to remote, detecting main vs master branch.
 *
 * @param {SimpleGit} git
 * @returns {Promise<string>} The branch name that was pushed.
 */
export async function pushToRemote(git) {
  const spinner = ora({
    text: "  Pushing to remote...",
    color: "cyan",
  }).start();

  try {
    const branchSummary = await git.branchLocal();
    let branch = branchSummary.current || "main";

    if (!branch || branch === "") {
      branch = "main";
    }

    await git.push("origin", branch, ["--set-upstream"]);
    spinner.succeed("  Pushed to remote successfully!");
    return branch;
  } catch (error) {
    spinner.fail("  Push failed!");

    if (
      error.message.includes("Authentication") ||
      error.message.includes("403") ||
      error.message.includes("401") ||
      error.message.includes("fatal: unable to access")
    ) {
      throw new Error(
        "Authentication failed. Make sure your PAT has the 'repo' scope enabled.\n" +
          "  Generate a new token at: https://github.com/settings/tokens"
      );
    }

    throw error;
  }
}

/**
 * Clean up the temp directory.
 *
 * @param {string} tempDir
 */
export async function cleanup(tempDir) {
  try {
    await fs.remove(tempDir);
  } catch {
    // Silently ignore cleanup failures
  }
}

/**
 * Install the generated .git repository from tempDir directly into the user's project folder
 * for Local-Only mode.
 *
 * @param {string} projectDir - Absolute path to user's project directory.
 * @param {string} tempDir - Absolute path to temp directory containing .git.
 * @returns {Promise<boolean>}
 */
export async function syncLocalDirectoryGit(projectDir, tempDir) {
  const tempGitDir = path.join(tempDir, ".git");
  const targetGitDir = path.join(projectDir, ".git");

  if (!(await fs.pathExists(tempGitDir))) {
    return false;
  }

  try {
    // If a .git already exists in project, back it up safely
    if (await fs.pathExists(targetGitDir)) {
      const backupDir = path.join(projectDir, `.git.bak-${Date.now()}`);
      await fs.move(targetGitDir, backupDir, { overwrite: true });
    }

    // Move the newly constructed .git directory into projectDir
    await fs.copy(tempGitDir, targetGitDir);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Sync the user's actual project folder with what PatchWork just pushed.
 */
export async function syncLocalRepo(folderPath, repoUrl, username, pat) {
  const localGit = simpleGit(folderPath);
  const gitDir = path.join(folderPath, ".git");
  const isGitRepo = await fs.pathExists(gitDir);

  try {
    if (!isGitRepo) {
      await localGit.init();
    }

    if (repoUrl) {
      const remotes = await localGit.getRemotes(true);
      const originRemote = remotes.find(r => r.name === "origin");

      if (!originRemote) {
        await localGit.addRemote("origin", repoUrl);
      }
    }

    if (repoUrl && username && pat) {
      const authUrl = buildAuthUrl(repoUrl, username, pat);
      await localGit.fetch(authUrl);
      await localGit.reset(["--hard", "FETCH_HEAD"]);
    } else {
      await localGit.fetch("origin");
      await localGit.reset(["--hard", "origin"]);
    }

    return true;
  } catch {
    return false;
  }
}
