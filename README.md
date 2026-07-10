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

Project library - every pattern you import is saved as its own project on a home screen, each with a progress bar showing how far along it is.

Progress & completion - each project carries an in-progress or finished status and records when you started and finished; a pattern marks itself finished once every row is checked off.

Activity log - keeps a per-day record of how many rows you completed, viewable as a dated history for each project.

This is a single-file React component. pdf.js and Tesseract.js load at runtime from a CDN; read-aloud uses the browser's Web Speech API; the AI cleanup step calls the Anthropic API.

<img width="1688" height="1189" alt="myPatternTracker" src="https://github.com/user-attachments/assets/b0bf978a-d450-431e-aa13-bd64c799bdf8" />

<img width="1650" height="1192" alt="myPatternTracker(1)" src="https://github.com/user-attachments/assets/452d0644-af43-4091-a35d-c70c548af71d" />

<img width="1482" height="1191" alt="myPatternTracker(2)" src="https://github.com/user-attachments/assets/af0ebaf3-6533-4c53-981f-8cdf946e1f4f" />


