/**
 * Distribute files across N days and subdivide each day into micro-commits.
 * Supports progressive file evolution (multi-pass commits).
 *
 * @param {string[]} files - Sorted list of file paths.
 * @param {number} totalDays - Number of days to spread across.
 * @param {Set<string>} [progressiveFiles] - Optional set of files to evolve progressively.
 * @returns {Array<{ dayIndex: number, commits: Array<{ files: string[], fileStages?: Record<string, string> }> }>}
 */
export function chunkCommits(files, totalDays, progressiveFiles = new Set()) {
  if (files.length === 0) return [];

  // Clamp days to not exceed total items to commit
  const days = Math.max(1, Math.min(totalDays, files.length));

  if (days === 1 || !progressiveFiles || progressiveFiles.size === 0) {
    // Standard single-pass distribution
    const dayChunks = distributeFilesAcrossDays(files, days);
    const result = [];

    for (let dayIndex = 0; dayIndex < dayChunks.length; dayIndex++) {
      const dayFiles = dayChunks[dayIndex];
      if (dayFiles.length === 0) continue;

      const commits = splitIntoMicroCommits(dayFiles);
      result.push({ dayIndex, commits });
    }

    return result;
  }

  // Progressive Multi-Pass Distribution:
  // Separate into regular files and progressive files
  const regularFiles = files.filter(f => !progressiveFiles.has(f));
  const progFilesList = Array.from(progressiveFiles);

  // Distribute regular files across days
  const regularDayChunks = distributeFilesAcrossDays(regularFiles, days);

  // Distribute scaffold passes on the first half of days, and final passes on the second half
  const scaffoldDaysCount = Math.max(1, Math.floor(days / 2));
  const finalDaysCount = days - scaffoldDaysCount;

  const scaffoldChunks = distributeFilesAcrossDays(progFilesList, scaffoldDaysCount);
  const finalChunks = distributeFilesAcrossDays(progFilesList, finalDaysCount);

  const result = [];

  for (let dayIndex = 0; dayIndex < days; dayIndex++) {
    const dayFilesWithStages = [];

    // Add regular files for today
    const regularForToday = regularDayChunks[dayIndex] || [];
    for (const f of regularForToday) {
      dayFilesWithStages.push({ file: f, stage: "final" });
    }

    // Add scaffold files if within first half
    if (dayIndex < scaffoldDaysCount) {
      const scaffoldsToday = scaffoldChunks[dayIndex] || [];
      for (const f of scaffoldsToday) {
        dayFilesWithStages.push({ file: f, stage: "scaffold" });
      }
    } else {
      // Add final passes for the progressive files
      const finalIndex = dayIndex - scaffoldDaysCount;
      const finalsToday = finalChunks[finalIndex] || [];
      for (const f of finalsToday) {
        dayFilesWithStages.push({ file: f, stage: "final" });
      }
    }

    if (dayFilesWithStages.length === 0) continue;

    const commits = splitIntoMicroCommitsWithStages(dayFilesWithStages);
    result.push({ dayIndex, commits });
  }

  return result;
}

/**
 * Distribute files roughly evenly across N days with some variance.
 */
function distributeFilesAcrossDays(files, days) {
  if (files.length === 0) return Array.from({ length: days }, () => []);
  if (days <= 1) return [files.slice()];

  const baseCount = Math.floor(files.length / days);
  let remainder = files.length % days;
  const chunks = [];
  let offset = 0;

  for (let i = 0; i < days; i++) {
    let count = baseCount;
    if (remainder > 0) {
      count++;
      remainder--;
    }

    const variance = Math.random() < 0.3 ? (Math.random() < 0.5 ? -1 : 1) : 0;
    const remaining = files.length - offset;
    const daysLeft = days - i;
    const minNeeded = daysLeft - 1;

    count = Math.max(1, Math.min(count + variance, remaining - Math.max(0, minNeeded)));

    chunks.push(files.slice(offset, offset + count));
    offset += count;
  }

  if (offset < files.length) {
    if (chunks.length > 0) {
      chunks[chunks.length - 1].push(...files.slice(offset));
    } else {
      chunks.push(files.slice(offset));
    }
  }

  return chunks;
}

/**
 * Split a day's files into micro-commits (1–4 files each, 1–6 commits per day).
 */
function splitIntoMicroCommits(dayFiles) {
  if (dayFiles.length === 0) return [];

  const maxCommits = Math.min(6, dayFiles.length);
  const commitCount = Math.max(1, Math.floor(Math.random() * maxCommits) + 1);

  const commits = [];
  let offset = 0;

  for (let i = 0; i < commitCount; i++) {
    const remaining = dayFiles.length - offset;
    const commitsLeft = commitCount - i;

    if (remaining <= 0) break;

    let count;
    if (commitsLeft === 1) {
      count = remaining;
    } else {
      const maxForThis = Math.min(4, remaining - (commitsLeft - 1));
      count = Math.max(1, Math.floor(Math.random() * maxForThis) + 1);
    }

    commits.push({ files: dayFiles.slice(offset, offset + count) });
    offset += count;
  }

  return commits;
}

/**
 * Split a day's staged files into micro-commits preserving stage metadata.
 */
function splitIntoMicroCommitsWithStages(dayItems) {
  if (dayItems.length === 0) return [];

  const maxCommits = Math.min(6, dayItems.length);
  const commitCount = Math.max(1, Math.floor(Math.random() * maxCommits) + 1);

  const commits = [];
  let offset = 0;

  for (let i = 0; i < commitCount; i++) {
    const remaining = dayItems.length - offset;
    const commitsLeft = commitCount - i;

    if (remaining <= 0) break;

    let count;
    if (commitsLeft === 1) {
      count = remaining;
    } else {
      const maxForThis = Math.min(4, remaining - (commitsLeft - 1));
      count = Math.max(1, Math.floor(Math.random() * maxForThis) + 1);
    }

    const items = dayItems.slice(offset, offset + count);
    const files = items.map(item => item.file);
    const fileStages = {};
    for (const item of items) {
      fileStages[item.file] = item.stage;
    }

    commits.push({ files, fileStages });
    offset += count;
  }

  return commits;
}

/**
 * Get total commit count across all days.
 */
export function getTotalCommitCount(chunks) {
  return chunks.reduce((sum, day) => sum + day.commits.length, 0);
}
