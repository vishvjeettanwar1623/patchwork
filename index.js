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
  showTimelinePreview,
  showProgress,
  showSummary,
  showError,
  showInfo,
} from "./display.js";

import {
  collectInputs,
  askLargeProjectConfirm,
  askProceedWithCommits,
} from "./prompts.js";

import { scanFiles, isBinaryFile } from "./scanner.js";
import { chunkCommits, getTotalCommitCount } from "./chunker.js";
import { selectProgressiveFiles } from "./progressive.js";
import { generateTimestamps, formatTimestamp } from "./timestamps.js";
import { initMessageClient, generateMessage, delay, isAPIAvailable } from "./messages.js";
import {
  setupRepo,
  setupLocalRepo,
  copyFilesToTemp,
  createCommit,
  pushToRemote,
  cleanup,
  syncLocalRepo,
  syncLocalDirectoryGit,
} from "./git.js";

let globalPat = null;

/**
 * Display a sanitized error message to prevent PAT or credential leakage.
 */
function showSanitizedError(message) {
  let cleanMsg = String(message);

  if (globalPat && globalPat.length > 5) {
    const escapedPat = globalPat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleanMsg = cleanMsg.replace(new RegExp(escapedPat, "g"), "[REDACTED_PAT]");
  }

  // Redact credentials in URLs (e.g. https://username:password@github.com)
  cleanMsg = cleanMsg.replace(/(https?:\/\/)[^@\s]+@/gi, "$1");

  showError(cleanMsg);
}

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

  // ──────────────────────────────────────────────
  // Step 1: Collect inputs & options
  // ──────────────────────────────────────────────
  inputs = await collectInputs();
  globalPat = inputs.pat;

  // ──────────────────────────────────────────────
  // Step 2: Scan files
  // ──────────────────────────────────────────────
  const scanResult = scanFiles(inputs.folderPath);
  files = scanResult.files;
  binaryFiles = scanResult.binaryFiles;

  showScanSummary(scanResult.totalCount, scanResult.breakdown, binaryFiles.size);

  if (scanResult.totalCount === 0) {
    showSanitizedError("No files found in the project folder. Nothing to do.");
    process.exit(1);
  }

  // ──────────────────────────────────────────────
  // Step 3: Setup git repo in temp working directory
  // ──────────────────────────────────────────────
  let tempDir;
  let git;
  let isIncremental = false;

  try {
    if (inputs.isLocalMode) {
      const setup = await setupLocalRepo(inputs.folderPath, inputs.username, inputs.email);
      tempDir = setup.tempDir;
      git = setup.git;
      isIncremental = false;
      showInfo(`Initialized local workspace in: ${tempDir}\n`);
    } else {
      const setup = await setupRepo(inputs.repoUrl, inputs.username, inputs.pat, inputs.email);
      tempDir = setup.tempDir;
      git = setup.git;
      isIncremental = setup.isIncremental;
      showInfo(`Working directory: ${tempDir}\n`);
    }
  } catch (error) {
    showSanitizedError(`Failed to initialize git repo: ${error.message}`);
    process.exit(1);
  }

  // Handle Incremental Mode comparison (Remote mode only)
  if (isIncremental) {
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

  // Large project warning
  if (files.length > 200) {
    showLargeProjectWarning(files.length);
    const proceed = await askLargeProjectConfirm();
    if (!proceed) {
      showInfo("Exiting. No changes were made.");
      await cleanup(tempDir);
      process.exit(0);
    }
  }

  // ──────────────────────────────────────────────
  // Step 4: Progressive Evolution Analysis & Chunking
  // ──────────────────────────────────────────────
  let progressiveFiles = new Set();
  if (inputs.enableProgressive) {
    progressiveFiles = selectProgressiveFiles(files, inputs.folderPath, inputs.days);
    if (progressiveFiles.size > 0) {
      showInfo(`Selected ${progressiveFiles.size} complex file(s) for progressive multi-pass commits (scaffold → complete).`);
    }
  }

  chunks = chunkCommits(files, inputs.days, progressiveFiles);
  showCommitPlan(chunks);

  const totalCommits = getTotalCommitCount(chunks);
  showInfo(`Total commits to create: ${totalCommits}\n`);

  // ──────────────────────────────────────────────
  // Step 5: Generate timestamps
  // ──────────────────────────────────────────────
  const timestampedChunks = generateTimestamps(chunks, inputs.startDate);

  // ──────────────────────────────────────────────
  // Step 6: Initialize AI client for commit messages
  // ──────────────────────────────────────────────
  initMessageClient();

  // ──────────────────────────────────────────────
  // Step 7: Pre-generate all commit messages
  // ──────────────────────────────────────────────
  const chunksToProcess = timestampedChunks;
  const allCommits = chunksToProcess.flatMap((day) =>
    day.commits.map((commit) => ({ day, commit }))
  );
  const totalCommitsToCreate = allCommits.length;

  if (totalCommitsToCreate > 0) {
    const useAI = isAPIAvailable();
    const spinnerText = useAI ? "  Generating AI commit messages..." : "  Generating local commit messages...";
    const spinner = ora({
      text: spinnerText,
      color: "cyan",
    }).start();

    try {
      for (let idx = 0; idx < allCommits.length; idx++) {
        const { commit } = allCommits[idx];
        if (useAI && idx > 0) {
          await delay(3000);
        }
        commit.message = await generateMessage(commit.files, inputs.folderPath, commit.fileStages || {});
        const progressLabel = useAI ? "Generating AI commit messages..." : "Generating local commit messages...";
        spinner.text = `  ${progressLabel} (${idx + 1}/${allCommits.length})`;
      }

      const succeedText = useAI ? "  Generated all AI commit messages!" : "  Generated all local commit messages!";
      spinner.succeed(succeedText);
      console.log();
    } catch (error) {
      spinner.fail("  Failed to generate commit messages!");
      showSanitizedError(error.message);
      await cleanup(tempDir);
      process.exit(1);
    }
  }

  // ──────────────────────────────────────────────
  // Step 8: Timeline Preview & Dry-Run Mode
  // ──────────────────────────────────────────────
  showTimelinePreview(timestampedChunks, inputs.isLocalMode);

  if (inputs.isDryRun) {
    showInfo("Dry-run preview complete. No Git commits were created.");
    await cleanup(tempDir);
    process.exit(0);
  }

  const proceedWithExecution = await askProceedWithCommits();
  if (!proceedWithExecution) {
    showInfo("Operation cancelled by user. No Git commits were created.");
    await cleanup(tempDir);
    process.exit(0);
  }

  // ──────────────────────────────────────────────
  // Step 9: Create commits in working repository
  // ──────────────────────────────────────────────
  const commitLog = [];
  let commitIndex = 0;

  try {
    for (const day of chunksToProcess) {
      for (const commit of day.commits) {
        commitIndex++;

        const message = commit.message || "Update project files";

        // Copy files with stage awareness (scaffold vs final)
        await copyFilesToTemp(inputs.folderPath, tempDir, commit.files, commit.fileStages || {});

        // Create the commit with custom timestamp
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
    showSanitizedError(`Failed during commit creation: ${error.message}`);
    await cleanup(tempDir);
    process.exit(1);
  }

  // ──────────────────────────────────────────────
  // Step 10: Finalize (Remote Push vs Local Sync)
  // ──────────────────────────────────────────────
  console.log();
  if (inputs.isLocalMode) {
    const localUpdated = await syncLocalDirectoryGit(inputs.folderPath, tempDir);
    if (localUpdated) {
      showInfo("Local .git repository updated successfully! ✔");
    }
  } else {
    try {
      await pushToRemote(git);
    } catch (error) {
      showSanitizedError(error.message);
      await cleanup(tempDir);
      process.exit(1);
    }

    const synced = await syncLocalRepo(inputs.folderPath, inputs.repoUrl, inputs.username, inputs.pat);
    if (synced) {
      showInfo("Local git synced — your editor's Source Control is now up to date. ✔");
    }
  }

  // ──────────────────────────────────────────────
  // Step 11: Cleanup temp directory
  // ──────────────────────────────────────────────
  await cleanup(tempDir);

  // ──────────────────────────────────────────────
  // Step 12: Show summary
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
}

// Run
main().catch((error) => {
  showSanitizedError(`Unexpected error: ${error.message}`);
  process.exit(1);
});
