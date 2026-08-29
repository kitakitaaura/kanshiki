import { claimCsv, claimRis, claimReportHtml, studyReportHtml, studyToCsvRow, toCsv } from "../../src/exportFormats.js";
import { formatRisFile } from "../../src/citations.js";

const TYPES = {
  ris: ["application/x-research-info-systems", "ris"],
  csv: ["text/csv", "csv"],
  html: ["text/html", "html"],
};

const error = (message, status = 400) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export async function onRequestPost({ request }) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return error('Expected a JSON body like { "kind": "claim", "format": "ris", "result": {...} }');
  }

  const kind = String(payload?.kind ?? "");
  const format = String(payload?.format ?? "").toLowerCase();
  const result = payload?.result;

  if (!TYPES[format]) return error(`Unknown export format: ${format || "(none)"}`);
  if (!result || typeof result !== "object") return error("Missing result to export.");

  let body;
  try {
    if (kind === "claim") {
      if (format === "ris") body = claimRis(result);
      else if (format === "csv") body = claimCsv(result);
      else body = claimReportHtml(result);
    } else if (kind === "study") {
      const record = result.record ?? result;
      if (format === "ris") body = formatRisFile([record]);
      else if (format === "csv") body = toCsv([studyToCsvRow(record)]);
      else body = studyReportHtml(result);
    } else if (kind === "collection") {
      const items = Array.isArray(result.items) ? result.items : [];
      const studies = items.flatMap((item) =>
        item.kind === "claim" ? (item.result?.studies ?? []) : [item.result?.record ?? item.result],
      ).filter(Boolean);
      if (format === "ris") body = formatRisFile(studies);
      else if (format === "csv") body = toCsv(studies.map(studyToCsvRow));
      else body = collectionReportHtml(items);
    } else {
      return error(`Unknown export kind: ${kind || "(none)"}`);
    }
  } catch (err) {
    console.error("export failed:", err?.stack || err);
    return error("Could not build that export.", 500);
  }

  const [mime] = TYPES[format];
  return new Response(body, {
    headers: { "content-type": `${mime}; charset=utf-8`, "cache-control": "no-store" },
  });
}

function collectionReportHtml(items) {
  return items
    .map((item) =>
      item.kind === "claim" ? claimReportHtml(item.result) : studyReportHtml(item.result),
    )
    .join('\n<div style="page-break-after:always"></div>\n');
}

export function onRequestGet() {
  return error('Use POST with { "kind", "format", "result" }', 405);
}
