#!/usr/bin/env node
// bin.cjs - CommonJS wrapper that suppresses the punycode deprecation warning
// before the ESM entry point (index.js) loads its dependencies.
//
// The warning fires during Node's ESM module-graph resolution phase,
// which runs before any top-level module code. The only way to intercept
// it is to patch process.emitWarning in a CJS file that runs first.

const _emitWarning = process.emitWarning.bind(process);

process.emitWarning = function (warning, ...args) {
  const msg = typeof warning === "string" ? warning : warning?.message ?? "";
  // Suppress only the known punycode deprecation (DEP0040).
  if (msg.includes("punycode")) return;
  return _emitWarning(warning, ...args);
};

import("./index.js").catch((err) => {
  console.error(err);
  process.exit(1);
});
