import assert from "assert";
import { isEligibleForProgressiveEvolution, generateScaffoldContent, selectProgressiveFiles } from "./progressive.js";
import { chunkCommits, getTotalCommitCount } from "./chunker.js";
import { generateTimestamps } from "./timestamps.js";
import { generateMessage } from "./messages.js";

console.log("🧪 Running feature verification tests...\n");

// 1. Test Progressive Evolution Scaffold Generation
console.log("1. Testing Progressive Scaffold Generator...");
const sampleCode = `import fs from "fs";
import path from "path";

export class AuthService {
  constructor(config) {
    this.config = config;
  }

  async login(username, password) {
    if (!username || !password) throw new Error("Missing credentials");
    return { token: "sample_jwt_token" };
  }

  async logout(token) {
    return true;
  }
}
`;

const scaffold = generateScaffoldContent(sampleCode, "src/auth.js");
assert(scaffold.includes('import fs from "fs"'), "Scaffold must preserve imports");
assert(scaffold.includes('AuthService'), "Scaffold must preserve main class signature");
console.log("✔ Scaffold generation test passed!");

// 2. Test Chunker with Progressive File Multi-Pass
console.log("\n2. Testing Multi-Pass Chunker...");
const mockFiles = [
  "package.json",
  "index.js",
  "src/auth.js",
  "src/db.js",
  "src/routes.js",
  "README.md"
];
const progressiveFiles = new Set(["src/auth.js", "src/db.js"]);
const chunks = chunkCommits(mockFiles, 3, progressiveFiles);

assert(chunks.length === 3, "Chunks must span 3 days");
const totalCommits = getTotalCommitCount(chunks);
assert(totalCommits >= 3, "Should have at least 3 commits across days");

let foundScaffold = false;
let foundFinal = false;
for (const day of chunks) {
  for (const commit of day.commits) {
    if (commit.fileStages?.["src/auth.js"] === "scaffold") foundScaffold = true;
    if (commit.fileStages?.["src/auth.js"] === "final") foundFinal = true;
  }
}
assert(foundScaffold, "Must contain Pass 1 scaffold commit for progressive file");
assert(foundFinal, "Must contain Pass 2 final commit for progressive file");
console.log("✔ Multi-pass progressive chunking test passed!");

// 3. Test Message Generation for Progressive Stages
console.log("\n3. Testing Stage-Aware Fallback Message Generation...");
const scaffoldMsg = await generateMessage(["chunker.js"], process.cwd(), { "chunker.js": "scaffold" });
assert(scaffoldMsg.toLowerCase().includes("scaffold"), `Scaffold message should mention scaffold, got: ${scaffoldMsg}`);

const finalMsg = await generateMessage(["chunker.js"], process.cwd(), { "chunker.js": "final" });
assert(finalMsg.toLowerCase().includes("feat") || finalMsg.toLowerCase().includes("complete") || finalMsg.toLowerCase().includes("implement"), `Final message should be feat/complete, got: ${finalMsg}`);
console.log("✔ Stage-aware message generation test passed!");

console.log("\n✨ All test assertions succeeded!");
