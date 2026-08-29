export const CITATION_STYLES = ["apa", "mla", "chicago", "bibtex", "ris"];

export const CITATION_LABELS = {
  apa: "APA 7th",
  mla: "MLA 9th",
  chicago: "Chicago",
  bibtex: "BibTeX",
  ris: "RIS",
};

// Styles that are files, not prose: no punctuation tidying, offered as downloads.
export const FILE_STYLES = { bibtex: "bib", ris: "ris" };

// APA lists 20 authors, then an ellipsis before the last.
const APA_AUTHOR_LIMIT = 20;

const has = (value) => typeof value === "string" && value.trim().length > 0;
const text = (value) => (has(value) ? value.trim() : "");

// PubMed summaries carry bylines as "Surname Initials" strings; the full
// record carries objects. Every formatter works from the object shape.
export function normalizeAuthor(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  const name = String(value).trim();
  if (!name) return null;
  const match = name.match(/^(.*?)\s+([A-Z]{1,3})$/);
  return match
    ? { name, last: match[1], fore: "", initials: match[2], collective: "" }
    : { name, last: name, fore: "", initials: "", collective: "" };
}

const authorList = (authors) => (authors ?? []).map(normalizeAuthor).filter(Boolean);

function apaName(author) {
  if (!author) return "";
  if (has(author.collective)) return text(author.collective);
  const last = text(author.last);
  const initials = initialsOf(author);
  if (!last) return text(author.name);
  return initials ? `${last}, ${initials}` : last;
}

function initialsOf(author) {
  if (has(author.initials)) {
    return author.initials.trim().split("").map((letter) => `${letter}.`).join(" ");
  }
  if (has(author.fore)) {
    return author.fore
      .trim()
      .split(/\s+/)
      .map((part) => `${part[0].toUpperCase()}.`)
      .join(" ");
  }
  return "";
}

function naturalName(author) {
  if (!author) return "";
  if (has(author.collective)) return text(author.collective);
  const initials = initialsOf(author);
  const last = text(author.last);
  if (!last) return text(author.name);
  return initials ? `${initials} ${last}` : last;
}

function apaAuthors(authors = []) {
  const names = authorList(authors).map(apaName).filter(Boolean);
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  if (names.length <= APA_AUTHOR_LIMIT) {
    return `${names.slice(0, -1).join(", ")}, & ${names[names.length - 1]}`;
  }
  return `${names.slice(0, 19).join(", ")}, ... ${names[names.length - 1]}`;
}

function mlaAuthors(authors = []) {
  const names = authorList(authors);
  if (!names.length) return "";
  const first = apaName(names[0]);
  if (names.length === 1) return first;
  if (names.length === 2) return `${first}, and ${naturalName(names[1])}`;
  return `${first}, et al`;
}

function chicagoAuthors(authors = []) {
  const names = authorList(authors);
  if (!names.length) return "";
  const first = apaName(names[0]);
  if (names.length === 1) return first;
  const rest = names.slice(1).map(naturalName).filter(Boolean);
  if (names.length === 2) return `${first}, and ${rest[0]}`;
  return `${first}, ${rest.slice(0, -1).join(", ")}, and ${rest[rest.length - 1]}`;
}

function endWithPeriod(value) {
  const trimmed = text(value);
  if (!trimmed) return "";
  return /[.?!]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function doiUrl(doi) {
  const value = text(doi);
  if (!value) return "";
  return value.startsWith("http") ? value : `https://doi.org/${value}`;
}

const join = (parts, separator = " ") => parts.filter((p) => has(p)).join(separator);

function apa(record) {
  const authors = apaAuthors(record.authors);
  const year = record.year ? `(${record.year}).` : "(n.d.).";
  const title = endWithPeriod(record.title);
  const journal = text(record.journal) || text(record.journalAbbrev);

  let source = journal;
  if (source && has(record.volume)) {
    source += `, ${record.volume}`;
    if (has(record.issue)) source += `(${record.issue})`;
  }
  if (source && has(record.pages)) source += `, ${record.pages}`;
  if (source) source += ".";

  return join([endWithPeriod(authors), year, title, source, doiUrl(record.doi)]);
}

function mla(record) {
  const authors = mlaAuthors(record.authors);
  const title = has(record.title) ? `"${endWithPeriod(record.title)}"` : "";
  const journal = text(record.journal) || text(record.journalAbbrev);

  const container = join(
    [
      journal ? `${journal}` : "",
      has(record.volume) ? `vol. ${record.volume}` : "",
      has(record.issue) ? `no. ${record.issue}` : "",
      record.year ? String(record.year) : "",
      has(record.pages) ? `pp. ${record.pages}` : "",
    ],
    ", ",
  );

  const parts = [endWithPeriod(authors), title, container ? `${container}.` : ""];
  const doi = doiUrl(record.doi);
  return join([...parts, doi ? `${doi}.` : ""]);
}

function chicago(record) {
  const authors = chicagoAuthors(record.authors);
  const title = has(record.title) ? `"${endWithPeriod(record.title)}"` : "";
  const journal = text(record.journal) || text(record.journalAbbrev);

  let source = journal;
  if (source && has(record.volume)) source += ` ${record.volume}`;
  if (source && has(record.issue)) source += `, no. ${record.issue}`;
  if (source && record.year) source += ` (${record.year})`;
  else if (!source && record.year) source = `${record.year}`;
  if (source && has(record.pages)) source += `: ${record.pages}`;
  if (source) source += ".";

  return join([endWithPeriod(authors), title, source, doiUrl(record.doi)]);
}

function bibtexKey(record) {
  const first = normalizeAuthor(record.authors?.[0]);
  const surname = text(first?.last) || text(first?.collective) || "study";
  const slug = surname
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase();
  return `${slug || "study"}${record.year ?? ""}${record.pmid ? `_${record.pmid}` : ""}`;
}

function bibtexAuthors(authors = []) {
  return authorList(authors)
    .map((a) => {
      if (has(a.collective)) return `{${a.collective.trim()}}`;
      const last = text(a.last);
      const fore = text(a.fore) || text(a.initials);
      if (!last) return text(a.name);
      return fore ? `${last}, ${fore}` : last;
    })
    .filter(Boolean)
    .join(" and ");
}

function bibtex(record) {
  const fields = [
    ["author", bibtexAuthors(record.authors)],
    ["title", text(record.title)],
    ["journal", text(record.journal) || text(record.journalAbbrev)],
    ["year", record.year ? String(record.year) : ""],
    ["volume", text(record.volume)],
    ["number", text(record.issue)],
    ["pages", text(record.pages).replace(/-/g, "--")],
    ["doi", text(record.doi)],
    ["pmid", text(record.pmid)],
  ].filter(([, value]) => has(value));

  if (!fields.length) return `@article{${bibtexKey(record)}\n}`;
  const body = fields.map(([key, value]) => `  ${key} = {${value}}`).join(",\n");
  return `@article{${bibtexKey(record)},\n${body}\n}`;
}


function risAuthor(author) {
  if (!author) return "";
  if (has(author.collective)) return text(author.collective);
  const last = text(author.last);
  const fore = text(author.fore) || text(author.initials);
  if (!last) return text(author.name);
  return fore ? `${last}, ${fore}` : last;
}

// PubMed abbreviates end pages: 637-41 means 637 to 641.
export function expandPageRange(pages) {
  const value = text(pages);
  if (!value) return { start: "", end: "" };
  const match = value.match(/^(\d+)\s*[-\u2013]\s*(\d+)$/);
  if (!match) return { start: value, end: "" };
  const [, start, end] = match;
  if (end.length >= start.length) return { start, end };
  return { start, end: start.slice(0, start.length - end.length) + end };
}

function ris(record) {
  const { start, end } = expandPageRange(record.pages);
  const rows = [["TY", "JOUR"]];

  for (const author of authorList(record.authors)) {
    const name = risAuthor(author);
    if (name) rows.push(["AU", name]);
  }

  const pairs = [
    ["TI", text(record.title)],
    ["JO", text(record.journal) || text(record.journalAbbrev)],
    ["JA", text(record.journalAbbrev)],
    ["PY", record.year ? String(record.year) : ""],
    ["VL", text(record.volume)],
    ["IS", text(record.issue)],
    ["SP", start],
    ["EP", end],
    ["DO", text(record.doi)],
    ["AB", text(record.abstract)],
    ["AN", text(record.pmid)],
    ["UR", text(record.url) || (record.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${record.pmid}/` : "")],
  ];
  for (const [tagName, value] of pairs) {
    if (has(value)) rows.push([tagName, value.replace(/\s*\n\s*/g, " ")]);
  }

  for (const term of record.meshTerms ?? []) {
    if (has(term)) rows.push(["KW", term]);
  }
  if (record.retraction?.retracted) rows.push(["N1", "Retracted publication"]);

  rows.push(["ER", ""]);
  return rows.map(([tagName, value]) => `${tagName}  - ${value}`.trimEnd()).join("\n");
}

// One .ris file holding many records, for bulk reference-manager import.
export function formatRisFile(records = []) {
  return `${records.map((record) => ris(record ?? {})).join("\n\n")}\n`;
}

const FORMATTERS = { apa, mla, chicago, bibtex, ris };

export function formatCitation(record, style) {
  const key = String(style).toLowerCase();
  const formatter = FORMATTERS[key];
  if (!formatter) throw new Error(`Unknown citation style: ${style}`);
  const out = formatter(record ?? {});
  if (FILE_STYLES[key]) return out;
  return out.replace(/\s+([.,])/g, "$1").trim();
}

export function formatAllCitations(record) {
  return Object.fromEntries(CITATION_STYLES.map((style) => [style, formatCitation(record, style)]));
}
