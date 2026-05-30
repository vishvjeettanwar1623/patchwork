import simpleGit from "simple-git";
import fs from "fs-extra";
import path from "path";
import os from "os";
import ora from "ora";

/**
 * Create a temp working directory and initialize a git repo.
 *
 * @param {string} repoUrl - GitHub repo URL (without .git suffix).
 * @param {string} username - GitHub username.
 * @param {string} pat - GitHub PAT.
 * @returns {Promise<{ tempDir: string, git: SimpleGit }>}
 */
export async function setupRepo(repoUrl, username, pat) {
  // Create temp directory
  const tempDir = path.join(os.tmpdir(), `patchwork-${Date.now()}`);
  await fs.ensureDir(tempDir);

  const git = simpleGit(tempDir);

  // Initialize repo
  await git.init();

  // Set remote with credentials embedded
  const authUrl = buildAuthUrl(repoUrl, username, pat);
  await git.addRemote("origin", authUrl);

  // Configure user identity
  await git.addConfig("user.name", username);
  await git.addConfig("user.email", `${username}@users.noreply.github.com`);

  return { tempDir, git };
}

/**
 * Build an authenticated HTTPS URL.
 */
function buildAuthUrl(repoUrl, username, pat) {
  // repoUrl: https://github.com/user/repo
  // result:  https://username:pat@github.com/user/repo.git
  const urlObj = new URL(repoUrl.endsWith(".git") ? repoUrl : repoUrl + ".git");
  urlObj.username = username;
  urlObj.password = pat;
  return urlObj.toString();
}

/**
 * Copy specific files from the source directory to the temp directory,
 * preserving directory structure.
 *
 * @param {string} sourceDir - Absolute path to the user's project folder.
 * @param {string} tempDir - Absolute path to the temp git repo.
 * @param {string[]} files - Relative file paths to copy.
 */
export async function copyFilesToTemp(sourceDir, tempDir, files) {
  for (const file of files) {
    const src = path.join(sourceDir, file);
    const dest = path.join(tempDir, file);

    // Ensure destination directory exists
    await fs.ensureDir(path.dirname(dest));
    await fs.copy(src, dest);
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
  // Stage only the specified files
  for (const file of files) {
    await git.add(file);
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
    // Detect the current branch name
    const branchSummary = await git.branchLocal();
    let branch = branchSummary.current || "main";

    // If no branch exists yet (empty repo), default to main
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
