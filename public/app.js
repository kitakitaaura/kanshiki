import { renderStudy, initInspector, hideStudy, currentStudy } from "/inspector.js";
import { exportToFile, openPrintableReport, downloadFile, slugify } from "/exports.js";
import { createCollection, CollectionError } from "/collection.js";
import { createHistory } from "/related.js";

const form = document.getElementById("claim-form");
const input = document.getElementById("claim");
const submit = document.getElementById("submit");
const counter = document.getElementById("counter");
const statusEl = document.getElementById("status");
const result = document.getElementById("result");

const STAGES = [
  { text: "Reading the claim…" },
  { text: "Extracting a testable claim…", needsAi: true },
  { text: "Searching PubMed…" },
  { text: "Grading the studies…" },
  { text: "Checking which way each study points…", needsAi: true },
  { text: "Writing the verdict…", needsAi: true },
];

const STANCE_LABELS = {
  supports: "Supports claim",
  contradicts: "Against claim",
  neutral: "Doesn't test claim",
  unassessed: "Not assessed",
};

let stageTimer = null;
let inFlight = false;
// Aborts the request in flight. A cancelled request must not poison the next.
let inFlightController = null;

let lastClaimStudies = new Map();
let lastClaimResult = null;

const STUDY_STAGES = [
  { text: "Looking up the record…" },
  { text: "Fetching citation and venue statistics…" },
  { text: "Weighing credibility signals…" },
  { text: "Explaining the paper…", needsAi: true },
];

function showStatus(message, isError = false) {
  statusEl.hidden = false;
  statusEl.classList.toggle("error", isError);
  statusEl.innerHTML = "";
  if (!isError) statusEl.append(Object.assign(document.createElement("div"), { className: "spinner" }));
  statusEl.append(document.createTextNode(message));
}

function stopStages() {
  clearInterval(stageTimer);
  stageTimer = null;
  document.getElementById("cancel-row").hidden = true;
}

function beginRequest() {
  inFlightController?.abort();
  inFlightController = new AbortController();
  document.getElementById("cancel-row").hidden = false;
  return inFlightController.signal;
}

function isAbort(err) {
  return err?.name === "AbortError";
}

function updateCounter() {
  const n = input.value.length;
  counter.textContent = n ? `${n} / 4000` : "";
}

function risButton(study) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "row-cite";
  button.textContent = "RIS";
  button.title = "Download this study as RIS. All formats are in the inspector.";
  button.addEventListener("click", async () => {
    try {
      await exportToFile("study", "ris", { record: study }, `pmid-${study.pmid}`);
    } catch (err) {
      showStatus(err.message, true);
    }
  });
  return button;
}

function retractedTag(retraction) {
  const tag = document.createElement("span");
  tag.className = "tag retracted";
  tag.textContent = "Retracted";
  tag.title = retraction?.noticeUrl
    ? "This paper has been retracted. Open the inspector for the retraction notice."
    : "This paper has been retracted.";
  return tag;
}

function studyLink(study) {
  const a = document.createElement("a");
  a.href = study.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = study.title || `PMID ${study.pmid}`;
  a.title = "Inspect this study";
  a.addEventListener("click", (event) => openInspectorFromLink(event, study.pmid));
  return a;
}

function openInspectorFromLink(event, pmid) {
  // Modified clicks fall through to PubMed.
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  inspectStudy(String(pmid), { fromClaim: true });
}

function partialReadTag() {
  const tag = document.createElement("span");
  tag.className = "tag partial";
  tag.textContent = "Partial read";
  tag.title =
    "This study's abstract was longer than the excerpt sent for judging, so the stance was decided from an incomplete read.";
  return tag;
}

const SHORT_DIRECTION = {
  supported: "supports",
  "leans-supported": "leans for",
  mixed: "mixed",
  "leans-contradicted": "leans against",
  contradicted: "against",
  unassessed: "unclear",
};

function renderTimeline(checkpoints, skippedReason) {
  const wrap = document.getElementById("timeline");
  const track = document.getElementById("timeline-track");
  const note = document.getElementById("timeline-note");
  track.innerHTML = "";
  note.textContent = "";

  if (!checkpoints || checkpoints.length < 2) {
    if (skippedReason) {
      wrap.hidden = false;
      note.textContent = skippedReason;
    } else {
      wrap.hidden = true;
    }
    return;
  }

  for (const point of checkpoints) {
    const step = document.createElement("li");
    step.className = "timeline-step";

    const dot = document.createElement("span");
    dot.className = "timeline-dot";
    dot.dataset.strength = point.strength;

    const year = document.createElement("span");
    year.className = "timeline-year";
    year.textContent = point.year;

    const strength = document.createElement("span");
    strength.className = "timeline-strength";
    strength.textContent = point.strengthText;

    const dir = document.createElement("span");
    dir.className = "timeline-direction";
    dir.dataset.direction = point.direction;
    dir.textContent = SHORT_DIRECTION[point.direction] ?? point.direction;

    const count = document.createElement("span");
    count.className = "timeline-count";
    count.textContent = `${point.studyCount} ${point.studyCount === 1 ? "study" : "studies"}`;

    step.append(dot, year, strength, dir, count);
    track.append(step);
  }

  const first = checkpoints[0];
  const last = checkpoints[checkpoints.length - 1];
  note.textContent =
    first.strength === last.strength && first.direction === last.direction
      ? "The picture has been stable as studies accumulated."
      : `Cumulative verdict at each point. It moved from ${first.strengthText.toLowerCase()} (${SHORT_DIRECTION[first.direction]}) to ${last.strengthText.toLowerCase()} (${SHORT_DIRECTION[last.direction]}).`;

  wrap.hidden = false;
}

// Informational only. It never alters or replaces the result on screen.
function renderExcluded(count) {
  const el = document.getElementById("excluded-note");
  if (!count) {
    el.hidden = true;
    return;
  }
  el.textContent =
    count === 1
      ? "1 retracted study was found and is listed below, but was excluded from this grade."
      : `${count} retracted studies were found and are listed below, but were excluded from this grade.`;
  el.hidden = false;
}

function renderRelated(data) {
  const el = document.getElementById("related");
  el.textContent = "";
  const match = history.findRelated(data.claim);
  if (!match) {
    el.hidden = true;
    return;
  }

  el.append(document.createTextNode("A related claim was also checked: "));
  const label = document.createElement("strong");
  label.textContent = match.claim;
  el.append(label);

  const detail = [match.verdict, match.direction].filter(Boolean).join(", ");
  if (detail) el.append(document.createTextNode(` (${detail})`));

  const again = document.createElement("button");
  again.type = "button";
  again.className = "linkish";
  again.textContent = "Check it again";
  again.addEventListener("click", () => {
    input.value = match.claim;
    document.getElementById("cancel-request").addEventListener("click", () => {
  inFlightController?.abort();
});

updateCounter();
    document.getElementById("query-input").value = "";
    form.requestSubmit();
  });
  el.append(document.createTextNode(" "), again);
  el.hidden = false;
}

function renderFunding(funding) {
  const el = document.getElementById("funding");
  el.textContent = "";
  el.removeAttribute("data-lean");
  if (!funding || !studiesCounted(funding)) return;

  const mark = document.createElement("span");
  mark.className = "funding-mark";

  let text;
  if (!funding.sufficient) {
    const pct = Math.round(funding.undisclosedWeight * 100);
    text = `Funding not disclosed for most of this evidence (${pct}% by weight), so the funding mix cannot be summarized.`;
  } else {
    const { industry, total } = funding.amongSupporting;
    const industryPct = Math.round(funding.industryWeight * 100);
    const lead =
      total > 0
        ? `${industry} of ${total} supporting ${total === 1 ? "study was" : "studies were"} industry-funded.`
        : `No supporting studies to attribute.`;
    text = `${lead} Across all studies, ${industryPct}% of the weighted evidence came from industry funding.`;
    if (funding.undisclosedWeight > 0) {
      text += ` ${Math.round(funding.undisclosedWeight * 100)}% did not disclose.`;
    }
    if (funding.industryWeight >= 0.5) el.dataset.lean = "industry";
  }

  el.append(mark, document.createTextNode(text));
}

function studiesCounted(funding) {
  return Object.values(funding.counts ?? {}).some((n) => n > 0);
}

function renderSpotlight(spotlight) {
  const wrap = document.getElementById("spotlight");
  if (!spotlight) {
    wrap.hidden = true;
    return;
  }
  for (const side of ["for", "against"]) {
    const study = spotlight[side];
    const link = document.getElementById(`spot-${side}-title`);
    link.textContent = study.title || `PMID ${study.pmid}`;
    link.href = study.url;
    link.title = "Inspect this study";
    link.onclick = (event) => openInspectorFromLink(event, study.pmid);

    const meta = document.getElementById(`spot-${side}-meta`);
    meta.innerHTML = "";
    if (study.retraction?.retracted) meta.append(retractedTag(study.retraction));
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.dataset.tier = study.type;
    tag.textContent = study.typeLabel;
    meta.append(tag);
    meta.append(
      document.createTextNode(
        [study.journal, study.year, study.sampleSize ? `n≈${study.sampleSize.toLocaleString()}` : null]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    if (study.partialRead) meta.append(partialReadTag());

    document.getElementById(`spot-${side}-excerpt`).textContent = study.excerpt || "";
  }
  wrap.hidden = false;
}

function render(data) {
  const { verdict, direction, spotlight, fundingBreakdown, timeline, studies, meta } = data;

  const badge = document.getElementById("badge");
  badge.textContent = verdict.labelText;
  badge.dataset.label = verdict.label;

  const dirBadge = document.getElementById("direction-badge");
  dirBadge.textContent = direction.directionText;
  dirBadge.dataset.direction = direction.direction;
  dirBadge.title =
    direction.direction === "unassessed"
      ? "Not enough of the studies could be judged for or against the claim."
      : `${direction.counts.supports} supporting, ${direction.counts.contradicts} against, ` +
        `${direction.counts.neutral} not testing the claim, weighted by study quality.`;

  document.getElementById("claim-text").textContent = data.claim;
  document.getElementById("query-text").textContent = data.query;
  const modeEl = document.getElementById("query-mode");
  modeEl.textContent =
    data.queryMode === "user-edited"
      ? "your query"
      : data.queryMode === "keyword-fallback"
        ? "keywords"
        : "auto";
  modeEl.dataset.mode = data.queryMode ?? "";
  document.getElementById("match-count").textContent = meta.totalMatches
    ? `${meta.totalMatches.toLocaleString()} PubMed matches, top ${meta.shown} examined`
    : "no PubMed matches";

  renderExcluded(data.excludedRetractedCount ?? 0);
  renderRelated(data);
  renderFunding(fundingBreakdown);
  renderTimeline(timeline, meta.timelineSkipped);
  renderSpotlight(spotlight);
  document.getElementById("summary").textContent = data.summary;

  const rationale = document.getElementById("rationale");
  rationale.innerHTML = "";
  const notes = [...verdict.rationale];
  if (meta.searchError) notes.push(`PubMed lookup problem: ${meta.searchError}`);
  if (meta.aiDegraded) {
    notes.push(
      meta.aiDisabled
        ? "AI is switched off, so this summary was assembled from the study metadata alone, and no direction was judged."
        : "The language model was unavailable, so this summary was assembled from the study metadata alone.",
    );
  }
  if (meta.inputWarning) notes.push(meta.inputWarning);
  if (meta.stanceDegraded && !meta.aiDegraded && studies.length) {
    notes.push("Some studies could not be judged for or against the claim; those are counted as no vote.");
  }
  for (const note of notes) {
    rationale.append(Object.assign(document.createElement("li"), { textContent: note }));
  }

  const strip = document.getElementById("score-strip");
  strip.innerHTML = "";
  const pills = [`Evidence score ${verdict.score}`];
  if (verdict.topTierText) pills.push(`Best available: ${verdict.topTierText}`);
  if (direction.direction !== "unassessed") {
    pills.push(`${direction.counts.supports} for / ${direction.counts.contradicts} against`);
  }
  if (verdict.newestYear) pills.push(`Published ${verdict.oldestYear}–${verdict.newestYear}`);
  pills.push(`${(meta.elapsedMs / 1000).toFixed(1)}s`);
  for (const text of pills) {
    strip.append(Object.assign(document.createElement("span"), { className: "pill", textContent: text }));
  }

  lastClaimResult = data;
  lastClaimStudies = new Map();
  for (const s of studies) lastClaimStudies.set(String(s.pmid), s);
  if (spotlight) {
    for (const side of ["for", "against"]) {
      if (spotlight[side]) lastClaimStudies.set(String(spotlight[side].pmid), spotlight[side]);
    }
  }

  const list = document.getElementById("sources");
  list.innerHTML = "";
  for (const s of studies) {
    const li = document.createElement("li");
    const a = studyLink(s);
    const meta2 = document.createElement("span");
    meta2.className = "source-meta";
    if (s.retraction?.retracted) meta2.append(retractedTag(s.retraction));

    const tag = document.createElement("span");
    tag.className = "tag";
    tag.dataset.tier = s.type;
    tag.textContent = s.typeLabel;
    meta2.append(tag);
    if (s.stance && s.stance !== "unassessed") {
      const stanceTag = document.createElement("span");
      stanceTag.className = "tag stance";
      stanceTag.dataset.stance = s.stance;
      stanceTag.textContent = STANCE_LABELS[s.stance] ?? s.stance;
      meta2.append(stanceTag);
    }
    if (s.fundingSource && s.fundingSource !== "undisclosed") {
      const fundTag = document.createElement("span");
      fundTag.className = "tag funding-tag";
      fundTag.dataset.funding = s.fundingSource;
      fundTag.textContent = s.fundingLabel;
      meta2.append(fundTag);
    }
    if (s.partialRead) meta2.append(partialReadTag());
    const bits = [s.journal, s.year, s.sampleSize ? `n≈${s.sampleSize.toLocaleString()}` : null, `PMID ${s.pmid}`]
      .filter(Boolean)
      .join(" · ");
    meta2.append(document.createTextNode(bits));
    meta2.append(risButton(s));
    li.append(a, meta2);
    list.append(li);
  }

  const wrap = document.getElementById("sources-wrap");
  document.getElementById("sources-count").textContent = studies.length
    ? `${studies.length} source studies`
    : "No source studies found";
  wrap.open = studies.length > 0 && studies.length <= 8;
  wrap.hidden = studies.length === 0;

  result.dataset.rendered = "true";
  result.hidden = false;
}

function stagesFor(base) {
  return base.filter((stage) => useAi || !stage.needsAi).map((stage) => stage.text);
}

async function run(claim) {
  if (inFlight) return;
  inFlight = true;
  submit.disabled = true;
  result.hidden = true;
  hideStudy();
  const signal = beginRequest();
  startStages(stagesFor(STAGES));

  try {
    const res = await fetch("/api/check-claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claim, useAi, query: document.getElementById("query-input").value.trim() }),
      signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    stopStages();
    statusEl.hidden = true;
    render(data);
    history.record(data);
  } catch (err) {
    stopStages();
    if (isAbort(err)) statusEl.hidden = true;
    else showStatus(err.message || "Something went wrong.", true);
  } finally {
    inFlight = false;
    inFlightController = null;
    submit.disabled = false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const claim = input.value.trim();
  if (!claim) {
    showStatus("Enter a health claim first.", true);
    return;
  }
  run(claim);
});

const queryAdvanced = document.getElementById("query-advanced");
const queryInput = document.getElementById("query-input");

document.getElementById("query-preview").addEventListener("click", async () => {
  const claim = input.value.trim();
  if (!claim) {
    showStatus("Enter a health claim first.", true);
    return;
  }
  const button = document.getElementById("query-preview");
  button.disabled = true;
  button.textContent = "Building query...";
  try {
    const res = await fetch("/api/extract-query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claim, useAi }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    queryInput.value = data.query;
    queryInput.focus();
  } catch (err) {
    showStatus(err.message || "Could not build a query.", true);
  } finally {
    button.disabled = false;
    button.textContent = "Preview the automatic query";
  }
});

document.getElementById("query-clear").addEventListener("click", () => {
  queryInput.value = "";
  queryInput.focus();
});

document.getElementById("query-edit").addEventListener("click", () => {
  if (!lastClaimResult) return;
  queryAdvanced.open = true;
  queryInput.value = lastClaimResult.query;
  input.value = lastClaimResult.input ?? input.value;
  queryAdvanced.scrollIntoView({ behavior: "smooth", block: "center" });
  queryInput.focus();
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) form.requestSubmit();
});
input.addEventListener("input", updateCounter);

document.getElementById("examples").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  input.value = chip.textContent;
  updateCounter();
  form.requestSubmit();
});

updateCounter();

// --- study inspector -----------------------------------------------------

const studyForm = document.getElementById("study-form");
const studyInput = document.getElementById("study-ref");
const studySubmit = document.getElementById("study-submit");
const claimPanel = document.getElementById("claim-panel");
const studyPanel = document.getElementById("study-panel");
const claimResult = document.getElementById("result");

function startStages(stages) {
  let i = 0;
  showStatus(stages[0]);
  clearInterval(stageTimer);
  stageTimer = setInterval(() => {
    i = Math.min(i + 1, stages.length - 1);
    showStatus(stages[i]);
  }, 1800);
}

async function inspectStudy(ref, { fromClaim = false } = {}) {
  if (inFlight) return;
  inFlight = true;
  studySubmit.disabled = true;
  hideStudy();

  if (fromClaim) {
    // setMode clears the status line, so it runs before the spinner.
    setMode("study");
    studyInput.value = ref;
  }

  startStages(stagesFor(STUDY_STAGES));

  const cached = lastClaimStudies.get(String(ref));

  try {
    const res = await fetch("/api/inspect-study", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref, record: cached ?? null, useAi }),
      signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    stopStages();
    statusEl.hidden = true;
    renderStudy(data, { showBack: fromClaim });
    document.getElementById("study-result").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    stopStages();
    showStatus(err.message || "Could not inspect that study.", true);
  } finally {
    inFlight = false;
    studySubmit.disabled = false;
  }
}

studyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const ref = studyInput.value.trim();
  if (!ref) {
    showStatus("Enter a PubMed link, a PMID, or a DOI.", true);
    return;
  }
  inspectStudy(ref);
});

document.getElementById("study-examples").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  studyInput.value = chip.dataset.ref;
  studyForm.requestSubmit();
});

const collectionPanel = document.getElementById("collection-panel");

function setMode(mode) {
  claimPanel.hidden = mode !== "claim";
  studyPanel.hidden = mode !== "study";
  collectionPanel.hidden = mode !== "collection";
  for (const name of ["claim", "study", "collection"]) {
    document.getElementById(`mode-${name}`).setAttribute("aria-selected", String(mode === name));
  }
  statusEl.hidden = true;
  claimResult.hidden = mode !== "claim" || !claimResult.dataset.rendered;
  if (mode !== "study") hideStudy();
  if (mode === "collection") renderCollection();
}

document.getElementById("mode-claim").addEventListener("click", () => setMode("claim"));
document.getElementById("mode-study").addEventListener("click", () => setMode("study"));
document.getElementById("mode-collection").addEventListener("click", () => setMode("collection"));

initInspector({
  onBackToClaim: () => {
    setMode("claim");
    claimResult.hidden = false;
    claimResult.scrollIntoView({ behavior: "smooth", block: "start" });
  },
});

// --- AI toggle -----------------------------------------------------------

const aiToggle = document.getElementById("ai-toggle");
const aiWarning = document.getElementById("ai-warning");
const aiOffBanner = document.getElementById("ai-off-banner");

let useAi = true;

function applyAiState() {
  aiToggle.setAttribute("aria-checked", String(useAi));
  document.getElementById("ai-switch-label").textContent = useAi ? "AI" : "No AI";
  aiOffBanner.hidden = useAi;
}

function showAiWarning() {
  if (typeof aiWarning.showModal === "function") {
    aiWarning.showModal();
    return;
  }
  const ok = window.confirm(
    "Turning AI off disables the direction badge and written summaries, and makes the PubMed " +
      "search cruder. Evidence grades, timelines, retractions, funding, and citations still work. " +
      "Turn AI off?",
  );
  if (ok) {
    useAi = false;
    applyAiState();
  }
}

aiToggle.addEventListener("click", () => {
  if (useAi) {
    showAiWarning();
    return;
  }
  useAi = true;
  applyAiState();
});

document.getElementById("ai-warning-confirm").addEventListener("click", () => {
  useAi = false;
  applyAiState();
  aiWarning.close();
});

document.getElementById("ai-warning-cancel").addEventListener("click", () => aiWarning.close());

aiWarning.addEventListener("cancel", () => aiWarning.close());

document.getElementById("ai-off-details").addEventListener("click", () => {
  if (typeof aiWarning.showModal === "function") aiWarning.showModal();
});

applyAiState();


// --- exports -------------------------------------------------------------

async function runExport(action) {
  if (!lastClaimResult) return;
  try {
    await action();
  } catch (err) {
    showStatus(err.message || "Export failed.", true);
  }
}

document.getElementById("claim-export-csv").addEventListener("click", () =>
  runExport(() => exportToFile("claim", "csv", lastClaimResult, lastClaimResult.claim)),
);
document.getElementById("claim-export-ris").addEventListener("click", () =>
  runExport(() => exportToFile("claim", "ris", lastClaimResult, lastClaimResult.claim)),
);
document.getElementById("claim-export-pdf").addEventListener("click", () =>
  runExport(() => openPrintableReport("claim", lastClaimResult)),
);

// --- collection ----------------------------------------------------------

const collection = createCollection(window.localStorage);
const history = createHistory(window.localStorage);
const collectionList = document.getElementById("collection-list");
const collectionEmpty = document.getElementById("collection-empty");
const collectionFile = document.getElementById("collection-file");

function updateCollectionCount() {
  document.getElementById("collection-count").textContent = String(collection.size());
}

function renderCollection() {
  const items = collection.list();
  collectionList.innerHTML = "";
  collectionEmpty.hidden = items.length > 0;

  for (const item of items) {
    const li = document.createElement("li");
    li.className = "collection-item";

    const main = document.createElement("div");
    main.className = "collection-item-main";

    const label = document.createElement("div");
    label.className = "collection-item-label";
    label.textContent = item.label;

    const meta = document.createElement("div");
    meta.className = "collection-item-meta";
    const kind = document.createElement("span");
    kind.className = "collection-kind";
    kind.dataset.kind = item.kind;
    kind.textContent = item.kind === "claim" ? "Claim" : "Study";
    meta.append(kind);
    meta.append(document.createTextNode(describeItem(item)));

    main.append(label, meta);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "collection-remove";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      collection.remove(item.key);
      renderCollection();
      updateCollectionCount();
    });

    li.append(main, remove);
    collectionList.append(li);
  }
  updateCollectionCount();
}

function describeItem(item) {
  const added = String(item.addedAt ?? "").slice(0, 10);
  if (item.kind === "claim") {
    const verdict = item.result?.verdict?.labelText ?? "";
    const direction = item.result?.direction?.directionText ?? "";
    const count = item.result?.studies?.length ?? 0;
    return [verdict, direction, `${count} studies`, added].filter(Boolean).join(" · ");
  }
  const record = item.result?.record ?? {};
  return [record.journal, record.year, item.result?.credibility?.labelText, added]
    .filter(Boolean)
    .join(" · ");
}

function addToCollection(kind, result, button) {
  if (!result) return;
  try {
    const { added, reason } = collection.add(kind, result);
    button.textContent = added ? "Added" : `Already saved`;
    if (!added && reason) button.title = reason;
    updateCollectionCount();
    setTimeout(() => {
      button.textContent = "Add to collection";
    }, 2000);
  } catch (err) {
    showStatus(err instanceof CollectionError ? err.message : "Could not save that item.", true);
  }
}

document.getElementById("claim-add-collection").addEventListener("click", (event) =>
  addToCollection("claim", lastClaimResult, event.currentTarget),
);
document.getElementById("study-add-collection").addEventListener("click", (event) =>
  addToCollection("study", currentStudy(), event.currentTarget),
);

async function exportCollection(format) {
  const items = collection.list();
  if (!items.length) {
    showStatus("The collection is empty.", true);
    return;
  }
  try {
    if (format === "html") await openPrintableReport("collection", { items });
    else await exportToFile("collection", format, { items }, "kanshiki-collection");
  } catch (err) {
    showStatus(err.message || "Export failed.", true);
  }
}

document.getElementById("collection-export-csv").addEventListener("click", () => exportCollection("csv"));
document.getElementById("collection-export-ris").addEventListener("click", () => exportCollection("ris"));
document.getElementById("collection-export-pdf").addEventListener("click", () => exportCollection("html"));

document.getElementById("collection-export-json").addEventListener("click", () => {
  downloadFile(`${slugify("kanshiki-collection")}.json`, collection.toJson(), "application/json");
});

document.getElementById("collection-import").addEventListener("click", () => collectionFile.click());

collectionFile.addEventListener("change", async () => {
  const file = collectionFile.files?.[0];
  if (!file) return;
  try {
    const count = collection.fromJson(await file.text());
    renderCollection();
    showStatus(`Imported ${count} ${count === 1 ? "item" : "items"}.`, false);
    setTimeout(() => { statusEl.hidden = true; }, 2500);
  } catch (err) {
    showStatus(err instanceof CollectionError ? err.message : "Could not read that file.", true);
  } finally {
    collectionFile.value = "";
  }
});

document.getElementById("collection-clear").addEventListener("click", () => {
  if (!collection.size()) return;
  if (!window.confirm("Remove every item from the collection on this device?")) return;
  collection.clear();
  renderCollection();
});

updateCollectionCount();

// --- deployment mode -----------------------------------------------------

fetch("/api/config")
  .then((res) => (res.ok ? res.json() : null))
  .then((config) => {
    if (!config?.rateLimited) return;
    const note = document.getElementById("demo-note");
    note.querySelector("span").textContent =
      `This demo allows about ${config.perMinute} checks per minute per visitor. ` +
      `For unlimited use, run Kanshiki on your own machine for free. It is one command, your data ` +
      `never leaves your computer, and there are no limits.`;
    note.hidden = false;
  })
  .catch(() => {});
