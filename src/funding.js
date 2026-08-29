export const FUNDING_LABELS = {
  industry: "Industry-funded",
  "government/nonprofit": "Public or nonprofit funding",
  mixed: "Mixed funding",
  undisclosed: "Funding not disclosed",
};

export const FUNDING_PATTERNS = {
  industry: [
    /\b(pfizer|merck|msd|novartis|glaxo\s?smith\s?kline|gsk|astra\s?zeneca|sanofi|roche|genentech|bayer|abbott|abbvie|amgen|boehringer|eli\s+lilly|lilly\b|johnson\s*&\s*johnson|janssen|takeda|novo\s+nordisk|teva|bristol[- ]myers|gilead|biogen|moderna|astellas|daiichi|eisai|servier|ferring|orion\s+pharma)\b/i,
    /\b(medtronic|baxter|boston\s+scientific|stryker|philips\s+healthcare|siemens\s+healthineers|becton|edwards\s+lifesciences)\b/i,
    /\b(nestl[eé]|danone|unilever|coca[- ]cola|pepsi|mondelez|kellogg|mars,?\s+inc|herbalife|pharmavite|nature'?s\s+bounty|dsm\b|basf|glanbia|abbott\s+nutrition)\b/i,
    /\b(?:funded|supported|sponsored|financed)\s+(?:in\s+part\s+)?by\s+[^.;]{0,60}\b(inc\.?|ltd\.?|llc|gmbh|corp\.?|corporation|company|co\.,|s\.a\.|a\/s|plc|pharmaceutical[s]?|pharma|biotech|laboratories)\b/i,
    /\b[A-Z][A-Za-z-]+\s+(?:Pharmaceuticals?|Pharma|Biosciences?|Therapeutics|Laboratories|Nutrition)\b/,
    /\b(?:honoraria|consulting fees?|speaker'?s? fees?|research funding|stock options?|shareholder|employee)\s+(?:from|of|in)\s+[A-Z]/,
    /\bis\s+an?\s+employee\s+of\b/i,
    /\bprovided\s+(?:the\s+)?(?:study\s+)?(?:drug|supplement|product|capsules|placebo)\s+(?:free\s+of\s+charge|at\s+no\s+cost)\b/i,
  ],

  "government/nonprofit": [
    /\b(nih|nimh|nhlbi|nci\b|niddk|nia\b|nccih|niaid|ninds|nichd|cdc\b|ahrq|nsf\b|usda)\b/i,
    /\bnational\s+(?:institutes?|cancer institute|heart,?\s+lung|science foundation|center\s+for)\b/i,
    /\b(?:department|office)\s+of\s+veterans affairs|va\s+(?:merit|office of research)\b/i,
    /\b(medical research council|mrc\b|nihr\b|wellcome|cancer research uk|cihr\b|nhmrc\b|arc\b|dfg\b|deutsche forschungsgemeinschaft|european research council|erc\b|horizon\s*20\d\d|european commission|fp7\b|jsps|kakenhi|nrf\b|fapesp|cnpq|conacyt|national natural science foundation of china|nsfc\b|ministry of (?:health|education|science)|national research foundation)\b/i,
    /\b(foundation|fondation|stiftung|charitable trust|charity|trust fund)\b/i,
    /\b(university|universit[aä]t|college|academy of sciences|institute of technology)\s+(?:of\s+\w+\s+)?(?:internal\s+)?(?:research\s+)?(?:grant|fund|funding|support)/i,
    /\bgovernment\s+(?:grant|funding|of)\b/i,
  ],

  none: [
    /\b(?:this (?:research|study|work) )?(?:received|had)\s+no\s+(?:specific\s+)?(?:external\s+)?(?:funding|financial support|grant)\b/i,
    /\bno\s+funding\s+(?:was\s+)?(?:received|obtained|declared|reported)\b/i,
    /\bnot\s+funded\b/i,
    /\bself[- ]funded\b/i,
    /\b(?:authors?\s+)?(?:declares?|report)\s+no\s+(?:conflicts?|competing)\s+(?:of\s+)?interests?\b/i,
    /\bno\s+(?:conflicts?|competing)\s+(?:of\s+)?interests?\b/i,
    /^\s*(?:none|nil|n\/a|not applicable)\.?\s*$/i,
  ],
};

export function classifyFunding(text, patterns = FUNDING_PATTERNS) {
  const input = String(text ?? "").trim();
  if (!input) return result("undisclosed", []);

  const matched = [];
  const industry = patterns.industry.some((re) => hit(re, input, matched, "industry"));
  const public_ = patterns["government/nonprofit"].some((re) =>
    hit(re, input, matched, "government/nonprofit"),
  );

  if (industry && public_) return result("mixed", matched);
  if (industry) return result("industry", matched);
  if (public_) return result("government/nonprofit", matched);

  // "No competing interests" still does not say who paid.
  return result("undisclosed", matched);
}

function hit(re, input, matched, kind) {
  const found = input.match(re);
  if (found) matched.push(`${kind}: ${found[0].trim().slice(0, 60)}`);
  return Boolean(found);
}

function result(source, matched) {
  return { source, label: FUNDING_LABELS[source], matched };
}

export function declaredNoFunding(text, patterns = FUNDING_PATTERNS) {
  const input = String(text ?? "").trim();
  return Boolean(input) && patterns.none.some((re) => re.test(input));
}
