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
  await git.addConfig("user.email", `${username}@users.noreply.github.com`);

  return { tempDir, git, isIncremental };
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

/**
 * Sync the user's actual project folder with what PatchWork just pushed.
 *
 * Runs `git fetch` then `git checkout origin/<branch> -- <file>` for each
 * committed file so VS Code / any editor's Source Control panel reflects the
 * pushed state without touching other uncommitted work in the folder.
 *
 * @param {string} folderPath - Absolute path to the user's project folder.
 * @param {string} branch     - Branch that was pushed to (e.g. "main").
 * @param {string[]} files    - Relative file paths that were committed.
 * @returns {Promise<boolean>} true if sync succeeded, false if skipped/failed.
 */
export async function syncLocalRepo(folderPath, branch, files) {
  // Only proceed if this folder is actually a git repository.
  const gitDir = path.join(folderPath, ".git");
  const isGitRepo = await fs.pathExists(gitDir);
  if (!isGitRepo) return false;

  try {
    const localGit = simpleGit(folderPath);

    // Fetch the latest remote refs (non-destructive).
    await localGit.fetch("origin");

    // Checkout only the files PatchWork committed from the remote branch.
    // This marks them as "clean" in the index without affecting anything else.
    for (const file of files) {
      try {
        await localGit.checkout([`origin/${branch}`, "--", file]);
      } catch {
        // Individual file may not exist on the branch yet — skip silently.
      }
    }

    return true;
  } catch {
    // Not a fatal error — user can still pull manually.
    return false;
  }
}
