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
  if (!repoUrl.startsWith("http://") && !repoUrl.startsWith("https://")) {
    return repoUrl;
  }
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
 * Runs `git fetch origin` then `git reset --hard origin` so the local branch
 * snaps to exactly match the remote — VS Code / any editor's Source Control
 * panel will reflect the pushed state with 0 pending changes for committed
 * files.
 *
 * Using bare "origin" (not "origin/master" or "origin/main") lets git resolve
 * the remote's default branch via origin/HEAD automatically.
 *
 * @param {string} folderPath - Absolute path to the user's project folder.
 * @returns {Promise<boolean>} true if sync succeeded, false if skipped/failed.
 */
export async function syncLocalRepo(folderPath, repoUrl, username, pat) {
  const localGit = simpleGit(folderPath);
  const gitDir = path.join(folderPath, ".git");
  const isGitRepo = await fs.pathExists(gitDir);

  try {
    if (!isGitRepo) {
      await localGit.init();
    }

    // Configure/Update remote origin if credentials are provided
    if (repoUrl && username && pat) {
      const authUrl = buildAuthUrl(repoUrl, username, pat);
      const remotes = await localGit.getRemotes(true);
      const originRemote = remotes.find(r => r.name === "origin");

      if (!originRemote) {
        await localGit.addRemote("origin", authUrl);
      } else if (originRemote.refs.push !== authUrl) {
        await localGit.remote(["set-url", "origin", authUrl]);
      }
    }

    // Download latest remote refs — non-destructive.
    await localGit.fetch("origin");

    // Snap local branch to match remote exactly.
    // "origin" follows origin/HEAD, so this works for both master and main.
    await localGit.reset(["--hard", "origin"]);

    return true;
  } catch {
    // Not a fatal error — user can still run `git fetch && git reset --hard origin` manually.
    return false;
  }
}
