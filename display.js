import chalk from "chalk";

const CYAN = chalk.cyan;
const GREEN = chalk.green;
const YELLOW = chalk.yellow;
const RED = chalk.red;
const DIM = chalk.dim;
const BOLD = chalk.bold;
const WHITE = chalk.white;

/**
 * Show the PatchWork ASCII banner and tagline.
 */
export function showBanner() {
  console.log();
  console.log(
    CYAN(`
  ██████╗  █████╗ ████████╗ ██████╗██╗  ██╗██╗    ██╗ ██████╗ ██████╗ ██╗  ██╗
  ██╔══██╗██╔══██╗╚══██╔══╝██╔════╝██║  ██║██║    ██║██╔═══██╗██╔══██╗██║ ██╔╝
  ██████╔╝███████║   ██║   ██║     ███████║██║ █╗ ██║██║   ██║██████╔╝█████╔╝ 
  ██╔═══╝ ██╔══██║   ██║   ██║     ██╔══██║██║███╗██║██║   ██║██╔══██╗██╔═██╗ 
  ██║     ██║  ██║   ██║   ╚██████╗██║  ██║╚███╔███╔╝╚██████╔╝██║  ██║██║  ██╗
  ╚═╝     ╚═╝  ╚═╝   ╚═╝    ╚═════╝╚═╝  ╚═╝ ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝
    `)
  );
  console.log(DIM("  Spread your code. Look human.\n"));
}

/**
 * Show the file scan summary.
 */
export function showScanSummary(totalCount, breakdown, binaryCount) {
  console.log();
  console.log(BOLD(WHITE("  📂 Scan Results")));
  console.log(DIM("  ─────────────────────────────────"));
  console.log(`  ${GREEN("Total files:")}        ${BOLD(totalCount)}`);
  console.log(
    `  ${DIM("Config:")}             ${breakdown.config}`
  );
  console.log(
    `  ${DIM("Entry points:")}       ${breakdown.entryPoints}`
  );
  console.log(
    `  ${DIM("Source:")}             ${breakdown.source}`
  );
  console.log(
    `  ${DIM("Features:")}           ${breakdown.features}`
  );
  console.log(
    `  ${DIM("Tests:")}              ${breakdown.tests}`
  );
  console.log(
    `  ${DIM("Docs:")}               ${breakdown.docs}`
  );
  if (binaryCount > 0) {
    console.log(
      `  ${YELLOW("Binary files:")}       ${binaryCount} ${DIM("(will not be sent to AI)")}`
    );
  }
  console.log();
}

/**
 * Show a large project warning.
 */
export function showLargeProjectWarning(count) {
  console.log();
  console.log(
    YELLOW(
      `  ⚠  This project contains ${BOLD(count)} files. Commit spreading may take`
    )
  );
  console.log(
    YELLOW("     longer and generate many API calls.")
  );
  console.log();
}

/**
 * Show a preview of how commits are distributed across days.
 */
export function showCommitPlan(chunks) {
  console.log();
  console.log(BOLD(WHITE("  📋 Commit Plan")));
  console.log(DIM("  ─────────────────────────────────"));
  for (const day of chunks) {
    const fileCount = day.commits.reduce(
      (sum, c) => sum + c.files.length,
      0
    );
    console.log(
      `  ${DIM("Day " + (day.dayIndex + 1))}  →  ${GREEN(day.commits.length + " commits")}  ${DIM("(" + fileCount + " files)")}`
    );
  }
  console.log();
}

/**
 * Show detailed timeline preview (Dry-Run / Preview Mode).
 */
export function showTimelinePreview(timestampedChunks, isLocalMode = false) {
  console.log();
  console.log(BOLD(CYAN("  🔍 Interactive Commit Timeline Preview")));
  console.log(DIM("  ═════════════════════════════════════════════════════════════════════"));
  if (isLocalMode) {
    console.log(YELLOW("  Mode: Local-Only (Offline Git repository creation — no remote push)"));
  } else {
    console.log(CYAN("  Mode: Remote Push (GitHub sync)"));
  }
  console.log(DIM("  ─────────────────────────────────────────────────────────────────────"));

  for (const day of timestampedChunks) {
    const firstTimestamp = day.commits[0]?.timestamp;
    const dateStr = firstTimestamp ? new Date(firstTimestamp).toISOString().split("T")[0] : `Day ${day.dayIndex + 1}`;
    
    console.log();
    console.log(`  📅 ${BOLD(WHITE(`Day ${day.dayIndex + 1}`))} ${DIM(`(${dateStr})`)} — ${GREEN(`${day.commits.length} commit(s)`)}`);

    for (let cIdx = 0; cIdx < day.commits.length; cIdx++) {
      const commit = day.commits[cIdx];
      const isLastCommit = cIdx === day.commits.length - 1;
      const branchPrefix = isLastCommit ? "  └──" : "  ├──";
      const subPrefix = isLastCommit ? "     " : "  │  ";

      const timeStr = commit.timestamp ? new Date(commit.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      const message = commit.message || "Commit changes";

      console.log(`${branchPrefix} ${YELLOW(timeStr)} ${BOLD(WHITE(message))}`);

      // List files
      for (const file of commit.files) {
        const stage = commit.fileStages?.[file];
        let stageTag = "";
        if (stage === "scaffold") {
          stageTag = ` ${CYAN("[pass 1: scaffold]")}`;
        } else if (stage === "final" && commit.fileStages) {
          stageTag = ` ${GREEN("[pass 2: complete]")}`;
        }
        console.log(`${subPrefix}   ${DIM("•")} ${DIM(file)}${stageTag}`);
      }
    }
  }

  console.log();
  console.log(DIM("  ═════════════════════════════════════════════════════════════════════"));
  console.log();
}

/**
 * Show live progress during commit creation.
 */
export function showProgress(current, total, message) {
  const pct = Math.round((current / total) * 100);
  const bar = "█".repeat(Math.round(pct / 4)) + "░".repeat(25 - Math.round(pct / 4));
  process.stdout.write(
    `\r  ${CYAN(bar)} ${DIM(pct + "%")} ${DIM("·")} ${message}    `
  );
  if (current === total) {
    console.log();
  }
}

/**
 * Show the final summary after a successful push.
 */
export function showSummary(results) {
  console.log();
  console.log(DIM("  ═══════════════════════════════════════════════════════════"));
  console.log(BOLD(GREEN("  ✅ Push Complete")));
  console.log(DIM("  ═══════════════════════════════════════════════════════════"));
  console.log();
  console.log(`  ${BOLD("Total commits:")}    ${GREEN(results.totalCommits)}`);
  console.log(
    `  ${BOLD("Date range:")}       ${results.dateRange}`
  );
  console.log();
  console.log(BOLD(WHITE("  Commit Log")));
  console.log(
    DIM("  ────────────────────────────────────────────────────────")
  );
  console.log(
    `  ${DIM("Date")}          ${DIM("Time")}      ${DIM("Message")}                              ${DIM("Files")}`
  );
  console.log(
    DIM("  ────────────────────────────────────────────────────────")
  );

  for (const entry of results.log) {
    const date = DIM(entry.date);
    const time = DIM(entry.time);
    const msg = WHITE(entry.message.substring(0, 40).padEnd(40));
    const files = CYAN(entry.fileCount.toString());
    console.log(`  ${date}  ${time}  ${msg} ${files}`);
  }

  console.log();
  console.log(
    BOLD(CYAN("  Your contributions are drifting. 🌊"))
  );
  console.log();
}

/**
 * Show a styled error message.
 */
export function showError(message) {
  console.log();
  console.log(RED(`  ✖ ${message}`));
  console.log();
}

/**
 * Show a styled warning message.
 */
export function showWarning(message) {
  console.log(YELLOW(`  ⚠ ${message}`));
}

/**
 * Show a reminder for future mode.
 */


/**
 * Show info message.
 */
export function showInfo(message) {
  console.log(CYAN(`  ℹ ${message}`));
}
