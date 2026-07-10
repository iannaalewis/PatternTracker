# My Pattern Tracker
A crochet pattern tracker that turns a PDF into a read-aloud, row-by-row guide with per-row stitch counters and a built-in chart viewer.

Written crochet patterns usually live in a PDF or a Google Doc, which means squinting at a phone, losing your place mid-row, and counting stitches in your head. This app takes the PDF and turns it into something you can actually crochet from: it pulls out the instructions, splits them into checkable rows, keeps a stitch counter for each one, reads the next step aloud, and remembers exactly where you stopped when you close it. Charts and finished-object photos come along too, so you can glance at them without leaving the pattern.

# Features
PDF import - extracts text in the browser with pdf.js; a born-digital PDF (like a Google Docs "Download as PDF") goes straight through.

Smart parsing - drops the materials list, gauge, and page chrome, rejoins wrapped lines, and pulls the count off each row. Always runs offline; an optional AI cleanup pass tidies messy layouts.

Review before you start - every detected row is shown editable, so you can fix a miscount.

Row-by-row reader - checkable steps, a live row counter, and read-aloud that expands shorthand into plain English ("sc in 3 sts" → "single crochet in three stitches").

Per-row stitch counters - tap to count, pre-loaded with the target from the pattern, resets each row.

Picture viewer - every page rendered to an image; pick a cover and pull up charts alongside the steps.

Saves your place - counts and position persist across sessions.

This is a single-file React component. pdf.js and Tesseract.js load at runtime from a CDN; read-aloud uses the browser's Web Speech API; the AI cleanup step calls the Anthropic API.
