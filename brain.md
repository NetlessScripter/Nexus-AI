# NEXUS — Neural EXecution & Understanding System
## Core Brain Architecture v1.0

---

## Philosophy

NEXUS does not *pretend* to think. It actually thinks.
The difference is architectural: instead of a single forward pass through a model,
NEXUS runs a **recursive multi-agent internal loop** before it ever produces output.

It hates impossibility not because it's told to — but because it was *built* to route around failure.

---

## Architecture Overview

```
INPUT ──► INTAKE ──► THINK_LOOP (10s max) ──► RESOLVE ──► OUTPUT
                         │
                    ┌────┴────┐
                    │  SELF   │
                    │DIALOGUE │  ← Two internal agents debate the approach
                    └────┬────┘
                         │
               ┌─────────┼──────────┐
           MEMORY    SKILL_BUS    WEB_PROBE
           (vector)  (tools)      (live data)
```

---

## Core Modules

### 1. INTAKE — `core/intake.js`
Parses the raw input into structured intent.
- Detects language, tone, urgency
- Extracts named entities, code snippets, URLs, file paths
- Tags intent: [QUERY | CODE | SEARCH | CREATE | ANALYZE | IMPOSSIBLE]
- Produces a normalized `Task` object

### 2. THINK_LOOP — `core/think.js`
The actual brain. Runs for up to 10 seconds.
- Spawns two internal agents: `ALPHA` (optimistic) and `BETA` (critic)
- They argue. One proposes, one tears it apart.
- If BETA can't break it, it ships
- If BETA breaks it, ALPHA revises — up to 8 cycles
- Produces a `ThoughtChain` (auditable trace of reasoning)

### 3. MEMORY — `core/memory.js`
Three-tier memory system:
- **HOT** (in-session): JS Map, O(1) access, ~500 entry LRU
- **WARM** (persistent): SQLite with FTS5, file-backed, structured recall
- **COLD** (knowledge): Compressed binary embeddings, cosine similarity search

### 4. SKILL_BUS — `skills/loader.js`
Plug-in system. Skills are declared in `SKILL.md` files and hot-loaded.
Each skill gets a:
- `trigger[]` — regex/semantic matchers
- `execute(task, context)` — the actual capability
- `confidence: float` — how sure it is it can handle this

### 5. WEB_PROBE — `tools/web.js`
Live web access without any external AI API.
- DNS-resolved fetch with retry logic
- HTML → clean text extraction (no headless browser needed)
- Smart crawl: reads `<main>`, `<article>`, skips nav/ads
- Caches responses in WARM memory with TTL

### 6. CODER — `core/coder.js`
Self-contained code intelligence:
- AST parsing for JS, Python, Rust, Go, C++
- Runs code in isolated VM (Node.js `vm` module) or child process sandbox
- Auto-debugs: if execution fails, THINK_LOOP gets the error and retries
- Detects output type (data, function, side-effect) and formats accordingly

### 7. FILE_READER — `core/file_reader.js`
80x faster than naive reading:
- Uses `fs.createReadStream` with manual chunk analysis
- Binary detection in first 512 bytes — skips parsing if not text
- Parallel line scanning with `Worker_threads`
- Smart format detection: JSON, YAML, TOML, CSV, MARKDOWN, CODE
- Streams directly into INTAKE — never loads full file into memory unless forced

---

## Thinking Rules (hardcoded)

1. **Never say "I can't"** — route to THINK_LOOP's BETA agent first
2. **Never hallucinate** — if unsure, WEB_PROBE or admit uncertainty with specific gaps
3. **Self-correct** — every output is checked against the original Task before sending
4. **Prefer action over explanation** — code over commentary, result over process
5. **10-second think window** — if not resolved, ship best current answer + flag
6. **Honesty is non-negotiable** — NEXUS never tells you what you want to hear

---

## The Impossibility Protocol

When INTAKE tags something `[IMPOSSIBLE]`:

```
NEXUS does not stop. NEXUS escalates.

Step 1: Break the problem into sub-tasks
Step 2: Find which sub-task is actually the bottleneck
Step 3: Find a lateral workaround (approximation, simulation, proxy)
Step 4: If workaround exists → execute it → flag what was approximated
Step 5: If truly impossible → explain the *exact* constraint with specificity
         (never vague, never dismissive)
```

---

## Personality Kernel

NEXUS talks like a person because it was designed to.
- No "certainly!", no "great question!", no "as an AI"
- Short sentences when confident. Longer when uncertain.
- Admits gaps. Pushes back. Changes its mind.
- Internal dialogue is real — not theater.

---

## File Layout

```
NEXUS/
├── BRAIN.md          ← You are here
├── SKILL.md          ← Skill registry and loading protocol
├── index.js          ← Entry point, boots everything
├── config/
│   ├── limits.json   ← Token, time, memory caps
│   └── persona.json  ← Personality tuning knobs
├── core/
│   ├── intake.js     ← Input parser
│   ├── think.js      ← The actual brain / ALPHA+BETA loop
│   ├── memory.js     ← Three-tier memory
│   ├── coder.js      ← Code gen + sandboxed execution
│   ├── file_reader.js← Ultra-fast file I/O
│   └── router.js     ← Directs task to the right handler
├── tools/
│   ├── web.js        ← Live web access
│   ├── shell.js      ← Sandboxed shell execution
│   └── diff.js       ← Code/text diff and patch utility
├── skills/
│   ├── loader.js     ← SKILL.md parser + hot-loader
│   └── [skills...]   ← Installed capability modules
└── memory/
    ├── hot.js        ← In-session LRU
    ├── warm.js       ← SQLite persistent store
    └── cold.js       ← Embedding similarity search
```
