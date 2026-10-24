---
"@artblocks/abx-sdk": patch
"@artblocks/abx-cli": patch
---

`abx inspect` now warns when a `<!--` followed by `<script` in the script source would leave the generated inline `<script>` unterminated (the browser swallows the rest of the document and never runs the program). `analyzeScript` exposes this as `inlineHtml: {unterminated, at}`, and `inlineScriptUnterminatedAt` is exported from the SDK.
