import { useState, useEffect, useRef, useCallback } from "react";
import {
  Flower2, UploadCloud, Clipboard, Loader2, Sparkles, Check,
  Trash2, Plus, Volume2, ChevronLeft, ChevronRight, AlertTriangle, RotateCcw,
  Image as ImageIcon, Star, X, ArrowLeft, CheckCircle2, Clock, CalendarDays, History
} from "lucide-react";

/* ---------- runtime CDN libs ---------- */
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const TESSERACT = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js";

function loadScript(src) {
  return new Promise((res, rej) => {
    if ([...document.scripts].some((s) => s.src === src)) return res();
    const s = document.createElement("script");
    s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error("load " + src));
    document.head.appendChild(s);
  });
}

/* ---------- persistence ---------- */
const store = {
  async get(k) { try { if (!window.storage) return null; const r = await window.storage.get(k); return r ? JSON.parse(r.value) : null; } catch { return null; } },
  async set(k, v) { try { if (!window.storage) return; await window.storage.set(k, JSON.stringify(v)); } catch {} },
  async del(k) { try { if (!window.storage) return; await window.storage.delete(k); } catch {} },
};

/* ---------- parsing ---------- */
const ROW_RE = /^\s*(rows?|rnds?|rounds?|r)\s*\.?\s*\d+/i;
const NOISE_RE = /^(materials?|gauge|hooks?|yarns?|abbreviations?|notes?|finished (size|measurements)|difficulty|skill level|you will need|supplies|copyright|all rights|©|page\s*\d|www\.|http|pattern by|designed by)/i;
const STS_RE = /\((\d+)\s*(sts?|stitches|dc|sc|hdc)?\.?\)\s*$/i;
const extractSts = (l) => { const m = l.match(STS_RE); return m ? Number(m[1]) : null; };

function localParse(raw) {
  let lines = raw.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).filter((l) => !NOISE_RE.test(l));
  const steps = []; let cur = null;
  for (const l of lines) {
    if (ROW_RE.test(l)) { if (cur) steps.push(cur); cur = l; }
    else if (cur) cur += " " + l;
    else steps.push(l);
  }
  if (cur) steps.push(cur);
  return steps.map((text) => ({ text, sts: extractSts(text), isRow: ROW_RE.test(text) }));
}

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

const fmtDate = (ts) => ts ? new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
const rowStats = (steps, checked) => {
  const total = steps.filter((s) => s.isRow).length;
  const done = steps.reduce((n, s, i) => (s.isRow && checked[i] ? n + 1 : n), 0);
  return { total, done };
};
const summarize = (p) => {
  const { total, done } = rowStats(p.steps, p.checked);
  return { id: p.id, name: p.name, status: p.status, created: p.created, completed: p.completed, updated: p.updated, rowsTotal: total, rowsDone: done };
};

export default function App() {
  const [stage, setStage] = useState("library"); // library | input | working | review | read

  /* import */
  const [status, setStatus] = useState("");
  const [pct, setPct] = useState(null);
  const [warn, setWarn] = useState("");
  const [rawText, setRawText] = useState("");
  const [pasteMode, setPasteMode] = useState(false);
  const [pasteVal, setPasteVal] = useState("");
  const [steps, setSteps] = useState([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [importName, setImportName] = useState("Untitled pattern");
  const [drag, setDrag] = useState(false);

  /* reader */
  const [current, setCurrent] = useState(0);
  const [checked, setChecked] = useState([]);
  const [stitch, setStitch] = useState([]);
  const [autoRead, setAutoRead] = useState(true);
  const [pages, setPages] = useState([]);
  const [cover, setCover] = useState(null);
  const [viewer, setViewer] = useState(null);
  const stepRefs = useRef([]);

  /* projects */
  const [projects, setProjects] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [meta, setMeta] = useState(null); // { id,name,status,created,completed,log }
  const [historyData, setHistoryData] = useState(null); // { name, log } for modal
  const prevRows = useRef(0);
  const saveTimer = useRef(null);

  /* ---------- load library ---------- */
  useEffect(() => {
    (async () => {
      const idx = await store.get("ap_index");
      if (Array.isArray(idx)) setProjects(idx);
    })();
  }, []);

  const persistIndex = (list) => { setProjects(list); store.set("ap_index", list); };
  const upsertIndex = (proj) => {
    setProjects((prev) => {
      const s = summarize(proj);
      const i = prev.findIndex((p) => p.id === proj.id);
      const list = i === -1 ? [s, ...prev] : prev.map((p) => (p.id === proj.id ? s : p));
      store.set("ap_index", list);
      return list;
    });
  };

  const bumpStitch = (i, d) => setStitch((a) => { const n = [...a]; n[i] = Math.max(0, (n[i] || 0) + d); return n; });
  const resetStitch = (i) => setStitch((a) => { const n = [...a]; n[i] = 0; return n; });

  /* ---------- extraction ---------- */
  async function extractPdf(file) {
    await loadScript(PDFJS);
    const lib = window.pdfjsLib; lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    let out = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      setStatus(`Reading page ${i} of ${pdf.numPages}…`); setPct(i / pdf.numPages);
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const rows = {};
      for (const it of content.items) { if (!it.str) continue; const y = Math.round(it.transform[5]); (rows[y] = rows[y] || []).push({ x: it.transform[4], s: it.str }); }
      Object.keys(rows).map(Number).sort((a, b) => b - a).forEach((y) => { out += rows[y].sort((a, b) => a.x - b.x).map((o) => o.s).join(" ") + "\n"; });
      out += "\n";
    }
    return { text: out, pdf };
  }
  async function ocrPdf(pdf) {
    await loadScript(TESSERACT);
    const T = window.Tesseract; if (!T) throw new Error("no ocr");
    const n = Math.min(pdf.numPages, 6); let out = "";
    for (let i = 1; i <= n; i++) {
      setStatus(`Scanning image, page ${i} of ${n}…`); setPct(i / n);
      const page = await pdf.getPage(i); const vp = page.getViewport({ scale: 2 });
      const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      const { data } = await T.recognize(c, "eng"); out += (data.text || "") + "\n";
    }
    return out;
  }
  async function renderPages(pdf) {
    const n = Math.min(pdf.numPages, 12); const imgs = [];
    for (let i = 1; i <= n; i++) {
      setStatus(`Rendering picture ${i} of ${n}…`); setPct(i / n);
      const page = await pdf.getPage(i); const vp = page.getViewport({ scale: 1.4 });
      const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      imgs.push({ url: c.toDataURL("image/jpeg", 0.82) });
    }
    return imgs;
  }

  async function handleFile(file) {
    setWarn(""); setStage("working"); setPct(null);
    setImportName(file.name.replace(/\.[^.]+$/, "") || "Untitled pattern");
    try {
      if (file.name.toLowerCase().endsWith(".txt")) { setStatus("Reading text…"); finishExtract(await file.text()); return; }
      setStatus("Opening PDF…");
      const { text, pdf } = await extractPdf(file);
      const imgs = await renderPages(pdf); setPages(imgs); setCover(imgs.length ? 0 : null);
      if (text.replace(/\s/g, "").length < 40) {
        setStatus("No text found — trying OCR…");
        try { const ocr = await ocrPdf(pdf); setWarn("Read with OCR — double-check the rows, OCR can misread."); finishExtract(ocr); }
        catch { setWarn("No selectable text and OCR couldn't run. If it's a symbol chart it can't be parsed as steps — you'd view it as an image. You can also paste the text."); setStage("input"); setPasteMode(true); }
        return;
      }
      finishExtract(text);
    } catch { setWarn("Couldn't read that file. Try exporting from Google Docs as PDF, or paste the text."); setStage("input"); }
  }
  function finishExtract(text) {
    setRawText(text);
    const parsed = localParse(text);
    if (!parsed.length) { setWarn("Nothing looked like instructions. Paste the text to pick rows out manually."); setStage("input"); setPasteMode(true); setPasteVal(text); return; }
    setSteps(parsed); setStage("review");
  }

  async function aiCleanup() {
    setAiBusy(true); setWarn("");
    try {
      const prompt = "You clean crochet patterns pulled from a PDF. Return ONLY a JSON array, no prose, no markdown fences. " +
        "Each item: {\"text\": string, \"sts\": number or null, \"isRow\": boolean}. Remove materials, gauge, hook/yarn info, " +
        "abbreviation keys, page numbers, copyright. Rejoin wrapped lines. Expand ranges like 'Rows 2-5' into one item per row. " +
        "isRow true for numbered rows/rounds. Text:\n\n" + rawText.slice(0, 6000);
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
      });
      const data = await res.json();
      const txt = data.content.map((c) => c.text || "").join("").replace(/```json|```/g, "").trim();
      const arr = JSON.parse(txt);
      if (Array.isArray(arr) && arr.length) setSteps(arr.map((o) => ({ text: String(o.text || "").trim(), sts: o.sts ?? extractSts(String(o.text || "")), isRow: o.isRow ?? ROW_RE.test(String(o.text || "")) })));
      else setWarn("Cleanup came back empty — keeping the basic parse.");
    } catch { setWarn("AI cleanup didn't run (long patterns can exceed the limit). The basic parse still works."); }
    setAiBusy(false);
  }

  /* ---------- project lifecycle ---------- */
  function startProject() {
    const id = "p" + Date.now().toString(36);
    const now = Date.now();
    const proj = { id, name: importName, status: "in_progress", created: now, completed: null, updated: now, steps, current: 0, checked: [], stitch: [], log: [] };
    store.set("ap_proj:" + id, proj); upsertIndex(proj);
    setActiveId(id); setMeta({ id, name: importName, status: "in_progress", created: now, completed: null, log: [] });
    setChecked([]); setStitch([]); setCurrent(0); prevRows.current = 0;
    setStage("read"); if (autoRead) speak(steps[0]?.text);
  }
  async function openProject(id) {
    const p = await store.get("ap_proj:" + id); if (!p) return;
    setActiveId(id); setSteps(p.steps || []); setCurrent(p.current || 0); setChecked(p.checked || []); setStitch(p.stitch || []);
    setMeta({ id, name: p.name, status: p.status, created: p.created, completed: p.completed, log: p.log || [] });
    setPages([]); setCover(null); setViewer(null);
    prevRows.current = rowStats(p.steps || [], p.checked || []).done;
    setStage("read");
  }
  function deleteProject(id) {
    store.del("ap_proj:" + id);
    persistIndex(projects.filter((p) => p.id !== id));
  }
  async function openHistory(id) {
    const p = await store.get("ap_proj:" + id);
    if (p) setHistoryData({ name: p.name, log: p.log || [], created: p.created, completed: p.completed });
  }
  function backToLibrary() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    window.speechSynthesis && window.speechSynthesis.cancel();
    setStage("library"); setActiveId(null); setMeta(null);
    setSteps([]); setChecked([]); setStitch([]); setCurrent(0); setPages([]); setCover(null); setViewer(null);
    setPasteMode(false); setWarn("");
  }

  /* ---------- save active project (debounced) + activity log ---------- */
  useEffect(() => {
    if (stage !== "read" || !activeId || !meta) return;
    const { total, done } = rowStats(steps, checked);
    let log = meta.log || [];
    if (done > prevRows.current) {
      const delta = done - prevRows.current;
      const day = new Date().toISOString().slice(0, 10);
      log = [...log];
      const last = log[log.length - 1];
      if (last && last.date === day) log[log.length - 1] = { date: day, rows: last.rows + delta };
      else log.push({ date: day, rows: delta });
    }
    prevRows.current = done;
    let st = meta.status, completed = meta.completed;
    if (total > 0 && done === total && st !== "finished") { st = "finished"; completed = Date.now(); }
    if (done < total && st === "finished") { st = "in_progress"; completed = null; }
    const changed = log !== meta.log || st !== meta.status || completed !== meta.completed;
    if (changed) setMeta({ ...meta, log, status: st, completed });
    const proj = { id: activeId, name: meta.name, status: st, created: meta.created, completed, updated: Date.now(), steps, current, checked, stitch, log };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { store.set("ap_proj:" + activeId, proj); upsertIndex(proj); }, 350);
  }, [stage, activeId, steps, current, checked, stitch]); // eslint-disable-line

  /* ---------- speech + navigation ---------- */
  const speak = useCallback((text) => {
    try { const s = window.speechSynthesis; if (!s || !text) return; s.cancel(); const u = new SpeechSynthesisUtterance(speakable(text)); u.rate = 0.95; s.speak(u); } catch {}
  }, []);
  const goTo = useCallback((i) => {
    const c = Math.max(0, Math.min(steps.length - 1, i)); setCurrent(c);
    const el = stepRefs.current[c]; if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    if (autoRead) speak(steps[c]?.text);
  }, [steps, autoRead, speak]);
  const advance = () => { setChecked((ch) => { const n = [...ch]; n[current] = true; return n; }); goTo(current + 1); };
  const markAllDone = () => { setChecked(steps.map(() => true)); };
  useEffect(() => () => window.speechSynthesis && window.speechSynthesis.cancel(), []);

  const rename = (name) => { setMeta((m) => m ? { ...m, name } : m); };
  const rs = rowStats(steps, checked);

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
  .sub{ font-size:12.5px; color:var(--ink2); margin-top:4px;}
  .btn{ font-family:inherit; font-weight:600; font-size:14px; border:none; border-radius:12px; padding:11px 17px; cursor:pointer; display:inline-flex; align-items:center; gap:8px;}
  .btn.primary{ background:var(--ink); color:var(--paper);}
  .btn.rope{ background:var(--rope); color:#fff;}
  .btn.ghost{ background:transparent; color:var(--ink2); border:1px solid var(--line);}
  .btn:disabled{ opacity:.55; cursor:default;}
  .drop{ border:2px dashed var(--line); border-radius:20px; background:var(--card); padding:44px 24px; text-align:center; transition:.18s; cursor:pointer; display:block;}
  .drop.hot{ border-color:var(--rope); background:#fff;}
  .drop h3{ font-family:'Fraunces',serif; font-weight:600; font-size:19px; margin:14px 0 6px;}
  .drop p{ color:var(--ink2); font-size:13.5px; margin:0 auto; max-width:400px; line-height:1.5;}
  .alt{ display:flex; gap:10px; justify-content:center; margin-top:18px;}
  .ta{ width:100%; min-height:220px; resize:vertical; font-family:'DM Mono',monospace; font-size:13.5px; line-height:1.55; padding:15px; border:1px solid var(--line); border-radius:16px; background:var(--card); color:var(--ink); outline:none;}
  .ta:focus{ border-color:var(--rope);}
  .working{ text-align:center; padding:60px 20px;}
  .spin{ animation:spin 1s linear infinite;} @keyframes spin{ to{ transform:rotate(360deg);} }
  .prog{ height:6px; background:rgba(28,43,54,.1); border-radius:6px; max-width:320px; margin:20px auto 0; overflow:hidden;}
  .prog span{ display:block; height:100%; background:var(--sage); transition:width .3s;}
  .warn{ display:flex; gap:10px; align-items:flex-start; background:rgba(162,65,47,.09); border:1px solid rgba(162,65,47,.25); color:var(--err); border-radius:12px; padding:12px 14px; font-size:13px; line-height:1.5; margin-bottom:16px;}
  .rowhdr{ display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; flex-wrap:wrap; gap:10px;}
  .rowhdr h3{ font-family:'Fraunces',serif; font-weight:600; font-size:18px; margin:0;}
  .rowhdr .n{ font-family:'DM Mono',monospace; font-size:12.5px; color:var(--ink2);}
  /* library */
  .plist{ display:flex; flex-direction:column; gap:12px;}
  .pcard{ background:var(--card); border:1px solid var(--line); border-radius:16px; padding:16px;}
  .pcard h4{ font-family:'Fraunces',serif; font-weight:600; font-size:17px; margin:0 0 2px;}
  .pmeta{ font-family:'DM Mono',monospace; font-size:11.5px; color:var(--ink2); display:flex; align-items:center; gap:5px; flex-wrap:wrap;}
  .badge{ display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:600; padding:4px 9px; border-radius:20px;}
  .badge.done{ background:rgba(124,143,123,.18); color:#4f6b4d;}
  .badge.wip{ background:rgba(176,124,79,.16); color:var(--rope-d);}
  .pbar{ height:6px; background:rgba(28,43,54,.1); border-radius:6px; overflow:hidden; margin:12px 0 4px;}
  .pbar span{ display:block; height:100%; background:var(--sage);}
  .pacts{ display:flex; gap:8px; margin-top:12px; flex-wrap:wrap;}
  .lnk{ background:none; border:none; font-family:inherit; font-size:13px; font-weight:600; color:var(--ink2); cursor:pointer; display:inline-flex; align-items:center; gap:5px; padding:6px 8px; border-radius:8px;}
  .lnk:hover{ background:rgba(28,43,54,.06);}
  .lnk.del:hover{ color:var(--err);}
  .empty{ text-align:center; color:var(--ink2); padding:20px;}
  /* review */
  .rev{ display:flex; flex-direction:column; gap:8px;}
  .revrow{ display:flex; gap:10px; align-items:flex-start; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:10px 12px;}
  .revrow.row-mark{ border-left:3px solid var(--sage);}
  .revrow textarea{ flex:1; border:none; background:transparent; font-family:'DM Mono',monospace; font-size:13.5px; line-height:1.5; color:var(--ink); resize:none; outline:none; overflow:hidden;}
  .stsb{ font-family:'DM Mono',monospace; font-size:11px; color:var(--sage); background:rgba(124,143,123,.14); padding:3px 7px; border-radius:6px; white-space:nowrap; margin-top:2px;}
  .xb{ background:none; border:none; color:var(--ink2); cursor:pointer; padding:4px; flex:none;} .xb:hover{ color:var(--err);}
  .thumbs{ display:grid; grid-template-columns:repeat(auto-fill,minmax(96px,1fr)); gap:10px;}
  .thumb{ position:relative; padding:0; border:1px solid var(--line); border-radius:12px; overflow:hidden; cursor:pointer; background:#fff; aspect-ratio:3/4;}
  .thumb.cov{ border:2px solid var(--rope);}
  .thumb img{ width:100%; height:100%; object-fit:cover; display:block;}
  .covtag{ position:absolute; left:6px; bottom:6px; display:inline-flex; align-items:center; gap:4px; font-size:10px; font-weight:600; color:#fff; background:var(--rope); padding:3px 7px; border-radius:20px;}
  /* reader */
  .bar{ display:flex; gap:9px; align-items:center; flex-wrap:wrap; margin-top:20px; position:sticky; bottom:0; background:var(--paper); padding:14px 0 6px; border-top:1px solid var(--line);}
  .grow{ flex:1;}
  .chip{ display:inline-flex; align-items:center; gap:6px; font-family:'DM Mono',monospace; font-size:12.5px; color:var(--ink2); background:rgba(28,43,54,.06); padding:7px 12px; border-radius:20px;}
  .nameinput{ font-family:'Fraunces',serif; font-weight:600; font-size:18px; color:var(--ink); background:transparent; border:none; border-bottom:1px dashed transparent; outline:none; padding:2px 0; max-width:240px;}
  .nameinput:focus{ border-bottom-color:var(--rope);}
  .steps{ display:flex; flex-direction:column; gap:8px; margin-top:14px;}
  .step{ display:flex; gap:12px; align-items:flex-start; padding:13px 15px; border-radius:14px; border:1px solid transparent; background:var(--card); cursor:pointer; transition:.15s; opacity:.6;}
  .step.done{ opacity:.4;} .step.cur{ opacity:1; border-color:var(--rope); background:#fff; box-shadow:0 2px 12px rgba(176,124,79,.16);}
  .box{ width:22px;height:22px;border-radius:7px;border:1.5px solid var(--line);flex:none;margin-top:1px;display:flex;align-items:center;justify-content:center;color:#fff;}
  .box.on{ background:var(--sage); border-color:var(--sage);}
  .step-t{ font-size:14.5px; line-height:1.5;} .step.row-mark .step-t{ font-family:'Fraunces',serif; font-weight:600;}
  .rtag{ font-family:'DM Mono',monospace; font-size:10px; letter-spacing:1px; text-transform:uppercase; color:var(--sage); margin-bottom:2px;}
  .rowsc{ display:flex; align-items:center; gap:8px; margin-top:11px; flex-wrap:wrap;}
  .sclbl{ font-family:'DM Mono',monospace; font-size:10px; letter-spacing:.5px; text-transform:uppercase; color:var(--ink2);}
  .scmini{ width:30px;height:30px;border-radius:9px;border:1px solid var(--line);background:var(--paper);color:var(--ink);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:17px;line-height:1;flex:none;} .scmini:hover{ background:#fff;}
  .scnum{ display:inline-flex; align-items:baseline; gap:5px; border:1px solid var(--rope); background:#fff; color:var(--ink); border-radius:10px; padding:5px 14px; cursor:pointer; min-width:64px; justify-content:center;} .scnum:hover{ background:var(--paper);}
  .scv{ font-family:'Fraunces',serif; font-weight:600; font-size:20px; line-height:1; font-variant-numeric:tabular-nums;}
  .scof{ font-family:'DM Mono',monospace; font-size:12px; color:var(--ink2);}
  .rowsc.done .scnum{ border-color:var(--sage); background:rgba(124,143,123,.12);}
  .scok{ display:inline-flex; align-items:center; gap:4px; font-size:11.5px; font-weight:600; color:var(--sage);}
  .toggle{ display:inline-flex; align-items:center; gap:7px; font-size:13px; color:var(--ink2); cursor:pointer; user-select:none;}
  .sw{ width:38px;height:22px;border-radius:20px;background:rgba(28,43,54,.2);position:relative;transition:.18s;flex:none;} .sw.on{ background:var(--sage);}
  .sw::after{ content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.18s;} .sw.on::after{ left:18px;}
  .cbtn{ width:42px;height:42px;border-radius:12px;border:1px solid var(--line);background:var(--card);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--ink);} .cbtn:disabled{ opacity:.4; cursor:default;}
  .done-banner{ display:flex; align-items:center; gap:10px; background:rgba(124,143,123,.15); border:1px solid rgba(124,143,123,.4); color:#4f6b4d; border-radius:12px; padding:12px 14px; font-size:14px; font-weight:600; margin-bottom:14px;}
  /* modals */
  .overlay{ position:fixed; inset:0; background:rgba(28,20,10,.72); display:flex; align-items:center; justify-content:center; padding:20px; z-index:50;}
  .viewer{ background:var(--paper); border-radius:16px; max-width:680px; width:100%; max-height:92vh; display:flex; flex-direction:column; overflow:hidden;}
  .vtop{ display:flex; align-items:center; gap:8px; padding:12px 14px; border-bottom:1px solid var(--line);}
  .vnum{ font-family:'DM Mono',monospace; font-size:12.5px; color:var(--ink2);}
  .vimg{ overflow:auto; padding:14px; background:rgba(28,43,54,.05); flex:1; display:flex; justify-content:center;}
  .vimg img{ max-width:100%; height:auto; border-radius:8px; box-shadow:0 4px 20px rgba(28,43,54,.18); align-self:flex-start;}
  .vnav{ display:flex; justify-content:center; gap:14px; padding:12px; border-top:1px solid var(--line);}
  .hist{ background:var(--paper); border-radius:16px; max-width:460px; width:100%; max-height:80vh; overflow:auto; padding:20px;}
  .histrow{ display:flex; align-items:center; justify-content:space-between; padding:9px 0; border-bottom:1px dashed var(--line); font-size:13.5px;}
  .histrow .d{ font-family:'DM Mono',monospace; color:var(--ink2); font-size:12.5px;}
  .histbar{ height:8px; background:var(--sage); border-radius:6px; min-width:8px;}
  @media (prefers-reduced-motion:reduce){ *{ transition:none!important; animation:none!important;} }
  button:focus-visible,textarea:focus-visible,input:focus-visible{ outline:2px solid var(--rope); outline-offset:2px;}
  `;

  const Header = ({ showSub }) => (
    <div className="head">
      <div className="mark"><Flower2 size={21} /></div>
      <div>
        <div className="ttl">create with ianna</div>
        <div className="subttl">my pattern tracker</div>
        {showSub && <div className="sub">Drop in a PDF and crochet it row by row.</div>}
      </div>
    </div>
  );

  return (
    <div className="ap">
      <style>{css}</style>
      <div className="wrap">

        {/* ---------------- LIBRARY ---------------- */}
        {stage === "library" && (
          <div>
            <Header showSub={false} />
            <div className="rowhdr">
              <h3>Your patterns</h3>
              <button className="btn primary" onClick={() => { setStage("input"); setPasteMode(false); setWarn(""); setSteps([]); setPages([]); setCover(null); }}>
                <Plus size={17} /> New pattern
              </button>
            </div>

            {projects.length === 0 ? (
              <div className="pcard empty">
                <Flower2 size={30} color="var(--rope)" style={{ marginBottom: 8 }} />
                <p style={{ margin: 0, lineHeight: 1.5 }}>No patterns yet. Import a PDF to start your first project — it'll show up here with your progress.</p>
              </div>
            ) : (
              <div className="plist">
                {projects.map((p) => {
                  const done = p.status === "finished";
                  const w = p.rowsTotal ? Math.round((p.rowsDone / p.rowsTotal) * 100) : 0;
                  return (
                    <div className="pcard" key={p.id}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
                        <div>
                          <h4>{p.name}</h4>
                          <div className="pmeta">
                            <CalendarDays size={12} /> Started {fmtDate(p.created)}
                            {done && <> · <CheckCircle2 size={12} /> Finished {fmtDate(p.completed)}</>}
                          </div>
                        </div>
                        <span className={"badge " + (done ? "done" : "wip")}>
                          {done ? <><CheckCircle2 size={12} /> Finished</> : <><Clock size={12} /> In progress</>}
                        </span>
                      </div>
                      <div className="pbar"><span style={{ width: w + "%" }} /></div>
                      <div className="pmeta">{p.rowsDone} of {p.rowsTotal} rows{p.rowsTotal ? " · " + w + "%" : ""}</div>
                      <div className="pacts">
                        <button className="lnk" onClick={() => openProject(p.id)} style={{ color: "var(--ink)" }}><ArrowLeft size={14} style={{ transform: "rotate(180deg)" }} /> Open</button>
                        <button className="lnk" onClick={() => openHistory(p.id)}><History size={14} /> History</button>
                        <div style={{ flex: 1 }} />
                        <button className="lnk del" onClick={() => deleteProject(p.id)}><Trash2 size={14} /> Delete</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ---------------- INPUT ---------------- */}
        {stage === "input" && (
          <div>
            <Header showSub={true} />
            {warn && <div className="warn"><AlertTriangle size={17} style={{ flex: "none", marginTop: 1 }} /><span>{warn}</span></div>}
            <button className="lnk" style={{ marginBottom: 12 }} onClick={backToLibrary}><ArrowLeft size={15} /> Library</button>
            {!pasteMode ? (
              <>
                <label className={"drop" + (drag ? " hot" : "")}
                  onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
                  onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}>
                  <UploadCloud size={40} color="var(--rope)" strokeWidth={1.6} />
                  <h3>Drop a pattern PDF here</h3>
                  <p>Or click to browse. From Google Docs, use File → Download → PDF first — a shared link won't work. Text files are fine too.</p>
                  <input type="file" accept=".pdf,.txt" style={{ display: "none" }} onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])} />
                </label>
                <div className="alt"><button className="btn ghost" onClick={() => { setPasteMode(true); setImportName("Untitled pattern"); }}><Clipboard size={16} /> Paste text instead</button></div>
              </>
            ) : (
              <div>
                <textarea className="ta" placeholder={"Paste the pattern — one instruction per line.\n\nRow 1: ch 20, sc in 2nd ch from hook, sc across (19 sts)\nRow 2: ch 1, turn, sc in each st across"} value={pasteVal} onChange={(e) => setPasteVal(e.target.value)} />
                <div style={{ display: "flex", gap: 9, marginTop: 12 }}>
                  <button className="btn primary" disabled={!pasteVal.trim()} onClick={() => { setWarn(""); setPages([]); setCover(null); finishExtract(pasteVal); }}><Check size={17} /> Parse it</button>
                  <button className="btn ghost" onClick={() => { setPasteMode(false); setWarn(""); }}>Back to upload</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ---------------- WORKING ---------------- */}
        {stage === "working" && (
          <div><Header showSub={false} />
            <div className="working">
              <Loader2 size={34} className="spin" color="var(--rope)" />
              <p style={{ marginTop: 16, fontSize: 15, color: "var(--ink2)" }}>{status}</p>
              {pct !== null && <div className="prog"><span style={{ width: Math.round(pct * 100) + "%" }} /></div>}
            </div>
          </div>
        )}

        {/* ---------------- REVIEW ---------------- */}
        {stage === "review" && (
          <div>
            <Header showSub={false} />
            {warn && <div className="warn"><AlertTriangle size={17} style={{ flex: "none", marginTop: 1 }} /><span>{warn}</span></div>}
            <div className="rowhdr">
              <h3>Check the rows before you start</h3>
              <span className="n">{steps.length} steps · {rs.total} rows</span>
            </div>
            <p style={{ color: "var(--ink2)", fontSize: 13.5, margin: "0 0 14px", lineHeight: 1.5 }}>Fix any merged or miscounted lines, or let Claude clean it up — then start crocheting.</p>
            <div style={{ display: "flex", gap: 9, marginBottom: 16, flexWrap: "wrap" }}>
              <button className="btn rope" onClick={aiCleanup} disabled={aiBusy}>{aiBusy ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}{aiBusy ? "Cleaning up…" : "Clean up with AI"}</button>
              <button className="btn ghost" onClick={() => setSteps((s) => [...s, { text: "New row", sts: null, isRow: true }])}><Plus size={16} /> Add row</button>
            </div>

            {pages.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div className="rowhdr" style={{ marginBottom: 8 }}><h3 style={{ fontSize: 15 }}>Pictures from this pattern</h3><span className="n">tap to view · star sets the cover</span></div>
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
                  <textarea rows={1} value={s.text} ref={(el) => { if (el) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; } }}
                    onChange={(e) => setSteps((arr) => arr.map((x, j) => j === i ? { ...x, text: e.target.value, sts: extractSts(e.target.value), isRow: ROW_RE.test(e.target.value) } : x))} />
                  {s.sts != null && <span className="stsb">{s.sts} sts</span>}
                  <button className="xb" onClick={() => setSteps((arr) => arr.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 size={16} /></button>
                </div>
              ))}
            </div>

            <div className="bar">
              <button className="btn ghost" onClick={() => { setStage("input"); setPasteMode(false); setPages([]); setCover(null); }}>Start over</button>
              <div className="grow" />
              <button className="btn primary" disabled={!steps.length} onClick={startProject}><Check size={17} /> Start crocheting</button>
            </div>
          </div>
        )}

        {/* ---------------- READ ---------------- */}
        {stage === "read" && meta && (
          <div>
            <div className="head" style={{ marginBottom: 16 }}>
              <button className="cbtn" onClick={backToLibrary} aria-label="Back to library"><ArrowLeft size={20} /></button>
              <div style={{ flex: 1 }}>
                <input className="nameinput" value={meta.name} onChange={(e) => rename(e.target.value)} aria-label="Project name" />
                <div className="subttl" style={{ marginTop: 3 }}>{meta.status === "finished" ? "finished " + fmtDate(meta.completed) : "in progress"}</div>
              </div>
            </div>

            {meta.status === "finished" && <div className="done-banner"><CheckCircle2 size={18} /> Finished — every row is done. Nice work!</div>}

            <div className="rowhdr">
              <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                <span className="chip">Row {rs.done}{rs.total ? " / " + rs.total : ""}</span>
                <span className="chip">Step {Math.min(current + 1, steps.length)} / {steps.length}</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {pages.length > 0 && <button className="btn ghost" style={{ padding: "9px 14px", fontSize: 13.5 }} onClick={() => setViewer(cover ?? 0)}><ImageIcon size={15} /> Chart</button>}
                {meta.status !== "finished" && <button className="btn ghost" style={{ padding: "9px 14px", fontSize: 13.5 }} onClick={markAllDone}><CheckCircle2 size={15} /> Mark finished</button>}
              </div>
            </div>

            <div className="steps">
              {steps.map((s, i) => {
                const cnt = stitch[i] || 0; const scDone = s.sts != null && cnt >= s.sts;
                return (
                  <div key={i} ref={(el) => (stepRefs.current[i] = el)}
                    className={"step" + (i === current ? " cur" : "") + (checked[i] ? " done" : "") + (s.isRow ? " row-mark" : "")}
                    onClick={() => { setChecked((ch) => { const n = [...ch]; n[i] = !n[i]; return n; }); goTo(i); }}>
                    <div className={"box" + (checked[i] ? " on" : "")}>{checked[i] && <Check size={14} strokeWidth={3} />}</div>
                    <div style={{ flex: 1 }}>
                      {s.isRow && <div className="rtag">new row</div>}
                      <div className="step-t">{s.text}</div>
                      {s.isRow && (
                        <div className={"rowsc" + (scDone ? " done" : "")} onClick={(e) => e.stopPropagation()}>
                          <span className="sclbl">stitches</span>
                          <button className="scmini" onClick={() => bumpStitch(i, -1)} aria-label="One fewer">−</button>
                          <button className="scnum" onClick={() => bumpStitch(i, 1)} aria-label="Count a stitch"><span className="scv">{cnt}</span>{s.sts != null && <span className="scof">/ {s.sts}</span>}</button>
                          <button className="scmini" onClick={() => bumpStitch(i, 1)} aria-label="One more">+</button>
                          <button className="scmini" onClick={() => resetStitch(i)} aria-label="Reset row"><RotateCcw size={13} /></button>
                          {scDone && <span className="scok"><Check size={13} strokeWidth={3} /> row done</span>}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="bar">
              <button className="cbtn" onClick={() => goTo(current - 1)} aria-label="Previous"><ChevronLeft size={20} /></button>
              <button className="btn ghost" onClick={() => speak(steps[current]?.text)}><Volume2 size={17} /> Read</button>
              <button className="btn primary grow" onClick={advance}>Done — next <ChevronRight size={18} /></button>
              <label className="toggle" onClick={() => setAutoRead((v) => !v)}><span className={"sw" + (autoRead ? " on" : "")} /> Auto-read</label>
            </div>
          </div>
        )}
      </div>

      {/* image viewer */}
      {viewer !== null && pages[viewer] && (
        <div className="overlay" onClick={() => setViewer(null)}>
          <div className="viewer" onClick={(e) => e.stopPropagation()}>
            <div className="vtop">
              <span className="vnum">Page {viewer + 1} of {pages.length}</span><div style={{ flex: 1 }} />
              <button className="btn ghost" style={{ padding: "8px 12px", fontSize: 13 }} onClick={() => setCover(viewer)}><Star size={14} fill={cover === viewer ? "currentColor" : "none"} /> {cover === viewer ? "Cover" : "Set as cover"}</button>
              <button className="cbtn" onClick={() => setViewer(null)} aria-label="Close"><X size={19} /></button>
            </div>
            <div className="vimg"><img src={pages[viewer].url} alt={"Page " + (viewer + 1)} /></div>
            {pages.length > 1 && (
              <div className="vnav">
                <button className="cbtn" disabled={viewer === 0} onClick={() => setViewer((v) => Math.max(0, v - 1))} aria-label="Previous"><ChevronLeft size={20} /></button>
                <button className="cbtn" disabled={viewer === pages.length - 1} onClick={() => setViewer((v) => Math.min(pages.length - 1, v + 1))} aria-label="Next"><ChevronRight size={20} /></button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* activity history */}
      {historyData && (
        <div className="overlay" onClick={() => setHistoryData(null)}>
          <div className="hist" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <h3 style={{ fontFamily: "'Fraunces',serif", margin: 0, fontSize: 18 }}>{historyData.name}</h3>
              <button className="cbtn" onClick={() => setHistoryData(null)} aria-label="Close"><X size={18} /></button>
            </div>
            <div className="pmeta" style={{ marginBottom: 14 }}>
              Started {fmtDate(historyData.created)}{historyData.completed ? " · Finished " + fmtDate(historyData.completed) : ""}
            </div>
            {(!historyData.log || historyData.log.length === 0) ? (
              <p style={{ color: "var(--ink2)", fontSize: 13.5 }}>No rows logged yet. Rows you complete will show up here by day.</p>
            ) : (
              <>
                <div className="pmeta" style={{ marginBottom: 8 }}>Rows completed per day</div>
                {(() => { const max = Math.max(...historyData.log.map((e) => e.rows)); return historyData.log.map((e, i) => (
                  <div className="histrow" key={i}>
                    <span className="d">{fmtDate(new Date(e.date).getTime())}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, justifyContent: "flex-end" }}>
                      <div className="histbar" style={{ width: Math.round((e.rows / max) * 140) + "px" }} />
                      <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 12.5, minWidth: 46, textAlign: "right" }}>{e.rows} rows</span>
                    </div>
                  </div>
                )); })()}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
