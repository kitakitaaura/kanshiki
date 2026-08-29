import { downloadFile, slugify, exportToFile, openPrintableReport } from "/exports.js";

const CITE_LABELS = {
  apa: "APA 7th",
  mla: "MLA 9th",
  chicago: "Chicago",
  bibtex: "BibTeX",
  ris: "RIS",
};

// Formats offered as a file download as well as a copy.
const FILE_EXTENSIONS = { bibtex: "bib", ris: "ris" };

const el = (id) => document.getElementById(id);

let currentCitations = null;
let currentStyle = "apa";
let currentRecord = null;
let currentResult = null;
let onBack = null;

export function renderStudy(data, { showBack = false } = {}) {
  const { record, credibility, metrics, citations } = data;

  const banner = el("retraction-banner");
  if (record.retraction?.retracted) {
    banner.hidden = false;
    banner.dataset.severity = "retracted";
    el("retraction-headline").textContent = "This paper has been retracted.";
    el("retraction-detail").textContent = record.retraction.noticeUrl
      ? "The journal withdrew it. Its findings should not be relied on."
      : "Its findings should not be relied on.";
    if (record.retraction.noticeUrl) {
      const link = document.createElement("a");
      link.href = record.retraction.noticeUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Read the retraction notice";
      el("retraction-detail").append(" ", link);
    }
  } else if (record.retraction?.expressionOfConcern) {
    banner.hidden = false;
    banner.dataset.severity = "concern";
    el("retraction-headline").textContent = "This paper carries an expression of concern.";
    el("retraction-detail").textContent =
      "The journal has flagged unresolved questions about it. It has not been retracted.";
  } else {
    banner.hidden = true;
  }

  el("study-title").textContent = record.title || `PMID ${record.pmid}`;

  const authors = (record.authors ?? []).map((a) => a.name || a).filter(Boolean);
  el("study-byline").textContent = authors.length
    ? authors.length > 6
      ? `${authors.slice(0, 6).join(", ")}, and ${authors.length - 6} more`
      : authors.join(", ")
    : "No authors listed";

  el("study-source").textContent = [
    record.journal || record.journalAbbrev,
    record.year,
    record.typeLabel,
    `PMID ${record.pmid}`,
  ]
    .filter(Boolean)
    .join(" · ");

  // --- summary ---
  el("study-summary").textContent = data.summary || record.abstract || "";
  const summaryNote = [
    data.meta?.aiDisabled
      ? "AI is switched off, so the abstract is shown as published."
      : data.summaryNote,
    data.partialRead
      ? "The abstract was longer than the excerpt sent for summarizing, so this is a partial read."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  el("study-summary-note").textContent = summaryNote;

  // --- credibility ---
  const badge = el("cred-badge");
  badge.textContent = credibility.labelText;
  badge.dataset.label = credibility.label;
  el("cred-coverage").textContent = credibility.note
    ? credibility.note
    : `${credibility.coverage.scored} of ${credibility.coverage.total} signals had data` +
      (credibility.composite !== null ? ` · composite ${credibility.composite}` : "");
  el("cred-measures").textContent = credibility.measures;

  const list = el("cred-signals");
  list.innerHTML = "";
  for (const item of credibility.signals) {
    const row = document.createElement("li");
    row.className = "cred-signal";
    row.dataset.available = String(item.available);

    const name = document.createElement("span");
    name.className = "cred-name";
    name.textContent = item.label;

    const meter = document.createElement("span");
    meter.className = "cred-meter";
    if (item.available) {
      const fill = document.createElement("span");
      fill.className = "cred-fill";
      fill.style.width = `${Math.round(item.score * 100)}%`;
      fill.dataset.strength = item.score >= 0.7 ? "high" : item.score >= 0.45 ? "mid" : "low";
      meter.append(fill);
    } else {
      meter.classList.add("cred-meter-empty");
    }

    const detail = document.createElement("span");
    detail.className = "cred-detail";
    detail.textContent = item.detail;

    row.append(name, meter, detail);
    list.append(row);
  }

  // --- stats ---
  const stats = el("study-stats");
  stats.innerHTML = "";
  const pills = [];
  if (Number.isFinite(metrics.citations)) {
    pills.push(`${metrics.citations.toLocaleString()} citations`);
    if (Number.isFinite(metrics.citationsPerYear)) {
      pills.push(`${metrics.citationsPerYear}/year`);
    }
  }
  if (Number.isFinite(metrics.relativeToVenue)) {
    pills.push(`${metrics.relativeToVenue}× this journal's typical rate`);
  }
  if (Number.isFinite(record.sampleSize)) pills.push(`n≈${record.sampleSize.toLocaleString()}`);
  if (record.typeLabel) pills.push(record.typeLabel);
  if (metrics.venue?.journalCitationRate != null) {
    pills.push(`Journal citation rate ${metrics.venue.journalCitationRate}`);
  }
  if (record.fundingLabel) pills.push(record.fundingLabel);
  if (!pills.length) pills.push("No statistics available for this record");

  for (const text of pills) {
    stats.append(Object.assign(document.createElement("span"), { className: "pill", textContent: text }));
  }
  el("study-stats-note").textContent = metrics.note || "";

  // --- citations ---
  currentCitations = citations;
  currentRecord = record;
  currentResult = data;
  renderCiteTabs();

  el("study-pubmed-link").href = record.url;

  el("inspector-back").hidden = !showBack;
  el("study-result").hidden = false;
}

function renderCiteTabs() {
  const tabs = el("cite-tabs");
  tabs.innerHTML = "";
  for (const style of Object.keys(currentCitations ?? {})) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "cite-tab";
    tab.role = "tab";
    tab.textContent = CITE_LABELS[style] ?? style;
    tab.dataset.style = style;
    tab.setAttribute("aria-selected", String(style === currentStyle));
    tab.addEventListener("click", () => {
      currentStyle = style;
      renderCiteTabs();
    });
    tabs.append(tab);
  }
  el("cite-box").textContent = currentCitations?.[currentStyle] ?? "";
  el("cite-copy").textContent = "Copy citation";

  const ext = FILE_EXTENSIONS[currentStyle];
  const download = el("cite-download");
  download.hidden = !ext;
  if (ext) download.textContent = `Download .${ext}`;
}

export function initInspector({ onBackToClaim } = {}) {
  onBack = onBackToClaim;

  el("cite-copy").addEventListener("click", async () => {
    const text = currentCitations?.[currentStyle] ?? "";
    if (!text) return;
    const button = el("cite-copy");
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(el("cite-box"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = "Selected. Press Cmd/Ctrl+C";
    }
    setTimeout(() => {
      button.textContent = "Copy citation";
    }, 2000);
  });

  el("cite-download").addEventListener("click", () => {
    const ext = FILE_EXTENSIONS[currentStyle];
    const text = currentCitations?.[currentStyle];
    if (!ext || !text) return;
    const name = slugify(currentRecord?.title || `pmid-${currentRecord?.pmid}`);
    downloadFile(`${name}.${ext}`, text, "application/x-research-info-systems");
  });

  el("study-export-csv").addEventListener("click", () =>
    exportToFile("study", "csv", currentResult, `study-${currentRecord?.pmid}`),
  );
  el("study-export-ris").addEventListener("click", () =>
    exportToFile("study", "ris", currentResult, `study-${currentRecord?.pmid}`),
  );
  el("study-export-pdf").addEventListener("click", () =>
    openPrintableReport("study", currentResult),
  );

  el("back-to-claim").addEventListener("click", () => {
    el("study-result").hidden = true;
    if (onBack) onBack();
  });
}

export function currentStudy() {
  return currentResult;
}

export function hideStudy() {
  el("study-result").hidden = true;
}
