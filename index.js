#!/usr/bin/env node

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, ".env") });

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

import { scanFiles } from "./scanner.js";
import { chunkCommits, getTotalCommitCount } from "./chunker.js";
import { generateTimestamps, formatTimestamp } from "./timestamps.js";
import { initMessageClient, generateMessage, delay } from "./messages.js";
import { setupRepo, copyFilesToTemp, createCommit, pushToRemote, cleanup } from "./git.js";
import { sessionExists, loadSession, saveSession, deleteSession } from "./session.js";

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

    // Large project warning
    if (scanResult.totalCount > 200) {
      showLargeProjectWarning(scanResult.totalCount);
      const proceed = await askLargeProjectConfirm();
      if (!proceed) {
        showInfo("Exiting. No changes were made.");
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
  // Step 7: Setup git repo in temp directory
  // ──────────────────────────────────────────────
  let tempDir;
  let git;

  try {
    const setup = await setupRepo(inputs.repoUrl, inputs.username, inputs.pat);
    tempDir = setup.tempDir;
    git = setup.git;
    showInfo(`Working directory: ${tempDir}\n`);
  } catch (error) {
    showError(`Failed to initialize git repo: ${error.message}`);
    process.exit(1);
  }

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

  try {
    for (const day of chunksToProcess) {
      for (const commit of day.commits) {
        commitIndex++;

        // Generate commit message
        const message = await generateMessage(commit.files, inputs.folderPath);
        await delay(200);

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

        showProgress(commitIndex, getTotalCommitCount(chunksToProcess), message);
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
  try {
    await pushToRemote(git);
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
