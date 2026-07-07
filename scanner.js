import fs from "fs";
import path from "path";
import { execSync } from "child_process";

/**
 * Directories to completely skip during scanning.
 */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  "bin",
  "obj",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".docusaurus",
  "venv",
  ".venv",
  "env",
  ".env",
  "virtualenv",
  "__pycache__",
  ".pytest_cache",
  ".turbo",
  ".idea",
  ".vscode",
  "gen",
]);

/**
 * File names/patterns to exclude.
 */
const EXCLUDED_FILES = new Set([".DS_Store", ".env"]);

/**
 * File extensions that indicate a lock file.
 */
function isLockFile(filename) {
  return filename.endsWith(".lock") || filename === "package-lock.json" || filename === "yarn.lock" || filename === "pnpm-lock.yaml";
}

/**
 * Binary file extensions — these files are committed but never have content read for AI.
 */
const BINARY_EXTENSIONS = new Set([
  // Images
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".bmp", ".tiff", ".tif",
  // Fonts
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  // Compiled
  ".pyc", ".class", ".o", ".so", ".dll", ".dylib",
  // Archives
  ".zip", ".tar", ".gz", ".rar", ".7z", ".bz2",
  // Executables
  ".exe", ".bin", ".msi",
  // Media
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".flv", ".wmv", ".ogg", ".flac",
  // Documents
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  // Databases
  ".sqlite", ".db",
  // Other
  ".wasm",
]);

/**
 * Check if a file is binary based on its extension.
 */
export function isBinaryFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Get the priority category of a file for sorting.
 * Lower number = committed first.
 *
 * 0 = Config files
 * 1 = Entry points
 * 2 = Core source (src/**, lib/**)
 * 3 = Feature/component files
 * 4 = Tests
 * 5 = Docs
 */
function getFilePriority(relativePath) {
  const filename = path.basename(relativePath).toLowerCase();
  const dir = relativePath.replace(/\\/g, "/").toLowerCase();

  // Priority 0: Config files
  if (
    filename === "package.json" ||
    filename === ".env.example" ||
    filename === "tsconfig.json" ||
    filename.includes(".config.") ||
    filename.match(/^\.\w+rc(\.\w+)?$/)
  ) {
    return 0;
  }

  // Priority 5: Docs (check before entry points since README could match index.*)
  if (
    filename.startsWith("readme") ||
    filename.startsWith("license") ||
    filename.startsWith("changelog") ||
    filename.endsWith(".md") ||
    dir.startsWith("docs/")
  ) {
    return 5;
  }

  // Priority 4: Tests
  if (
    filename.includes(".test.") ||
    filename.includes(".spec.") ||
    dir.startsWith("__tests__/") ||
    dir.startsWith("test/") ||
    dir.startsWith("tests/")
  ) {
    return 4;
  }

  // Priority 1: Entry points
  if (
    filename.match(/^index\./) ||
    filename.match(/^main\./) ||
    filename.match(/^app\./) ||
    filename.match(/^server\./)
  ) {
    return 1;
  }

  // Priority 2: Core source
  if (dir.startsWith("src/") || dir.startsWith("lib/")) {
    return 2;
  }

  // Priority 3: Everything else
  return 3;
}

/**
 * Get the category name for display purposes.
 */
function getCategoryName(priority) {
  const names = {
    0: "config",
    1: "entryPoints",
    2: "source",
    3: "features",
    4: "tests",
    5: "docs",
  };
  return names[priority] || "features";
}

/**
 * Scan the folder using git ls-files if it is a git repository.
 * Honors .gitignore rules perfectly.
 * Returns null if not a git repository or git fails.
 */
function scanFilesWithGit(folderPath) {
  try {
    const gitBin = process.platform === "win32" ? "git.exe" : "git";
    const output = execSync(`${gitBin} ls-files --others --cached --exclude-standard`, {
      cwd: folderPath,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Recursively scan a directory and return sorted, filtered file list.
 */
export function scanFiles(folderPath) {
  const files = [];
  const binaryFiles = new Set();
  const breakdown = {
    config: 0,
    entryPoints: 0,
    source: 0,
    features: 0,
    tests: 0,
    docs: 0,
  };

  const gitFiles = scanFilesWithGit(folderPath);

  if (gitFiles !== null) {
    for (const relativePath of gitFiles) {
      const filename = path.basename(relativePath);

      if (EXCLUDED_FILES.has(filename)) continue;
      if (isLockFile(filename)) continue;

      const normalized = relativePath.replace(/\\/g, "/");
      files.push(normalized);

      if (isBinaryFile(filename)) {
        binaryFiles.add(normalized);
      }

      const priority = getFilePriority(normalized);
      const category = getCategoryName(priority);
      breakdown[category]++;
    }
  } else {
    function walk(dir, relativeBase) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.join(relativeBase, entry.name);

        if (entry.isDirectory()) {
          if (EXCLUDED_DIRS.has(entry.name)) continue;
          walk(fullPath, relativePath);
        } else if (entry.isFile()) {
          if (EXCLUDED_FILES.has(entry.name)) continue;
          if (isLockFile(entry.name)) continue;

          const normalized = relativePath.replace(/\\/g, "/");
          files.push(normalized);

          if (isBinaryFile(entry.name)) {
            binaryFiles.add(normalized);
          }

          const priority = getFilePriority(normalized);
          const category = getCategoryName(priority);
          breakdown[category]++;
        }
      }
    }
    walk(folderPath, "");
  }

  files.sort((a, b) => {
    const pa = getFilePriority(a);
    const pb = getFilePriority(b);
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });

  return {
    files,
    breakdown,
    binaryFiles,
    totalCount: files.length,
  };
}
