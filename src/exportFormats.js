import { formatRisFile } from "./citations.js";

export const EXPORT_CONFIG = {
  csvColumns: [
    ["title", "Title"],
    ["authors", "Authors"],
    ["journal", "Journal"],
    ["year", "Year"],
    ["typeLabel", "Study type"],
    ["sampleSize", "Sample size"],
    ["stance", "Direction"],
    ["fundingLabel", "Funding"],
    ["retracted", "Retracted"],
    ["doi", "DOI"],
    ["pmid", "PMID"],
    ["url", "PubMed link"],
  ],
  maxStudies: 500,
};

export const METHODOLOGY_FOOTER = [
  "Kanshiki grades published evidence, not anyone's situation. It is not medical advice.",
  "Evidence strength and credibility are computed by fixed rules. Written summaries and per-study direction are model-generated.",
  "Sources: PubMed via NCBI E-utilities. Citation and venue statistics: OpenAlex, with Semantic Scholar as fallback.",
];

export function generatedStamp(date = new Date()) {
  return `Generated ${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;

export function toCsv(rows, columns = EXPORT_CONFIG.csvColumns) {
  const header = columns.map(([, label]) => csvCell(label)).join(",");
  const body = rows.map((row) => columns.map(([key]) => csvCell(row[key])).join(","));
  return `${[header, ...body].join("\r\n")}\r\n`;
}

export function studyToCsvRow(study = {}) {
  return {
    title: study.title ?? "",
    authors: (study.authors ?? []).map((a) => a?.name ?? a).filter(Boolean).join("; "),
    journal: study.journal || study.journalAbbrev || "",
    year: study.year ?? "",
    typeLabel: study.typeLabel ?? "",
    sampleSize: Number.isFinite(study.sampleSize) ? study.sampleSize : "",
    stance: study.stance && study.stance !== "unassessed" ? study.stance : "not assessed",
    fundingLabel: study.fundingLabel || "Funding not disclosed",
    retracted: study.retraction?.retracted ? "yes" : "no",
    doi: study.doi ?? "",
    pmid: study.pmid ?? "",
    url: study.url || (study.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${study.pmid}/` : ""),
  };
}

export function claimCsv(result = {}) {
  const studies = (result.studies ?? []).slice(0, EXPORT_CONFIG.maxStudies);
  return toCsv(studies.map(studyToCsvRow));
}

export function claimRis(result = {}) {
  return formatRisFile((result.studies ?? []).slice(0, EXPORT_CONFIG.maxStudies));
}

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const section = (title, body) => (body ? `<section><h2>${title}</h2>${body}</section>` : "");

const REPORT_CSS = `
  :root { color-scheme: light; }
  body { font: 12pt/1.5 Georgia, "Times New Roman", serif; color: #17191c; background: #fff;
         margin: 0; padding: 32px; max-width: 900px; }
  h1 { font-family: system-ui, sans-serif; font-size: 20pt; margin: 0 0 4px; }
  h2 { font-family: system-ui, sans-serif; font-size: 11pt; text-transform: uppercase;
       letter-spacing: .08em; color: #5a5f66; border-top: 1px solid #dcded9;
       padding-top: 10px; margin: 26px 0 8px; }
  .verdicts { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
  .badge { font-family: system-ui, sans-serif; font-size: 10pt; font-weight: 700; padding: 4px 10px;
           border-radius: 999px; color: #fff; background: #6b6f76; }
  .badge.strong { background: #1f7a4d; } .badge.moderate { background: #2f6fb0; }
  .badge.weak { background: #b06b17; } .badge.insufficient { background: #6b6f76; }
  .badge.outline { background: transparent; border: 1px solid currentColor; }
  .badge.supported, .badge.leans-supported { color: #1f7a4d; }
  .badge.contradicted, .badge.leans-contradicted { color: #8c1c13; }
  .badge.mixed { color: #b06b17; } .badge.unassessed { color: #6b6f76; }
  table { border-collapse: collapse; width: 100%; font-size: 9.5pt;
          font-family: system-ui, sans-serif; }
  th { text-align: left; border-bottom: 1.5px solid #17191c; padding: 6px 8px 6px 0; font-size: 8.5pt;
       text-transform: uppercase; letter-spacing: .06em; color: #5a5f66; }
  td { border-bottom: 1px solid #eceeeb; padding: 6px 8px 6px 0; vertical-align: top; }
  ul { margin: 0; padding-left: 18px; } li { margin-bottom: 4px; }
  .meta { color: #5a5f66; font-size: 10pt; margin: 2px 0 0; }
  .timeline { display: flex; gap: 14px; flex-wrap: wrap; font-family: system-ui, sans-serif;
              font-size: 9.5pt; }
  .timeline div { border-left: 2px solid #dcded9; padding-left: 8px; }
  .timeline b { display: block; font-size: 11pt; }
  footer { margin-top: 32px; border-top: 1px solid #dcded9; padding-top: 12px;
           font-size: 8.5pt; color: #868c93; font-family: system-ui, sans-serif; }
  .spot { display: flex; gap: 16px; flex-wrap: wrap; }
  .spot > div { flex: 1 1 260px; border-top: 3px solid #dcded9; padding-top: 8px; font-size: 10pt; }
  .spot .for { border-top-color: #1f7a4d; } .spot .against { border-top-color: #8c1c13; }
  @media print { body { padding: 0; } h2 { break-after: avoid; } tr { break-inside: avoid; } }
`;

// A self-contained printable page. The browser's print dialog makes the PDF,
// which avoids adding a PDF library to a no-build-step frontend.
export function claimReportHtml(result = {}, { now = new Date() } = {}) {
  const verdict = result.verdict ?? {};
  const direction = result.direction ?? {};
  const studies = result.studies ?? [];
  const funding = result.fundingBreakdown ?? {};

  const rows = studies
    .map((s) => {
      const r = studyToCsvRow(s);
      return `<tr><td>${escapeHtml(r.title)}${
        s.retraction?.retracted ? ' <strong style="color:#8c1c13">[RETRACTED]</strong>' : ""
      }</td><td>${escapeHtml(r.journal)}</td><td>${escapeHtml(r.year)}</td><td>${escapeHtml(
        r.typeLabel,
      )}</td><td>${escapeHtml(r.stance)}</td><td>${escapeHtml(r.pmid)}</td></tr>`;
    })
    .join("");

  const gates = (verdict.rationale ?? []).map((line) => `<li>${escapeHtml(line)}</li>`).join("");

  const timeline = (result.timeline ?? [])
    .map(
      (p) =>
        `<div><b>${escapeHtml(p.year)}</b>${escapeHtml(p.strengthText)}<br>${escapeHtml(
          p.directionText,
        )}<br>${p.studyCount} studies</div>`,
    )
    .join("");

  const spotlightSide = (label, study, cls) =>
    study
      ? `<div class="${cls}"><strong>${label}</strong><p class="meta">${escapeHtml(
          study.typeLabel,
        )}, ${escapeHtml(study.year)}</p>${escapeHtml(study.title)}</div>`
      : "";

  const spotlight = result.spotlight
    ? `<div class="spot">${spotlightSide("Strongest for", result.spotlight.for, "for")}${spotlightSide(
        "Strongest against",
        result.spotlight.against,
        "against",
      )}</div>`
    : "";

  const fundingText = !Object.values(funding.counts ?? {}).some((n) => n > 0)
    ? ""
    : funding.sufficient === false
      ? `Funding was not disclosed for most of this evidence (${Math.round(
          (funding.undisclosedWeight ?? 0) * 100,
        )}% by weight), so the mix cannot be summarized.`
      : `${Math.round((funding.industryWeight ?? 0) * 100)}% of the weighted evidence came from industry funding, ${Math.round(
          (funding.nonIndustryWeight ?? 0) * 100,
        )}% from public or nonprofit sources, and ${Math.round(
          (funding.undisclosedWeight ?? 0) * 100,
        )}% did not disclose.`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Kanshiki report: ${escapeHtml(result.claim ?? "claim")}</title>
<style>${REPORT_CSS}</style></head><body>
<h1>${escapeHtml(result.claim ?? "Claim")}</h1>
<p class="meta">PubMed query: ${escapeHtml(result.query ?? "")}${
    result.queryMode ? ` (${escapeHtml(result.queryMode)})` : ""
  }${result.meta?.totalMatches ? ` &middot; ${result.meta.totalMatches} matches, top ${result.meta.shown} examined` : ""}</p>
<div class="verdicts">
  <span class="badge ${escapeHtml(verdict.label ?? "")}">${escapeHtml(verdict.labelText ?? "")}</span>
  <span class="badge outline ${escapeHtml(direction.direction ?? "")}">${escapeHtml(direction.directionText ?? "")}</span>
</div>
${section("Summary", result.summary ? `<p>${escapeHtml(result.summary)}</p>` : "")}
${section("Why this grade", gates ? `<ul>${gates}</ul>` : "")}
${section("Funding", fundingText ? `<p>${fundingText}</p>` : "")}
${section("Evidence over time", timeline ? `<div class="timeline">${timeline}</div>` : "")}
${section("Strongest evidence on each side", spotlight)}
${section(
  `Source studies (${studies.length})`,
  rows
    ? `<table><thead><tr><th>Title</th><th>Journal</th><th>Year</th><th>Type</th><th>Direction</th><th>PMID</th></tr></thead><tbody>${rows}</tbody></table>`
    : "<p>No studies matched this claim.</p>",
)}
<footer>${generatedStamp(now)}<br>${METHODOLOGY_FOOTER.map(escapeHtml).join("<br>")}</footer>
</body></html>`;
}

export function studyReportHtml(result = {}, { now = new Date() } = {}) {
  const record = result.record ?? {};
  const cred = result.credibility ?? {};
  const metrics = result.metrics ?? {};

  const signals = (cred.signals ?? [])
    .map(
      (s) =>
        `<tr><td>${escapeHtml(s.label)}</td><td>${
          s.available ? s.score : "no data"
        }</td><td>${escapeHtml(s.detail)}</td></tr>`,
    )
    .join("");

  const stats = [
    Number.isFinite(metrics.citations) ? `${metrics.citations} citations` : "",
    Number.isFinite(metrics.citationsPerYear) ? `${metrics.citationsPerYear} per year` : "",
    Number.isFinite(metrics.relativeToVenue) ? `${metrics.relativeToVenue}x this journal's typical rate` : "",
    Number.isFinite(record.sampleSize) ? `n=${record.sampleSize}` : "",
    metrics.venue?.journalCitationRate != null
      ? `journal citation rate ${metrics.venue.journalCitationRate}`
      : "",
  ]
    .filter(Boolean)
    .join(" &middot; ");

  const retraction = record.retraction?.retracted
    ? `<p style="color:#8c1c13"><strong>This paper has been retracted.</strong> Its findings should not be relied on.</p>`
    : record.retraction?.expressionOfConcern
      ? `<p style="color:#b06b17"><strong>This paper carries an expression of concern.</strong></p>`
      : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Kanshiki study report: PMID ${escapeHtml(record.pmid ?? "")}</title>
<style>${REPORT_CSS}</style></head><body>
<h1>${escapeHtml(record.title ?? `PMID ${record.pmid ?? ""}`)}</h1>
<p class="meta">${escapeHtml(
    (record.authors ?? []).map((a) => a?.name ?? a).filter(Boolean).join(", "),
  )}</p>
<p class="meta">${escapeHtml(record.journal ?? "")} &middot; ${escapeHtml(record.year ?? "")} &middot; ${escapeHtml(
    record.typeLabel ?? "",
  )} &middot; PMID ${escapeHtml(record.pmid ?? "")}</p>
${retraction}
<div class="verdicts"><span class="badge ${cred.retracted ? "weak" : "strong"}">${escapeHtml(
    cred.labelText ?? "",
  )}</span></div>
${section("Summary", result.summary ? `<p>${escapeHtml(result.summary)}</p>` : "")}
${section("Statistics", stats ? `<p>${stats}</p>` : "")}
${section(
  "Credibility signals",
  signals
    ? `<table><thead><tr><th>Signal</th><th>Score</th><th>Detail</th></tr></thead><tbody>${signals}</tbody></table><p class="meta">${escapeHtml(
        cred.measures ?? "",
      )}</p>`
    : "",
)}
<footer>${generatedStamp(now)}<br>${METHODOLOGY_FOOTER.map(escapeHtml).join("<br>")}</footer>
</body></html>`;
}
