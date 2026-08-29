export function slugify(value, max = 60) {
  return (
    String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max) || "kanshiki"
  );
}

export function downloadFile(filename, contents, mime = "text/plain") {
  const blob = new Blob([contents], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function requestExport(kind, format, result) {
  const res = await fetch("/api/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, format, result }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error || `Export failed (${res.status})`);
  }
  return res.text();
}

const EXTENSIONS = { ris: "ris", csv: "csv" };
const MIMES = { ris: "application/x-research-info-systems", csv: "text/csv" };

export async function exportToFile(kind, format, result, basename) {
  const body = await requestExport(kind, format, result);
  downloadFile(`${slugify(basename)}.${EXTENSIONS[format]}`, body, MIMES[format]);
}

// PDF comes from the browser's own print dialog rather than a bundled
// library, which keeps the frontend build-free.
export async function openPrintableReport(kind, result) {
  const html = await requestExport(kind, "html", result);
  const win = window.open("", "_blank");
  if (!win) throw new Error("Allow pop-ups to open the printable report.");
  win.document.write(html);
  win.document.close();
  win.addEventListener("load", () => setTimeout(() => win.print(), 250), { once: true });
}
