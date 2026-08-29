/**
 * Scores the stance judge against a fixed set of studies whose conclusions
 * have been read by hand.
 *
 * Usage:  node scripts/stance-eval.mjs [http://localhost:8788]
 *
 * It drives the running instance through /api/check-claim with a pinned
 * query, so it measures whatever backend that instance is configured for.
 */
import { readFileSync, readdirSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:8788";
const files = readdirSync("eval").filter((f) => f.endsWith(".json"));

const SYMBOL = { supports: "FOR ", contradicts: "AGST", neutral: "neut", unassessed: "--  " };

let totalCorrect = 0;
let totalScored = 0;

for (const file of files) {
  const fixture = JSON.parse(readFileSync(`eval/${file}`, "utf8"));
  process.stdout.write(`\n${file}: "${fixture.claim}"\n`);

  const res = await fetch(`${base}/api/check-claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ claim: fixture.claim, query: fixture.query }),
  });
  if (!res.ok) {
    console.error(`  request failed: ${res.status} ${await res.text()}`);
    process.exitCode = 1;
    continue;
  }
  const result = await res.json();
  const got = new Map(result.studies.map((s) => [s.pmid, s.stance]));

  let correct = 0;
  let scored = 0;
  const confusion = {};

  for (const [pmid, expected] of Object.entries(fixture.truth)) {
    const actual = got.get(pmid);
    if (actual === undefined) {
      console.log(`  ${pmid}  not returned by this search`);
      continue;
    }
    scored += 1;
    const hit = actual === expected.stance;
    if (hit) correct += 1;
    confusion[`${expected.stance}->${actual}`] = (confusion[`${expected.stance}->${actual}`] ?? 0) + 1;
    console.log(
      `  ${pmid}  expected ${SYMBOL[expected.stance]}  got ${SYMBOL[actual] ?? actual}  ${hit ? "ok " : "MISS"}  ${expected.why.slice(0, 52)}`,
    );
  }

  totalCorrect += correct;
  totalScored += scored;
  console.log(`  score: ${correct}/${scored}`);
  const misses = Object.entries(confusion).filter(([k]) => k.split("->")[0] !== k.split("->")[1]);
  if (misses.length) console.log(`  misses: ${misses.map(([k, n]) => `${k} x${n}`).join(", ")}`);
  console.log(`  verdict: ${result.verdict.labelText} / ${result.direction.directionText}`);
}

console.log(`\nTOTAL ${totalCorrect}/${totalScored}`);
if (totalScored === 0) process.exitCode = 1;
