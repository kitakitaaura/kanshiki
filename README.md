# Kanshiki 鑑識 by KitaKita


Paste a health claim. Kanshiki finds what has actually been published about it on
PubMed, grades that evidence against a fixed study-quality hierarchy, and writes a
short, honest summary with every source linked.

It gives no diagnosis and no personal medical advice.

## How it works

```
claim text
  ↓  AI call #1  - extract one testable claim + a PubMed query
PubMed E-utilities  - esearch → esummary → efetch (abstracts)
  ↓  classify      - publication type → evidence tier
  ↓  score         - strength, pure function, no AI (src/scoring.js)
  ↓  AI call #2    - stance per study: supports / contradicts / neutral
  ↓  score         - direction, pure function, weighted by the same tiers
  ↓  AI call #3    - plain-English verdict over the graded, stanced list
  ↓  report        - funding mix, timeline, contradiction spotlight (all pure)
JSON → browser
```

## Two badges

**Strength** answers *how good is the research that exists on this topic* - study designs,
how many, how recent. **Direction** answers *which way does that research point*, weighted
by the same quality tiers, so a meta-analysis outvotes five case reports.

They are independent, because the interesting cases need both:

| Claim | Strength | Direction |
| --- | --- | --- |
| Ivermectin treats COVID-19 | Strong evidence | Contradicted by the evidence |
| Vitamin D cures depression | Strong evidence | Mixed evidence |

Direction stays **unassessed** unless studies carrying at least 30% of the total weight got a
for-or-against stance - no direction is claimed from a handful of judgements. Stance
classification is batched 4 studies per call (small local models default everything to
"neutral" when handed a long list); anything the model skips or mislabels counts as no vote,
never as agreement.

| File | Role |
| --- | --- |
| `functions/api/check-claim.js` | The `POST /api/check-claim` route |
| `functions/api/health.js` | `GET /api/health` - which AI backend is live |
| `src/pipeline.js` | Orchestration, prompts, non-AI fallbacks |
| `src/pubmed.js` | E-utilities client, abstract parsing, sample-size sniffing |
| `src/classify.js` | Publication type → evidence tier |
| `src/funding.js` | Funding statement → industry / public / mixed / undisclosed |
| `src/studyInspector.js` | Kantei: reference parsing, single-study fetch, retraction, summary |
| `src/metrics.js` | OpenAlex client with a Semantic Scholar fallback |
| `src/credibility.js` | Study-level credibility signals (pure, `CREDIBILITY_CONFIG`) |
| `src/citations.js` | APA / MLA / Chicago / BibTeX formatting (pure) |
| `src/scoring.js` | The hierarchy, weights, thresholds, gates (pure) |
| `src/ai.js` | `getAIResponse()` - Ollama or Workers AI, one shape out |
| `public/` | Static frontend (vanilla JS, no build step) |

## Self-hosting (the recommended way to use this)

Kanshiki is built to run on your own machine. Free forever, no rate limits, and the claims you
check never leave your computer.

```bash
git clone https://github.com/kitakitaaura/kanshiki.git && cd kanshiki
./setup.sh
```

The script checks Node and Ollama, starts Ollama if it is not running, pulls the model if it is
missing, installs dependencies, writes `.dev.vars` with working defaults, runs the tests, and
starts the app on http://localhost:8788. It installs nothing without telling you and is safe to
re-run.

**Prerequisites:** Node 18 or newer, and [Ollama](https://ollama.com/download). The script tells
you how to install Ollama for your platform if it is missing.

**First run** downloads the model, about 4.9GB, once. After that startup is immediate. The first
claim you check is slow while the model loads into memory (up to a minute), then settles to
roughly 15 to 30 seconds depending on your hardware.

### Choosing a model

Measured with `npm run eval` against the bundled fixture, which scores stance judgements against
each paper's own stated conclusion:

| Model | Size | Score | Notes |
| --- | --- | --- | --- |
| `llama3.1:8b` | 4.9GB | 7/8 | Default. Matches the hosted demo exactly. |
| `llama3.2` | 2.0GB | 5/8 | Half the size. Use it on low-spec machines. |

Change `OLLAMA_MODEL` in `.dev.vars`, restart, and run `npm run eval` to see the difference on
your own hardware. Any Ollama chat model works.

### What self-hosting actually gets you

- **No rate limits.** The limiter only activates when `DEPLOY_MODE=demo`. A self-hosted instance
  has no limit at all, and a test asserts it.
- **Nothing leaves your machine except the PubMed search.** Claim text goes to your local model.
  PubMed sees the search query, as it must to return studies.
- **No Cloudflare account, ever.** With `LOCAL_MODE=true` the Workers AI code path is unreachable,
  not merely unused. Four tests prove it, including one that supplies a working AI binding and
  asserts it is never called.
- **No ongoing cost.** Your electricity, your hardware, your pace.

### Environment variables

Only the first group matters when self-hosting. `.dev.vars.example` is split the same way.

| Variable | Self-host | Purpose |
| --- | --- | --- |
| `LOCAL_MODE` | **yes** | `true` for Ollama. Anything else uses Workers AI. |
| `OLLAMA_URL`, `OLLAMA_MODEL` | **yes** | Which local model to use. |
| `NCBI_API_KEY`, `NCBI_EMAIL` | optional | Raises NCBI's limit from 3 to 10 requests/second. |
| `REQUEST_TIMEOUT_SECONDS` | optional | Raise it if your machine is slow. Default 180 self-hosted. |
| `WORKERS_AI_MODEL` | demo only | Ignored when `LOCAL_MODE=true`. |
| `DEPLOY_MODE`, `RATE_LIMIT_*` | demo only | Rate limiting stays off unless `DEPLOY_MODE=demo`. |
| `OPENALEX_MAILTO` | optional | Identifies your instance to OpenAlex for faster responses. |

Switching between modes is an env var change and a restart. No code changes.

## The AI toggle

The header carries an **AI / No AI** switch, defaulting to on. Turning it off opens a
dialog spelling out the trade-off before it applies; turning it back on needs no
confirmation. A banner stays visible while it is off.

The dialog opens by saying why the option exists: plenty of researchers would rather no
language model went near their conclusions, and that is a reasonable position - model
judgements are not reproducible the way a fixed scoring rule is, they can be confidently
wrong, and auditing them means re-reading every abstract yourself. The switch lets you keep
the deterministic half of Kanshiki and leave the rest.

With AI off the browser sends `useAi: false` and the server takes the deterministic
branches directly - it does not attempt a call and let it fail, so nothing is logged as an
error and no time is spent on a doomed request. The response carries `meta.aiDisabled`,
which the UI uses to say "AI is switched off" rather than "the model was unavailable".

| | AI on | AI off |
| --- | --- | --- |
| Evidence strength grade, gates, score | ✅ | ✅ |
| Timeline, funding, retraction | ✅ | ✅ |
| Credibility, citation/venue stats, all four citation formats | ✅ | ✅ |
| Direction badge and contradiction spotlight | ✅ | "Direction not assessed" |
| Written summaries | ✅ | Metadata sentence / raw abstract |
| PubMed query | Model-extracted | Keyword fallback (broader, cruder) |
| Time per claim | ~20s | ~2s |

## For researchers (v2.5)

**Reference manager export.** RIS alongside APA, MLA, Chicago, and BibTeX, per study and as one
file for a whole claim. RIS imports into Zotero, EndNote, and Mendeley. Abbreviated PubMed page
ranges are expanded (`637-41` becomes SP 637, EP 641), and retracted papers carry an `N1` note.

**Report export.** CSV with one row per study (title, authors, journal, year, tier, sample size,
direction, funding, retraction, DOI, PubMed link), and a printable report covering the verdict,
gate explanations, funding, timeline, spotlight, and full source table. The PDF comes from the
browser's own print dialog rather than a bundled library, which keeps the frontend build-free.
Optional sections are omitted when absent rather than rendered empty.

**Editable query.** The PubMed query is visible on every result and editable before or after a
run. A query you type is passed to PubMed verbatim, field tags and boolean operators included,
and never re-processed through AI extraction. `queryMode` records which path produced it.

**Collections.** Client-side only, in browser storage, no account. Add claims or studies, export
the set as RIS, CSV, or a printable report, and back it up as JSON. Import replaces wholesale so
a round trip cannot duplicate; a test asserts export, clear, and import returns identical state.

**Related claims.** A lexical near-match against claims checked earlier on this device, shown as
a suggestion. It never alters or replaces the result.

**API.** Documented at `/api.html`, linked from the footer.

## Tests

```bash
npm test
```

215 tests covering the scoring hierarchy and its gates, direction aggregation and its
quality weighting, both classifiers (publication type and funding source, the latter
against fixture statements), timeline checkpoints and the sparse-history skip, spotlight
selection and tie-breaks, both AI backends (against a mock Ollama server and a mock
Workers AI binding), stance parsing including malformed model replies, and every fallback
path. It also covers reference parsing (PubMed URL, PMID, DOI, malformed input), citation
formatting for full and sparse metadata in all four styles, the OpenAlex → Semantic
Scholar → unavailable ladder, the retraction override, and the cached click-through.
Several tests exist purely to assert that funding, partial-read, and retraction flags
never move a claim score.

## Deploying the public demo

This is the secondary path: a hosted instance so someone can try Kanshiki in a browser without
installing anything. It runs on Workers AI and is rate limited, because it spends a shared free
tier on behalf of whoever visits.

```bash
npx wrangler pages deploy public
```

Set `DEPLOY_MODE=demo` to activate rate limiting and the "this is a demo, self-host for unlimited
use" notice. `wrangler.toml` already declares the Workers AI binding (`[ai] binding = "AI"`) and sets
`LOCAL_MODE = "false"`, so the deployed app uses Workers AI. Set secrets/vars in the Pages
dashboard or with `wrangler pages secret put`:

| Variable | Purpose |
| --- | --- |
| `LOCAL_MODE` | `"true"` → Ollama, anything else → Workers AI |
| `OLLAMA_URL`, `OLLAMA_MODEL` | Local dev only |
| `WORKERS_AI_MODEL` | Defaults to `@cf/meta/llama-3.1-8b-instruct` |
| `NCBI_API_KEY` | Optional; raises NCBI's limit from 3 to 10 req/s |
| `NCBI_TOOL`, `NCBI_EMAIL` | Identifies the caller to NCBI, as they request |
| `PUBMED_RETMAX` | Studies fetched per claim (default 20) |

### Speed

Three model calls plus PubMed means roughly 10–20s per claim on a local 3B model
(faster once it is warm). The stance chunks are issued in parallel, but Ollama serializes
them by default - start it with `OLLAMA_NUM_PARALLEL=3 ollama serve` to get real
concurrency, or lower `STUDIES_FOR_STANCE` in `src/pipeline.js`.

## Tuning the grade

Everything that decides a verdict lives in config objects in `src/scoring.js`
(`SCORING_CONFIG`, `DIRECTION_CONFIG`, `FUNDING_CONFIG`, `TIMELINE_CONFIG`), plus
`STANCE_CONFIG` in `src/pipeline.js` and `FUNDING_FETCH_CONFIG` in `src/pubmed.js`:
tier weights, recency decay, sample-size brackets, the replication-decay curve,
the score thresholds, and the structural gates (for example: no "Strong" without a
systematic review, a meta-analysis, or at least two RCTs). Change the numbers, run
`npm test`, and the tests will tell you what you broke.

