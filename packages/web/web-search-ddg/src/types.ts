/**
 * Boundary types for the DuckDuckGo HTML search endpoint
 * (`GET https://html.duckduckgo.com/html/?q=…`). The endpoint is keyless and
 * returns server-rendered HTML; results are `a.result__a` anchors whose
 * `href` may be a DDG-cloaked `/l/?uddg=<percent-encoded url>` redirect,
 * with the snippet in a sibling `a.result__snippet`. No JSON schema exists —
 * the types describe the parse unit only.
 *
 * @module @deepseek-ai/dsh-web-search-ddg/types
 */

/** One parse unit: the result anchor plus its trailing snippet. */
export interface DdgHtmlEntry {
  /** Raw `href` of the `result__a` anchor, possibly a `/l/?uddg=…` wrapper. */
  href: string
  /** Anchor text — the result title. */
  title: string
  /** Text of the following `result__snippet` element, when the page carries one. */
  snippet?: string
}
