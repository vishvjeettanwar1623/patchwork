/**
 * Distribute files across N days and subdivide each day into micro-commits.
 *
 * Each day gets 1–6 commits, each commit has 1–4 files, and no commit is empty.
 *
 * @param {string[]} files - Sorted list of file paths.
 * @param {number} totalDays - Number of days to spread across.
 * @returns {Array<{ dayIndex: number, commits: Array<{ files: string[] }> }>}
 */
export function chunkCommits(files, totalDays) {
  if (files.length === 0) return [];

  // Clamp days to not exceed file count
  const days = Math.min(totalDays, files.length);

  // Step 1: Divide files across days with natural variance
  const dayChunks = distributeFilesAcrossDays(files, days);

  // Step 2: For each day, split into micro-commits
  const result = [];

  for (let dayIndex = 0; dayIndex < dayChunks.length; dayIndex++) {
    const dayFiles = dayChunks[dayIndex];
    if (dayFiles.length === 0) continue;

    const commits = splitIntoMicroCommits(dayFiles);
    result.push({ dayIndex, commits });
  }

  return result;
}

/**
 * Distribute files roughly evenly across N days with some variance.
 */
function distributeFilesAcrossDays(files, days) {
  const baseCount = Math.floor(files.length / days);
  let remainder = files.length % days;
  const chunks = [];
  let offset = 0;

  for (let i = 0; i < days; i++) {
    // Add some natural variance: some days get +1 file from remainder
    let count = baseCount;
    if (remainder > 0) {
      count++;
      remainder--;
    }

    // Add a little random variance (±1) but keep it non-negative and don't exceed remaining
    const variance = Math.random() < 0.3 ? (Math.random() < 0.5 ? -1 : 1) : 0;
    const remaining = files.length - offset;
    const daysLeft = days - i;
    const minNeeded = daysLeft - 1; // leave at least 1 for remaining days

    count = Math.max(1, Math.min(count + variance, remaining - Math.max(0, minNeeded)));

    chunks.push(files.slice(offset, offset + count));
    offset += count;
  }

  // If there are leftover files (shouldn't happen, but safety), add to last day
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
 * Ensures no commit is empty.
 */
function splitIntoMicroCommits(dayFiles) {
  if (dayFiles.length === 0) return [];

  // Determine how many commits for this day (1–6, but not more than files)
  const maxCommits = Math.min(6, dayFiles.length);
  const commitCount = Math.max(1, Math.floor(Math.random() * maxCommits) + 1);

  const commits = [];
  let offset = 0;

  for (let i = 0; i < commitCount; i++) {
    const remaining = dayFiles.length - offset;
    const commitsLeft = commitCount - i;

    if (remaining <= 0) break;

    // Each commit should have 1–4 files
    let count;
    if (commitsLeft === 1) {
      // Last commit gets everything remaining
      count = remaining;
    } else {
      // Leave at least 1 file for each remaining commit
      const maxForThis = Math.min(4, remaining - (commitsLeft - 1));
      count = Math.max(1, Math.floor(Math.random() * maxForThis) + 1);
    }

    commits.push({ files: dayFiles.slice(offset, offset + count) });
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
