import { execSync } from "child_process";

try {
  const gitBin = process.platform === "win32" ? "git.exe" : "git";
  console.log(`Running execSync('${gitBin} ls-files --others --cached --exclude-standard')...`);
  const output = execSync(`${gitBin} ls-files --others --cached --exclude-standard`, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  console.log("Stdout:", JSON.stringify(output));
} catch (error) {
  console.error("Error occurred:", error);
}
