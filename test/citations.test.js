import test from "node:test";
import assert from "node:assert/strict";
import {
  formatCitation,
  formatAllCitations,
  formatRisFile,
  expandPageRange,
  CITATION_STYLES,
  CITATION_LABELS,
  FILE_STYLES,
} from "../src/citations.js";

const FULL = {
  pmid: "9500320",
  title: "Ileal-lymphoid-nodular hyperplasia and pervasive developmental disorder in children",
  journal: "Lancet (London, England)",
  journalAbbrev: "Lancet",
  year: 1998,
  volume: "351",
  issue: "9103",
  pages: "637-41",
  doi: "10.1016/s0140-6736(97)11096-0",
  authors: [
    { last: "Wakefield", fore: "A J", initials: "AJ" },
    { last: "Murch", fore: "S H", initials: "SH" },
    { last: "Walker-Smith", fore: "J A", initials: "JA" },
  ],
};

const SPARSE = {
  pmid: "123456",
  title: "A preprint with minimal metadata",
  authors: [{ last: "Solo", initials: "X" }],
};

const NOTHING = {};

test("every style is covered by a formatter and a label", () => {
  for (const style of CITATION_STYLES) {
    assert.equal(typeof formatCitation(FULL, style), "string");
    assert.ok(CITATION_LABELS[style], `missing label for ${style}`);
  }
});

test("an unknown style is a clear error", () => {
  assert.throws(() => formatCitation(FULL, "harvard"), /Unknown citation style/);
});

// --- full metadata ------------------------------------------------------

test("APA renders full metadata", () => {
  const out = formatCitation(FULL, "apa");
  assert.match(out, /^Wakefield, A\. J\., Murch, S\. H\., & Walker-Smith, J\. A\./);
  assert.match(out, /\(1998\)\./);
  assert.match(out, /Lancet \(London, England\), 351\(9103\), 637-41\./);
  assert.match(out, /https:\/\/doi\.org\/10\.1016/);
});

test("MLA renders full metadata with et al. for three authors", () => {
  const out = formatCitation(FULL, "mla");
  assert.match(out, /^Wakefield, A\. J\., et al\./);
  assert.match(out, /vol\. 351, no\. 9103, 1998, pp\. 637-41\./);
});

test("Chicago lists all authors and parenthesizes the year", () => {
  const out = formatCitation(FULL, "chicago");
  assert.match(out, /^Wakefield, A\. J\., S\. H\. Murch, and J\. A\. Walker-Smith\./);
  assert.match(out, /Lancet \(London, England\) 351, no\. 9103 \(1998\): 637-41\./);
});

test("BibTeX renders a valid entry with an en-dash page range", () => {
  const out = formatCitation(FULL, "bibtex");
  assert.match(out, /^@article\{wakefield1998_9500320,/);
  assert.match(out, /author = \{Wakefield, A J and Murch, S H and Walker-Smith, J A\}/);
  assert.match(out, /pages = \{637--41\}/);
  assert.ok(out.trim().endsWith("}"));
  assert.equal((out.match(/\{/g) || []).length, (out.match(/\}/g) || []).length);
});

// --- sparse metadata ----------------------------------------------------

test("no style emits undefined, empty brackets, or dangling punctuation", () => {
  for (const record of [SPARSE, NOTHING]) {
    for (const style of CITATION_STYLES) {
      const out = formatCitation(record, style);
      assert.doesNotMatch(out, /undefined|null|NaN/, `${style}: ${out}`);
      assert.doesNotMatch(out, /\(\)|\[\]|\{\}/, `${style}: ${out}`);
      assert.doesNotMatch(out, /,\s*,|\.\.(?!\.)|,\s*$/, `${style}: ${out}`);
      if (!FILE_STYLES[style]) assert.doesNotMatch(out, /\s{2,}/, `${style}: ${out}`);
    }
  }
});

test("APA marks a missing year as n.d. rather than omitting it", () => {
  const out = formatCitation(SPARSE, "apa");
  assert.match(out, /\(n\.d\.\)\./);
  assert.match(out, /Solo, X\./);
  assert.doesNotMatch(out, /doi\.org/);
});

test("MLA and Chicago drop the container entirely when there is no journal", () => {
  assert.equal(formatCitation(SPARSE, "mla"), 'Solo, X. "A preprint with minimal metadata."');
  assert.equal(formatCitation(SPARSE, "chicago"), 'Solo, X. "A preprint with minimal metadata."');
});

test("BibTeX omits absent fields instead of emitting empty ones", () => {
  const out = formatCitation(SPARSE, "bibtex");
  assert.match(out, /title = \{A preprint with minimal metadata\}/);
  for (const field of ["journal", "year", "volume", "number", "pages", "doi"]) {
    assert.doesNotMatch(out, new RegExp(`${field} = `), `${field} should be absent`);
  }
});

test("a record with no fields at all still produces parseable BibTeX", () => {
  const out = formatCitation(NOTHING, "bibtex");
  assert.match(out, /^@article\{study\n\}$/);
});

// --- author-count edge cases --------------------------------------------

test("a single author is not given an ampersand or et al.", () => {
  const one = { ...FULL, authors: [{ last: "Solo", initials: "X" }] };
  assert.match(formatCitation(one, "apa"), /^Solo, X\. \(1998\)/);
  assert.match(formatCitation(one, "mla"), /^Solo, X\. "/);
});

test("two authors are joined with 'and' in MLA and Chicago", () => {
  const two = { ...FULL, authors: [{ last: "Ash", initials: "A" }, { last: "Bell", fore: "Bo" }] };
  assert.match(formatCitation(two, "mla"), /^Ash, A\., and B\. Bell\./);
  assert.match(formatCitation(two, "chicago"), /^Ash, A\., and B\. Bell\./);
});

test("APA truncates very long author lists with an ellipsis", () => {
  const many = {
    ...FULL,
    authors: Array.from({ length: 25 }, (_, i) => ({ last: `Author${i}`, initials: "A" })),
  };
  const out = formatCitation(many, "apa");
  assert.match(out, /\.\.\. Author24, A\./);
  assert.ok(!out.includes("Author20,"), "authors past the limit should be dropped");
});

test("collective authors are kept whole", () => {
  const group = {
    ...FULL,
    authors: [{ collective: "GBD 2023 Collaborators" }],
  };
  assert.match(formatCitation(group, "apa"), /^GBD 2023 Collaborators\./);
  assert.match(formatCitation(group, "bibtex"), /author = \{\{GBD 2023 Collaborators\}\}/);
});

test("a record with no authors still renders title and source", () => {
  const anon = { ...FULL, authors: [] };
  const out = formatCitation(anon, "apa");
  assert.match(out, /^\(1998\)\./);
  assert.match(out, /Lancet/);
});

test("formatAllCitations returns every style at once", () => {
  const all = formatAllCitations(FULL);
  assert.deepEqual(Object.keys(all).sort(), [...CITATION_STYLES].sort());
  for (const style of CITATION_STYLES) assert.ok(all[style].length > 10);
});

// --- RIS ----------------------------------------------------------------

const risMap = (out) => {
  const map = {};
  for (const line of out.split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9])  - ?(.*)$/);
    if (!m) continue;
    (map[m[1]] ||= []).push(m[2]);
  }
  return map;
};

test("RIS renders full metadata with the standard tag layout", () => {
  const out = formatCitation(FULL, "ris");
  const tags = risMap(out);
  assert.equal(tags.TY[0], "JOUR");
  assert.deepEqual(tags.AU, ["Wakefield, A J", "Murch, S H", "Walker-Smith, J A"]);
  assert.equal(tags.TI[0], FULL.title);
  assert.equal(tags.JO[0], "Lancet (London, England)");
  assert.equal(tags.PY[0], "1998");
  assert.equal(tags.VL[0], "351");
  assert.equal(tags.IS[0], "9103");
  assert.equal(tags.DO[0], FULL.doi);
  assert.equal(tags.AN[0], "9500320");
  assert.ok(out.trimEnd().endsWith("ER  -"), "must end with the ER record terminator");
});

test("RIS expands PubMed abbreviated page ranges", () => {
  assert.deepEqual(expandPageRange("637-41"), { start: "637", end: "641" });
  assert.deepEqual(expandPageRange("1123-9"), { start: "1123", end: "1129" });
  assert.deepEqual(expandPageRange("12-18"), { start: "12", end: "18" });
  assert.deepEqual(expandPageRange("891822"), { start: "891822", end: "" });
  assert.deepEqual(expandPageRange(""), { start: "", end: "" });

  const tags = risMap(formatCitation(FULL, "ris"));
  assert.equal(tags.SP[0], "637");
  assert.equal(tags.EP[0], "641");
});

test("RIS omits absent fields rather than emitting empty tags", () => {
  const out = formatCitation(SPARSE, "ris");
  const tags = risMap(out);
  assert.equal(tags.TI[0], SPARSE.title);
  for (const tag of ["JO", "PY", "VL", "IS", "SP", "EP", "DO"]) {
    assert.equal(tags[tag], undefined, `${tag} should be absent`);
  }
  assert.doesNotMatch(out, /undefined|null|NaN/);
  // No tag other than the ER terminator may be emitted with an empty value.
  assert.doesNotMatch(out, /^(?!ER)[A-Z][A-Z0-9] {2}- *$/m);
});

test("RIS survives a record with no fields at all", () => {
  const out = formatCitation(NOTHING, "ris");
  assert.match(out, /^TY {2}- JOUR/);
  assert.ok(out.trimEnd().endsWith("ER  -"));
});

test("RIS carries abstract, keywords, and a retraction note when present", () => {
  const rich = {
    ...FULL,
    abstract: "A multi-line\nabstract with breaks.",
    meshTerms: ["Child", "Measles Vaccine"],
    retraction: { retracted: true },
  };
  const tags = risMap(formatCitation(rich, "ris"));
  assert.deepEqual(tags.KW, ["Child", "Measles Vaccine"]);
  assert.match(tags.N1[0], /Retracted/i);
  // Newlines inside a value would break the tag format.
  assert.equal(tags.AB.length, 1);
  assert.doesNotMatch(tags.AB[0], /\n/);
});

test("RIS is exempt from the prose punctuation tidy-up", () => {
  assert.ok(FILE_STYLES.ris, "RIS is a file format, not prose");
  const out = formatCitation(FULL, "ris");
  assert.match(out, /TY {2}- JOUR/, "double space before the dash must survive");
});

test("a bulk RIS file concatenates records and ends with a newline", () => {
  const file = formatRisFile([FULL, SPARSE, NOTHING]);
  assert.equal((file.match(/^TY {2}- JOUR$/gm) || []).length, 3);
  assert.equal((file.match(/^ER {2}-$/gm) || []).length, 3);
  assert.ok(file.endsWith("\n"));
});

test("a bulk RIS file of nothing is empty, not malformed", () => {
  assert.equal(formatRisFile([]).trim(), "");
});
