/**
 * Generate realistic commit timestamps for each micro-commit.
 *
 * Working hours: 10:00 AM – 1:00 AM (next day).
 * Commits are loosely clustered with random gaps.
 *
 * @param {Array<{ dayIndex: number, commits: Array<{ files: string[] }> }>} chunks
 * @param {Date} startDate - The starting date of the commit sequence.
 * @returns {Array<{ dayIndex: number, commits: Array<{ files: string[], timestamp: string }> }>}
 */
export function generateTimestamps(chunks, startDate) {
  const baseDate = new Date(startDate);
  baseDate.setHours(0, 0, 0, 0);

  return chunks.map((day) => {
    // Calculate the actual date for this day
    const date = new Date(baseDate);
    date.setDate(date.getDate() + day.dayIndex);

    // Generate timestamps for all commits on this day
    const timestamps = generateDayTimestamps(date, day.commits.length);

    return {
      dayIndex: day.dayIndex,
      commits: day.commits.map((commit, i) => ({
        ...commit,
        timestamp: timestamps[i],
      })),
    };
  });
}

/**
 * Generate N timestamps for a single day, loosely clustered within working hours.
 *
 * Working hours: 10:00 AM – 1:00 AM next day (15-hour window = 900 minutes).
 *
 * @param {Date} date - The base date (midnight).
 * @param {number} count - Number of timestamps to generate.
 * @returns {string[]} ISO 8601 timestamp strings.
 */
function generateDayTimestamps(date, count) {
  if (count === 0) return [];

  // Working hours start: 10:00 AM (600 minutes from midnight)
  // Working hours end: 1:00 AM next day (1500 minutes from midnight, or 25 * 60)
  const workStart = 600; // 10:00 AM in minutes
  const workEnd = 1500; // 1:00 AM next day in minutes

  const totalWindow = workEnd - workStart; // 900 minutes

  // Pick a random "session start" within the first half of the window
  const sessionStart = workStart + Math.floor(Math.random() * (totalWindow * 0.3));

  const timestamps = [];
  let currentMinute = sessionStart;

  for (let i = 0; i < count; i++) {
    // Add random gap between commits: 5–90 minutes
    if (i > 0) {
      const gap = 5 + Math.floor(Math.random() * 86); // 5–90 minutes
      currentMinute += gap;
    }

    // Ensure we don't go past end of working hours
    if (currentMinute > workEnd) {
      currentMinute = workEnd - Math.floor(Math.random() * 30);
    }

    // Add random second offset
    const seconds = Math.floor(Math.random() * 60);

    // Calculate the actual hours and minutes
    const hours = Math.floor(currentMinute / 60);
    const minutes = currentMinute % 60;

    // Create the timestamp
    const ts = new Date(date);
    ts.setHours(hours, minutes, seconds, 0);

    timestamps.push(toLocalISOString(ts));
  }

  return timestamps;
}

/**
 * Formats a Date object to an ISO 8601 string preserving the local timezone offset.
 *
 * @param {Date} date
 * @returns {string} e.g. "2026-07-16T21:30:00+05:30"
 */
function toLocalISOString(date) {
  const pad = (num) => String(num).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  
  const timezoneOffset = -date.getTimezoneOffset();
  const sign = timezoneOffset >= 0 ? '+' : '-';
  const offsetHours = pad(Math.floor(Math.abs(timezoneOffset) / 60));
  const offsetMinutes = pad(Math.abs(timezoneOffset) % 60);
  
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offsetHours}:${offsetMinutes}`;
}

/**
 * Format a timestamp for display in the summary.
 *
 * @param {string} isoString
 * @returns {{ date: string, time: string }}
 */
export function formatTimestamp(isoString) {
  const d = new Date(isoString);
  const pad = (num) => String(num).padStart(2, '0');
  
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  
  let hours = d.getHours();
  const minutes = pad(d.getMinutes());
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12; // convert hour '0' to '12'
  const formattedHours = pad(hours);
  
  return {
    date: `${year}-${month}-${day}`,
    time: `${formattedHours}:${minutes} ${ampm}`
  };
}
