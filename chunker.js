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
