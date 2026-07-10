import { useState, useEffect, useRef, useCallback } from "react";
import {
  Flower2, UploadCloud, Clipboard, Loader2, Sparkles, Check,
  Trash2, Plus, Volume2, ChevronLeft, ChevronRight, AlertTriangle, RotateCcw,
  Image as ImageIcon, Star, X
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  CDN libs loaded at runtime (browser only). pdf.js for text,        */
/*  Tesseract for OCR fallback on scanned PDFs.                        */
/* ------------------------------------------------------------------ */
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const TESSERACT = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js";

function loadScript(src) {
  return new Promise((res, rej) => {
    if ([...document.scripts].some((s) => s.src === src)) return res();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => res();
    s.onerror = () => rej(new Error("Couldn't load " + src));
    document.head.appendChild(s);
  });
}

/* ------------------------------------------------------------------ */
/*  Persistence — survives closing the app.                            */
/* ------------------------------------------------------------------ */
const store = {
  async get(k) {
    try { if (!window.storage) return null; const r = await window.storage.get(k); return r ? JSON.parse(r.value) : null; }
    catch { return null; }
  },
  async set(k, v) {
    try { if (!window.storage) return; await window.storage.set(k, JSON.stringify(v)); } catch {}
  },
};

/* ------------------------------------------------------------------ */
/*  Parsing helpers                                                    */
/* ------------------------------------------------------------------ */
const ROW_RE = /^\s*(rows?|rnds?|rounds?|r)\s*\.?\s*\d+/i;
const NOISE_RE = /^(materials?|gauge|hooks?|yarns?|abbreviations?|notes?|finished (size|measurements)|difficulty|skill level|you will need|supplies|copyright|all rights|©|page\s*\d|www\.|http|pattern by|designed by)/i;
const STS_RE = /\((\d+)\s*(sts?|stitches|dc|sc|hdc)?\.?\)\s*$/i;

function extractSts(line) {
  const m = line.match(STS_RE);
  return m ? Number(m[1]) : null;
}

/* Text -> steps. Drops obvious non-instruction lines, then rejoins    */
/* wrapped lines under the row they belong to.                         */
function localParse(raw) {
  let lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((l) => !NOISE_RE.test(l));

  const steps = [];
  let cur = null;
  for (const l of lines) {
    if (ROW_RE.test(l)) {
      if (cur) steps.push(cur);
      cur = l;
    } else if (cur) {
      cur += " " + l; // continuation of the current row
    } else {
      steps.push(l); // setup line before the first row
    }
  }
  if (cur) steps.push(cur);
  return steps.map((text) => ({ text, sts: extractSts(text), isRow: ROW_RE.test(text) }));
}

/* Expand shorthand only for the spoken version */
const SPOKEN = [
  [/\bsl\s?st\b/gi, "slip stitch"], [/\bsc2tog\b/gi, "single crochet two together"],
  [/\bdc2tog\b/gi, "double crochet two together"], [/\bhdc\b/gi, "half double crochet"],
  [/\btr\b/gi, "treble crochet"], [/\bdc\b/gi, "double crochet"], [/\bsc\b/gi, "single crochet"],
  [/\bch\b/gi, "chain"], [/\bsts\b/gi, "stitches"], [/\bst\b/gi, "stitch"],
  [/\brnds\b/gi, "rounds"], [/\brnd\b/gi, "round"], [/\byo\b/gi, "yarn over"],
  [/\bsk\b/gi, "skip"], [/\binc\b/gi, "increase"], [/\bdec\b/gi, "decrease"],
  [/\brep\b/gi, "repeat"], [/\btog\b/gi, "together"], [/\*/g, " repeat from "],
];
const speakable = (l) => SPOKEN.reduce((t, [re, r]) => t.replace(re, r), l);

export default function App() {
  const [stage, setStage] = useState("input"); // input | working | review | read
  const [status, setStatus] = useState("");
  const [pct, setPct] = useState(null);
  const [warn, setWarn] = useState("");
  const [rawText, setRawText] = useState("");
  const [pasteMode, setPasteMode] = useState(false);
  const [pasteVal, setPasteVal] = useState("");
  const [steps, setSteps] = useState([]);
  const [aiBusy, setAiBusy] = useState(false);

  /* reader state */
  const [current, setCurrent] = useState(0);
  const [checked, setChecked] = useState([]);
  const [autoRead, setAutoRead] = useState(true);
  const [stitch, setStitch] = useState([]); // per-row stitch count, indexed by step
  const [pages, setPages] = useState([]); // { url } per rendered page
  const [cover, setCover] = useState(null); // index of chosen cover image
  const [viewer, setViewer] = useState(null); // page index open in full view, or null
  const stepRefs = useRef([]);
  const [drag, setDrag] = useState(false);

  const bumpStitch = (i, dir) =>
    setStitch((arr) => { const n = [...arr]; n[i] = Math.max(0, (n[i] || 0) + dir); return n; });
  const resetStitch = (i) =>
    setStitch((arr) => { const n = [...arr]; n[i] = 0; return n; });

  /* restore a saved project */
  useEffect(() => {
    (async () => {
      const saved = await store.get("ap_project");
      if (saved && saved.steps && saved.steps.length) {
        setSteps(saved.steps);
        setCurrent(saved.current || 0);
        setChecked(saved.checked || []);
        setStitch(saved.stitch || []);
        setStage("read");
      }
    })();
  }, []);
  useEffect(() => {
    if (stage === "read") store.set("ap_project", { steps, current, checked, stitch });
  }, [stage, steps, current, checked, stitch]);

  /* ---------------- extraction ---------------- */
  async function extractPdf(file) {
    await loadScript(PDFJS);
    const pdfjsLib = window.pdfjsLib;
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let out = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      setStatus(`Reading page ${i} of ${pdf.numPages}…`);
      setPct(i / pdf.numPages);
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      // group items into lines by y, then order by x — decent single-column reading order
      const rows = {};
      for (const it of content.items) {
        if (!it.str) continue;
        const y = Math.round(it.transform[5]);
        (rows[y] = rows[y] || []).push({ x: it.transform[4], s: it.str });
      }
      Object.keys(rows)
        .map(Number)
        .sort((a, b) => b - a)
        .forEach((y) => {
          out += rows[y].sort((a, b) => a.x - b.x).map((o) => o.s).join(" ") + "\n";
        });
      out += "\n";
    }
    return { text: out, pdf };
  }

  async function ocrPdf(pdf) {
    await loadScript(TESSERACT);
    const T = window.Tesseract;
    if (!T) throw new Error("OCR unavailable");
    const pages = Math.min(pdf.numPages, 6);
    let out = "";
    for (let i = 1; i <= pages; i++) {
      setStatus(`Scanning image, page ${i} of ${pages}…`);
      setPct(i / pages);
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = vp.width;
      canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      const { data } = await T.recognize(canvas, "eng");
      out += (data.text || "") + "\n";
    }
    return out;
  }

  /* Render each page to a JPEG for the gallery / chart viewer. Charts  */
  /* are often vector art with no embedded photo, so rasterizing the    */
  /* whole page is what reliably captures them.                         */
  async function renderPages(pdf) {
    const max = Math.min(pdf.numPages, 12);
    const imgs = [];
    for (let i = 1; i <= max; i++) {
      setStatus(`Rendering picture ${i} of ${max}…`);
      setPct(i / max);
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 1.4 });
      const canvas = document.createElement("canvas");
      canvas.width = vp.width;
      canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      imgs.push({ url: canvas.toDataURL("image/jpeg", 0.82) });
    }
    return imgs;
  }

  async function handleFile(file) {
    setWarn("");
    setStage("working");
    setPct(null);
    try {
      if (file.name.toLowerCase().endsWith(".txt")) {
        setStatus("Reading text…");
        const t = await file.text();
        finishExtract(t);
        return;
      }
      setStatus("Opening PDF…");
      const { text, pdf } = await extractPdf(file);
      const imgs = await renderPages(pdf);
      setPages(imgs);
      setCover(imgs.length ? 0 : null);
      if (text.replace(/\s/g, "").length < 40) {
        // looks scanned — try OCR
        setStatus("No text found — this looks scanned. Trying OCR…");
        try {
          const ocr = await ocrPdf(pdf);
          setWarn("Read with OCR — double-check the rows below, OCR can misread.");
          finishExtract(ocr);
        } catch {
          setWarn("This PDF has no selectable text and OCR couldn't run. If it's a symbol chart, it can't be parsed as steps — you'd view it as an image instead. You can also paste the text manually.");
          setStage("input");
          setPasteMode(true);
        }
        return;
      }
      finishExtract(text);
    } catch (e) {
      setWarn("Couldn't read that file. Try exporting from Google Docs as PDF, or paste the text instead.");
      setStage("input");
    }
  }

  function finishExtract(text) {
    setRawText(text);
    const parsed = localParse(text);
    if (parsed.length === 0) {
      setWarn("Nothing looked like instructions. Paste the text so you can pick the rows out manually.");
      setStage("input");
      setPasteMode(true);
      setPasteVal(text);
      return;
    }
    setSteps(parsed);
    setStage("review");
  }

  /* ---------------- AI cleanup ---------------- */
  async function aiCleanup() {
    setAiBusy(true);
    setWarn("");
    try {
      const prompt =
        "You clean crochet patterns pulled from a PDF. Return ONLY a JSON array, no prose, no markdown fences. " +
        "Each item: {\"text\": string instruction, \"sts\": number or null, \"isRow\": boolean}. " +
        "Remove materials lists, gauge, hook/yarn info, abbreviation keys, page numbers, and copyright lines. " +
        "Rejoin lines that wrapped mid-instruction. Expand ranges like 'Rows 2-5: ...' into one item per row. " +
        "Set isRow true when the instruction is a numbered row or round. Pattern text:\n\n" +
        rawText.slice(0, 6000);
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await res.json();
      const txt = data.content.map((c) => c.text || "").join("").replace(/```json|```/g, "").trim();
      const arr = JSON.parse(txt);
      if (Array.isArray(arr) && arr.length) {
        setSteps(
          arr.map((o) => ({
            text: String(o.text || "").trim(),
            sts: o.sts ?? extractSts(String(o.text || "")),
            isRow: o.isRow ?? ROW_RE.test(String(o.text || "")),
          }))
        );
      } else {
        setWarn("The cleanup came back empty — keeping the basic parse.");
      }
    } catch {
      setWarn("AI cleanup didn't run (long patterns can exceed the limit). The basic parse below still works.");
    }
    setAiBusy(false);
  }

  /* ---------------- reader ---------------- */
  const speak = useCallback((text) => {
    try {
      const s = window.speechSynthesis;
      if (!s || !text) return;
      s.cancel();
      const u = new SpeechSynthesisUtterance(speakable(text));
      u.rate = 0.95;
      s.speak(u);
    } catch {}
  }, []);
  const goTo = useCallback(
    (i) => {
      const c = Math.max(0, Math.min(steps.length - 1, i));
      setCurrent(c);
      const el = stepRefs.current[c];
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      if (autoRead) speak(steps[c]?.text);
    },
    [steps, autoRead, speak]
  );
  const advance = () => {
    setChecked((ch) => { const n = [...ch]; n[current] = true; return n; });
    goTo(current + 1);
  };
  useEffect(() => () => window.speechSynthesis && window.speechSynthesis.cancel(), []);

  const rowsTotal = steps.filter((s) => s.isRow).length;
  const rowsDone = steps.reduce((n, s, i) => (s.isRow && checked[i] ? n + 1 : n), 0);

  const css = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap');
  * { box-sizing:border-box; }
  .ap{ --paper:#EAE3D6; --card:#F6F2E9; --ink:#1C2B36; --ink2:#42535E; --rope:#B07C4F;
    --rope-d:#8F6238; --sage:#7C8F7B; --line:rgba(28,43,54,.14); --err:#a2412f;
    font-family:'DM Sans',system-ui,sans-serif; color:var(--ink); background:var(--paper); min-height:100vh;
    background-image:radial-gradient(rgba(28,43,54,.035) 1px,transparent 1px); background-size:7px 7px;}
  .wrap{ max-width:720px; margin:0 auto; padding:22px 18px 80px;}
  .head{ display:flex; align-items:center; gap:11px; margin-bottom:22px;}
  .mark{ width:38px;height:38px;border-radius:12px;background:#5F3E1E;display:flex;align-items:center;justify-content:center;color:#FBF3E3;flex:none;}
  .ttl{ font-family:'Fraunces',serif; font-weight:600; font-size:22px; line-height:1;}
  .subttl{ font-family:'DM Mono',monospace; font-size:12px; letter-spacing:1px; text-transform:uppercase; color:var(--rope-d); margin-top:5px;}
  .sub{ font-size:12.5px; color:var(--ink2); margin-top:2px;}
  .drop{ border:2px dashed var(--line); border-radius:20px; background:var(--card); padding:44px 24px; text-align:center; transition:.18s; cursor:pointer; display:block;}
  .drop.hot{ border-color:var(--rope); background:#fff;}
  .drop h3{ font-family:'Fraunces',serif; font-weight:600; font-size:19px; margin:14px 0 6px;}
  .drop p{ color:var(--ink2); font-size:13.5px; margin:0 auto; max-width:400px; line-height:1.5;}
  .alt{ display:flex; gap:10px; justify-content:center; margin-top:18px;}
  .btn{ font-family:inherit; font-weight:600; font-size:14px; border:none; border-radius:12px; padding:11px 17px; cursor:pointer; display:inline-flex; align-items:center; gap:8px;}
  .btn.primary{ background:var(--ink); color:var(--paper);}
  .btn.rope{ background:var(--rope); color:#fff;}
  .btn.ghost{ background:transparent; color:var(--ink2); border:1px solid var(--line);}
  .btn:disabled{ opacity:.55; cursor:default;}
  .ta{ width:100%; min-height:220px; resize:vertical; font-family:'DM Mono',monospace; font-size:13.5px; line-height:1.55; padding:15px; border:1px solid var(--line); border-radius:16px; background:var(--card); color:var(--ink); outline:none;}
  .ta:focus{ border-color:var(--rope);}
  .working{ text-align:center; padding:60px 20px;}
  .spin{ animation:spin 1s linear infinite;}
  @keyframes spin{ to{ transform:rotate(360deg);} }
  .prog{ height:6px; background:rgba(28,43,54,.1); border-radius:6px; max-width:320px; margin:20px auto 0; overflow:hidden;}
  .prog span{ display:block; height:100%; background:var(--sage); transition:width .3s;}
  .warn{ display:flex; gap:10px; align-items:flex-start; background:rgba(162,65,47,.09); border:1px solid rgba(162,65,47,.25); color:var(--err); border-radius:12px; padding:12px 14px; font-size:13px; line-height:1.5; margin-bottom:16px;}
  .rowhdr{ display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; flex-wrap:wrap; gap:10px;}
  .rowhdr h3{ font-family:'Fraunces',serif; font-weight:600; font-size:18px; margin:0;}
  .rowhdr .n{ font-family:'DM Mono',monospace; font-size:12.5px; color:var(--ink2);}
  .rev{ display:flex; flex-direction:column; gap:8px;}
  .revrow{ display:flex; gap:10px; align-items:flex-start; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:10px 12px;}
  .revrow.row-mark{ border-left:3px solid var(--sage);}
  .revrow textarea{ flex:1; border:none; background:transparent; font-family:'DM Mono',monospace; font-size:13.5px; line-height:1.5; color:var(--ink); resize:none; outline:none; overflow:hidden;}
  .stsb{ font-family:'DM Mono',monospace; font-size:11px; color:var(--sage); background:rgba(124,143,123,.14); padding:3px 7px; border-radius:6px; white-space:nowrap; margin-top:2px;}
  .xb{ background:none; border:none; color:var(--ink2); cursor:pointer; padding:4px; flex:none;}
  .xb:hover{ color:var(--err);}
  .bar{ display:flex; gap:9px; align-items:center; flex-wrap:wrap; margin-top:20px; position:sticky; bottom:0; background:var(--paper); padding:14px 0 6px; border-top:1px solid var(--line);}
  .grow{ flex:1;}
  .chip{ display:inline-flex; align-items:center; gap:6px; font-family:'DM Mono',monospace; font-size:12.5px; color:var(--ink2); background:rgba(28,43,54,.06); padding:7px 12px; border-radius:20px;}
  .steps{ display:flex; flex-direction:column; gap:8px; margin-top:14px;}
  .step{ display:flex; gap:12px; align-items:flex-start; padding:13px 15px; border-radius:14px; border:1px solid transparent; background:var(--card); cursor:pointer; transition:.15s; opacity:.6;}
  .step.done{ opacity:.4;}
  .step.cur{ opacity:1; border-color:var(--rope); background:#fff; box-shadow:0 2px 12px rgba(176,124,79,.16);}
  .box{ width:22px;height:22px;border-radius:7px;border:1.5px solid var(--line);flex:none;margin-top:1px;display:flex;align-items:center;justify-content:center;color:#fff;}
  .box.on{ background:var(--sage); border-color:var(--sage);}
  .step-t{ font-size:14.5px; line-height:1.5;}
  .step.row-mark .step-t{ font-family:'Fraunces',serif; font-weight:600;}
  .rtag{ font-family:'DM Mono',monospace; font-size:10px; letter-spacing:1px; text-transform:uppercase; color:var(--sage); margin-bottom:2px;}
  .rowsc{ display:flex; align-items:center; gap:8px; margin-top:11px; flex-wrap:wrap;}
  .sclbl{ font-family:'DM Mono',monospace; font-size:10px; letter-spacing:.5px; text-transform:uppercase; color:var(--ink2);}
  .scmini{ width:30px;height:30px;border-radius:9px;border:1px solid var(--line);background:var(--paper);color:var(--ink);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:17px;line-height:1;flex:none;}
  .scmini:hover{ background:#fff;}
  .scnum{ display:inline-flex; align-items:baseline; gap:5px; border:1px solid var(--rope); background:#fff; color:var(--ink); border-radius:10px; padding:5px 14px; cursor:pointer; min-width:64px; justify-content:center;}
  .scnum:hover{ background:var(--paper);}
  .scv{ font-family:'Fraunces',serif; font-weight:600; font-size:20px; line-height:1; font-variant-numeric:tabular-nums;}
  .scof{ font-family:'DM Mono',monospace; font-size:12px; color:var(--ink2);}
  .rowsc.done .scnum{ border-color:var(--sage); background:rgba(124,143,123,.12);}
  .scok{ display:inline-flex; align-items:center; gap:4px; font-size:11.5px; font-weight:600; color:var(--sage);}
  .toggle{ display:inline-flex; align-items:center; gap:7px; font-size:13px; color:var(--ink2); cursor:pointer; user-select:none;}
  .sw{ width:38px;height:22px;border-radius:20px;background:rgba(28,43,54,.2);position:relative;transition:.18s;flex:none;}
  .sw.on{ background:var(--sage);}
  .sw::after{ content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.18s;}
  .sw.on::after{ left:18px;}
  .cbtn{ width:42px;height:42px;border-radius:12px;border:1px solid var(--line);background:var(--card);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--ink);}
  .cbtn:disabled{ opacity:.4; cursor:default;}
  .thumbs{ display:grid; grid-template-columns:repeat(auto-fill,minmax(96px,1fr)); gap:10px;}
  .thumb{ position:relative; padding:0; border:1px solid var(--line); border-radius:12px; overflow:hidden; cursor:pointer; background:#fff; aspect-ratio:3/4;}
  .thumb.cov{ border:2px solid var(--rope);}
  .thumb img{ width:100%; height:100%; object-fit:cover; display:block;}
  .covtag{ position:absolute; left:6px; bottom:6px; display:inline-flex; align-items:center; gap:4px; font-size:10px; font-weight:600; color:#fff; background:var(--rope); padding:3px 7px; border-radius:20px;}
  .overlay{ position:fixed; inset:0; background:rgba(28,20,10,.72); display:flex; align-items:center; justify-content:center; padding:20px; z-index:50;}
  .viewer{ background:var(--paper); border-radius:16px; max-width:680px; width:100%; max-height:92vh; display:flex; flex-direction:column; overflow:hidden;}
  .vtop{ display:flex; align-items:center; gap:8px; padding:12px 14px; border-bottom:1px solid var(--line);}
  .vnum{ font-family:'DM Mono',monospace; font-size:12.5px; color:var(--ink2);}
  .vimg{ overflow:auto; padding:14px; background:rgba(28,43,54,.05); flex:1; display:flex; justify-content:center;}
  .vimg img{ max-width:100%; height:auto; border-radius:8px; box-shadow:0 4px 20px rgba(28,43,54,.18); align-self:flex-start;}
  .vnav{ display:flex; justify-content:center; gap:14px; padding:12px; border-top:1px solid var(--line);}
  @media (prefers-reduced-motion:reduce){ *{ transition:none!important; animation:none!important;} }
  button:focus-visible,textarea:focus-visible{ outline:2px solid var(--rope); outline-offset:2px;}
  `;

  return (
    <div className="ap">
      <style>{css}</style>
      <div className="wrap">
        <div className="head">
          <div className="mark"><Flower2 size={21} /></div>
          <div>
            <div className="ttl">create with ianna</div>
            <div className="subttl">my pattern tracker</div>
            <div className="sub">Drop in a PDF and crochet it row by row.</div>
          </div>
        </div>

        {warn && (
          <div className="warn"><AlertTriangle size={17} style={{ flex: "none", marginTop: 1 }} /><span>{warn}</span></div>
        )}

        {/* ---------------- INPUT ---------------- */}
        {stage === "input" && (
          <div>
            {!pasteMode ? (
              <>
                <label
                  className={"drop" + (drag ? " hot" : "")}
                  onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                  onDragLeave={() => setDrag(false)}
                  onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}
                >
                  <UploadCloud size={40} color="var(--rope)" strokeWidth={1.6} />
                  <h3>Drop a pattern PDF here</h3>
                  <p>Or click to browse. From Google Docs, use File → Download → PDF first — a shared link won't work. Text files are fine too.</p>
                  <input type="file" accept=".pdf,.txt" style={{ display: "none" }}
                    onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])} />
                </label>
                <div className="alt">
                  <button className="btn ghost" onClick={() => setPasteMode(true)}><Clipboard size={16} /> Paste text instead</button>
                </div>
              </>
            ) : (
              <div>
                <textarea className="ta" placeholder={"Paste the written pattern — one instruction per line.\n\nRow 1: ch 20, sc in 2nd ch from hook, sc across (19 sts)\nRow 2: ch 1, turn, sc in each st across"}
                  value={pasteVal} onChange={(e) => setPasteVal(e.target.value)} />
                <div style={{ display: "flex", gap: 9, marginTop: 12 }}>
                  <button className="btn primary" disabled={!pasteVal.trim()} onClick={() => { setWarn(""); setPages([]); setCover(null); finishExtract(pasteVal); }}>
                    <Check size={17} /> Parse it
                  </button>
                  <button className="btn ghost" onClick={() => { setPasteMode(false); setWarn(""); }}>Back to upload</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ---------------- WORKING ---------------- */}
        {stage === "working" && (
          <div className="working">
            <Loader2 size={34} className="spin" color="var(--rope)" />
            <p style={{ marginTop: 16, fontSize: 15, color: "var(--ink2)" }}>{status}</p>
            {pct !== null && <div className="prog"><span style={{ width: Math.round(pct * 100) + "%" }} /></div>}
          </div>
        )}

        {/* ---------------- REVIEW ---------------- */}
        {stage === "review" && (
          <div>
            <div className="rowhdr">
              <h3>Check the rows before you start</h3>
              <span className="n">{steps.length} steps · {rowsTotal} rows</span>
            </div>
            <p style={{ color: "var(--ink2)", fontSize: 13.5, margin: "0 0 14px", lineHeight: 1.5 }}>
              Parsing gets you most of the way. Fix any merged or miscounted lines here, or let Claude clean it up — then start crocheting.
            </p>
            <div style={{ display: "flex", gap: 9, marginBottom: 16, flexWrap: "wrap" }}>
              <button className="btn rope" onClick={aiCleanup} disabled={aiBusy}>
                {aiBusy ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
                {aiBusy ? "Cleaning up…" : "Clean up with AI"}
              </button>
              <button className="btn ghost" onClick={() => setSteps((s) => [...s, { text: "New row", sts: null, isRow: true }])}>
                <Plus size={16} /> Add row
              </button>
            </div>

            {pages.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div className="rowhdr" style={{ marginBottom: 8 }}>
                  <h3 style={{ fontSize: 15 }}>Pictures from this pattern</h3>
                  <span className="n">tap to view · star sets the cover</span>
                </div>
                <div className="thumbs">
                  {pages.map((p, i) => (
                    <button key={i} className={"thumb" + (cover === i ? " cov" : "")} onClick={() => setViewer(i)}>
                      <img src={p.url} alt={"Page " + (i + 1)} />
                      {cover === i && <span className="covtag"><Star size={11} fill="currentColor" /> cover</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="rev">
              {steps.map((s, i) => (
                <div key={i} className={"revrow" + (s.isRow ? " row-mark" : "")}>
                  <textarea
                    rows={1}
                    value={s.text}
                    ref={(el) => { if (el) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; } }}
                    onChange={(e) => setSteps((arr) => arr.map((x, j) => j === i ? { ...x, text: e.target.value, sts: extractSts(e.target.value), isRow: ROW_RE.test(e.target.value) } : x))}
                  />
                  {s.sts != null && <span className="stsb">{s.sts} sts</span>}
                  <button className="xb" onClick={() => setSteps((arr) => arr.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 size={16} /></button>
                </div>
              ))}
            </div>

            <div className="bar">
              <button className="btn ghost" onClick={() => { setStage("input"); setPasteMode(false); setPages([]); setCover(null); }}>Start over</button>
              <div className="grow" />
              <button className="btn primary" disabled={!steps.length} onClick={() => { setChecked([]); setStitch([]); setCurrent(0); setStage("read"); if (autoRead) speak(steps[0]?.text); }}>
                <Check size={17} /> Start crocheting
              </button>
            </div>
          </div>
        )}

        {/* ---------------- READ ---------------- */}
        {stage === "read" && (
          <div>
            <div className="rowhdr">
              <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                <span className="chip">Row {rowsDone}{rowsTotal ? " / " + rowsTotal : ""}</span>
                <span className="chip">Step {Math.min(current + 1, steps.length)} / {steps.length}</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {pages.length > 0 && (
                  <button className="btn ghost" style={{ padding: "9px 14px", fontSize: 13.5 }}
                    onClick={() => setViewer(cover ?? 0)}>
                    <ImageIcon size={15} /> Chart
                  </button>
                )}
                <button className="btn ghost" style={{ padding: "9px 14px", fontSize: 13.5 }}
                  onClick={() => { store.set("ap_project", null); setStage("input"); setSteps([]); setChecked([]); setStitch([]); setCurrent(0); setPasteMode(false); setPages([]); setCover(null); }}>
                  <RotateCcw size={15} /> New pattern
                </button>
              </div>
            </div>

            <div className="steps">
              {steps.map((s, i) => (
                <div key={i} ref={(el) => (stepRefs.current[i] = el)}
                  className={"step" + (i === current ? " cur" : "") + (checked[i] ? " done" : "") + (s.isRow ? " row-mark" : "")}
                  onClick={() => { setChecked((ch) => { const n = [...ch]; n[i] = !n[i]; return n; }); goTo(i); }}>
                  <div className={"box" + (checked[i] ? " on" : "")}>{checked[i] && <Check size={14} strokeWidth={3} />}</div>
                  <div style={{ flex: 1 }}>
                    {s.isRow && <div className="rtag">new row</div>}
                    <div className="step-t">{s.text}</div>
                    {s.isRow && (() => {
                      const cnt = stitch[i] || 0;
                      const done = s.sts != null && cnt >= s.sts;
                      return (
                        <div className={"rowsc" + (done ? " done" : "")} onClick={(e) => e.stopPropagation()}>
                          <span className="sclbl">stitches</span>
                          <button className="scmini" onClick={() => bumpStitch(i, -1)} aria-label="One fewer stitch">−</button>
                          <button className="scnum" onClick={() => bumpStitch(i, 1)} aria-label="Count a stitch">
                            <span className="scv">{cnt}</span>
                            {s.sts != null && <span className="scof">/ {s.sts}</span>}
                          </button>
                          <button className="scmini" onClick={() => bumpStitch(i, 1)} aria-label="One more stitch">+</button>
                          <button className="scmini" onClick={() => resetStitch(i)} aria-label="Reset this row"><RotateCcw size={13} /></button>
                          {done && <span className="scok"><Check size={13} strokeWidth={3} /> row done</span>}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              ))}
            </div>

            <div className="bar">
              <button className="cbtn" onClick={() => goTo(current - 1)} aria-label="Previous"><ChevronLeft size={20} /></button>
              <button className="btn ghost" onClick={() => speak(steps[current]?.text)}><Volume2 size={17} /> Read</button>
              <button className="btn primary grow" onClick={advance}>Done — next <ChevronRight size={18} /></button>
              <label className="toggle" onClick={() => setAutoRead((v) => !v)}>
                <span className={"sw" + (autoRead ? " on" : "")} /> Auto-read
              </label>
            </div>
          </div>
        )}
      </div>

      {viewer !== null && pages[viewer] && (
        <div className="overlay" onClick={() => setViewer(null)}>
          <div className="viewer" onClick={(e) => e.stopPropagation()}>
            <div className="vtop">
              <span className="vnum">Page {viewer + 1} of {pages.length}</span>
              <div style={{ flex: 1 }} />
              <button className="btn ghost" style={{ padding: "8px 12px", fontSize: 13 }} onClick={() => setCover(viewer)}>
                <Star size={14} fill={cover === viewer ? "currentColor" : "none"} /> {cover === viewer ? "Cover" : "Set as cover"}
              </button>
              <button className="cbtn" onClick={() => setViewer(null)} aria-label="Close"><X size={19} /></button>
            </div>
            <div className="vimg">
              <img src={pages[viewer].url} alt={"Page " + (viewer + 1)} />
            </div>
            {pages.length > 1 && (
              <div className="vnav">
                <button className="cbtn" disabled={viewer === 0} onClick={() => setViewer((v) => Math.max(0, v - 1))} aria-label="Previous page"><ChevronLeft size={20} /></button>
                <button className="cbtn" disabled={viewer === pages.length - 1} onClick={() => setViewer((v) => Math.min(pages.length - 1, v + 1))} aria-label="Next page"><ChevronRight size={20} /></button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
