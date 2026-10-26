---
"@artblocks/abx-sdk": minor
"@artblocks/abx-cli": minor
---

Drop-in for existing SDK callers; new consumers can detect an inline script the HTML parser will never close. `abx inspect` now warns when a `<!--` followed by `<script` in the script source would leave the generated inline `<script>` unterminated (the browser swallows the rest of the document and never runs the program). `analyzeScript` reports this as an optional `inlineHtml: {unterminated, at}`, and the SDK exports `inlineScriptUnterminatedAt`.
