#!/usr/bin/env node

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, ".env") });

import ora from "ora";
import crypto from "crypto";

import {
  showBanner,
  showScanSummary,
  showLargeProjectWarning,
  showCommitPlan,
  showProgress,
  showSummary,
  showError,
  showFutureReminder,
  showInfo,
} from "./display.js";

import {
  collectInputs,
  askPAT,
  askResumeOrFresh,
  askLargeProjectConfirm,
} from "./prompts.js";

import { scanFiles, isBinaryFile } from "./scanner.js";
import { chunkCommits, getTotalCommitCount } from "./chunker.js";
import { generateTimestamps, formatTimestamp } from "./timestamps.js";
import { initMessageClient, generateMessage, delay } from "./messages.js";
import { setupRepo, copyFilesToTemp, createCommit, pushToRemote, cleanup, syncLocalRepo } from "./git.js";
import { sessionExists, loadSession, saveSession, deleteSession } from "./session.js";

/**
 * Compute MD5 hash of a file for comparison.
 * Normalizes line endings for text files to avoid false positives on Windows.
 */
function getFileHash(filePath) {
  try {
    if (isBinaryFile(filePath)) {
      const content = fs.readFileSync(filePath);
      return crypto.createHash("md5").update(content).digest("hex");
    } else {
      const content = fs.readFileSync(filePath, "utf8");
      const normalized = content.replace(/\r\n/g, "\n");
      return crypto.createHash("md5").update(normalized, "utf8").digest("hex");
    }
  } catch {
    return "";
  }
}

/**
 * Get new or modified files in local directory compared to temp cloned directory.
 */
function getChangedFiles(localDir, tempDir, allLocalFiles) {
  const changedFiles = [];

  for (const relativePath of allLocalFiles) {
    const localPath = path.join(localDir, relativePath);
    const tempPath = path.join(tempDir, relativePath);

    if (!fs.existsSync(tempPath)) {
      // New file
      changedFiles.push(relativePath);
    } else {
      // Compare hashes
      const localHash = getFileHash(localPath);
      const tempHash = getFileHash(tempPath);
      if (localHash !== tempHash) {
        // Modified file
        changedFiles.push(relativePath);
      }
    }
  }

  return changedFiles;
}

/**
 * Main entry point.
 */
async function main() {
  showBanner();

  let inputs;
  let files;
  let binaryFiles;
  let chunks;
  let isResuming = false;

  // ──────────────────────────────────────────────
  // Step 1: Check for existing session
  // ──────────────────────────────────────────────
  if (sessionExists()) {
    const envPat = process.env.GITHUB_PAT;
    let choice = "resume";

    if (envPat && envPat.trim()) {
      showInfo("Active session found. Auto-resuming using GITHUB_PAT from .env...");
    } else {
      choice = await askResumeOrFresh();
    }

    if (choice === "resume") {
      const session = loadSession();

      if (!session) {
        showError("Failed to load session file. Starting fresh.");
        deleteSession();
      } else {
        showInfo(`Resuming session from ${session.lastRunAt || session.startedAt}`);
        showInfo(`Completed ${session.completedDays}/${session.totalDays} days so far.`);
        console.log();

        // Re-prompt for PAT (never stored in session)
        const pat = await askPAT();

        inputs = {
          folderPath: session.folderPath,
          repoUrl: session.repoUrl,
          username: session.username,
          pat,
          days: session.totalDays - session.completedDays,
          direction: "future",
        };

        files = session.remainingFiles;
        binaryFiles = new Set(session.binaryFilesList || []);
        isResuming = true;
      }
    } else {
      deleteSession();
    }
  }

  // ──────────────────────────────────────────────
  // Step 2: Collect inputs (if not resuming)
  // ──────────────────────────────────────────────
  if (!isResuming) {
    inputs = await collectInputs();

    // ──────────────────────────────────────────────
    // Step 3: Scan files
    // ──────────────────────────────────────────────
    const scanResult = scanFiles(inputs.folderPath);
    files = scanResult.files;
    binaryFiles = scanResult.binaryFiles;

    showScanSummary(scanResult.totalCount, scanResult.breakdown, binaryFiles.size);

    if (scanResult.totalCount === 0) {
      showError("No files found in the project folder. Nothing to do.");
      process.exit(1);
    }
  }

  // ──────────────────────────────────────────────
  // Step 7: Setup git repo in temp directory (Moved up)
  // ──────────────────────────────────────────────
  let tempDir;
  let git;
  let isIncremental = false;

  try {
    const setup = await setupRepo(inputs.repoUrl, inputs.username, inputs.pat);
    tempDir = setup.tempDir;
    git = setup.git;
    isIncremental = setup.isIncremental;
    showInfo(`Working directory: ${tempDir}\n`);
  } catch (error) {
    showError(`Failed to initialize git repo: ${error.message}`);
    process.exit(1);
  }

  // Handle Incremental Mode comparison (only for new runs)
  if (!isResuming && isIncremental) {
    showInfo("Comparing local project files with remote repository...");
    const changedFiles = getChangedFiles(inputs.folderPath, tempDir, files);
    showInfo(`Found ${changedFiles.length} new or modified file(s) to commit.\n`);

    if (changedFiles.length === 0) {
      showInfo("No changes detected. Your GitHub repository is already up to date!");
      await cleanup(tempDir);
      process.exit(0);
    }

    // Filter file list to only changed/new files
    files = changedFiles;

    // Re-verify binary files list
    const updatedBinaryFiles = new Set();
    for (const file of files) {
      if (isBinaryFile(file)) {
        updatedBinaryFiles.add(file);
      }
    }
    binaryFiles = updatedBinaryFiles;
  }

  // Large project warning (only for fresh runs, based on the filtered file list)
  if (!isResuming) {
    if (files.length > 200) {
      showLargeProjectWarning(files.length);
      const proceed = await askLargeProjectConfirm();
      if (!proceed) {
        showInfo("Exiting. No changes were made.");
        await cleanup(tempDir);
        process.exit(0);
      }
    }
  }

  // ──────────────────────────────────────────────
  // Step 4: Chunk commits
  // ──────────────────────────────────────────────
  chunks = chunkCommits(files, inputs.days);
  showCommitPlan(chunks);

  const totalCommits = getTotalCommitCount(chunks);
  showInfo(`Total commits to create: ${totalCommits}\n`);

  // ──────────────────────────────────────────────
  // Step 5: Generate timestamps
  // ──────────────────────────────────────────────
  const timestampedChunks = generateTimestamps(chunks, inputs.direction);

  // ──────────────────────────────────────────────
  // Step 6: Initialize AI client for commit messages
  // ──────────────────────────────────────────────
  initMessageClient();

  // ──────────────────────────────────────────────
  // Step 8: Create commits
  // ──────────────────────────────────────────────
  const commitLog = [];
  let commitIndex = 0;

  // If future mode, only process day 0 (today)
  const chunksToProcess =
    inputs.direction === "future" && !isResuming
      ? timestampedChunks.slice(0, 1)
      : timestampedChunks;

  // Pre-generate all commit messages in parallel
  const allCommits = chunksToProcess.flatMap((day) =>
    day.commits.map((commit) => ({ day, commit }))
  );

  const totalCommitsToCreate = allCommits.length;

  if (totalCommitsToCreate > 0) {
    const spinner = ora({
      text: "  Generating AI commit messages...",
      color: "cyan",
    }).start();

    try {
      // Generate messages sequentially with a gap between requests.
      // OpenRouter free tier allows ~20 req/min (≈1 req / 3s).
      // Firing all requests at once exhausts all keys instantly (429).
      for (let idx = 0; idx < allCommits.length; idx++) {
        const { commit } = allCommits[idx];
        if (idx > 0) await delay(3000); // 3s gap keeps us inside rate limits
        commit.message = await generateMessage(commit.files, inputs.folderPath);
        spinner.text = `  Generating AI commit messages... (${idx + 1}/${allCommits.length})`;
      }

      spinner.succeed("  Generated all commit messages!");
      console.log();
    } catch (error) {
      spinner.fail("  Failed to generate commit messages!");
      showError(error.message);
      await cleanup(tempDir);
      process.exit(1);
    }
  }

  try {
    for (const day of chunksToProcess) {
      for (const commit of day.commits) {
        commitIndex++;

        // Message is pre-generated
        const message = commit.message || "Update project files";

        // Copy files to temp directory
        await copyFilesToTemp(inputs.folderPath, tempDir, commit.files);

        // Create the commit with the custom timestamp
        await createCommit(git, tempDir, commit.files, message, commit.timestamp);

        // Track for summary
        const { date, time } = formatTimestamp(commit.timestamp);
        commitLog.push({
          date,
          time,
          message,
          fileCount: commit.files.length,
        });

        showProgress(commitIndex, totalCommitsToCreate, message);
      }
    }
  } catch (error) {
    showError(`Failed during commit creation: ${error.message}`);
    await cleanup(tempDir);
    process.exit(1);
  }

  // ──────────────────────────────────────────────
  // Step 9: Push to remote
  // ──────────────────────────────────────────────
  console.log();
  let pushedBranch = "main";
  try {
    pushedBranch = await pushToRemote(git);
  } catch (error) {
    showError(error.message);
    await cleanup(tempDir);
    process.exit(1);
  }

  // ──────────────────────────────────────────────
  // Step 10: Cleanup temp directory
  // ──────────────────────────────────────────────
  await cleanup(tempDir);

  // ──────────────────────────────────────────────
  // Step 10b: Sync local git repo so editors reflect the push
  // ──────────────────────────────────────────────
  const synced = await syncLocalRepo(inputs.folderPath);
  if (synced) {
    showInfo("Local git synced — your editor's Source Control is now up to date. ✔");
  }

  // ──────────────────────────────────────────────
  // Step 11: Show summary
  // ──────────────────────────────────────────────
  const dateRange =
    commitLog.length > 0
      ? `${commitLog[0].date} → ${commitLog[commitLog.length - 1].date}`
      : "N/A";

  showSummary({
    totalCommits: commitLog.length,
    dateRange,
    log: commitLog,
  });

  // ──────────────────────────────────────────────
  // Step 12: Handle future mode session
  // ──────────────────────────────────────────────
  if (inputs.direction === "future") {
    const processedDays = chunksToProcess.length;
    const totalDaysOriginal = isResuming
      ? (loadSession()?.totalDays || inputs.days + processedDays)
      : inputs.days;
    const completedSoFar = isResuming
      ? (loadSession()?.completedDays || 0) + processedDays
      : processedDays;
    const remainingDays = totalDaysOriginal - completedSoFar;

    if (remainingDays > 0) {
      // Collect remaining files (files not yet committed today)
      const committedFiles = new Set(
        chunksToProcess.flatMap((day) =>
          day.commits.flatMap((c) => c.files)
        )
      );
      const remainingFiles = files.filter((f) => !committedFiles.has(f));

      saveSession({
        folderPath: inputs.folderPath,
        repoUrl: inputs.repoUrl,
        username: inputs.username,
        totalDays: totalDaysOriginal,
        completedDays: completedSoFar,
        direction: "future",
        remainingFiles,
        binaryFilesList: [...binaryFiles],
        startedAt: isResuming
          ? (loadSession()?.startedAt || new Date().toISOString())
          : new Date().toISOString(),
        lastRunAt: new Date().toISOString(),
      });

      showFutureReminder(remainingDays);
    } else {
      // All days complete — clean up session
      deleteSession();
      showInfo("All days completed! Session file cleaned up.");
    }
  }
}

// Run
main().catch((error) => {
  showError(`Unexpected error: ${error.message}`);
  process.exit(1);
});
