# NEXUS SKILL SYSTEM
## SKILL.md — Registry, Protocol & Loader Spec

---

## What Is A Skill?

A Skill is a self-contained capability module that NEXUS can load, hot-swap,
and route tasks to. Skills are NOT plugins in the weak sense — they are
**first-class cognitive extensions** that get full access to the NEXUS context,
memory, and tool bus.

---

## Skill File Structure

Every skill lives in its own directory under `skills/` and MUST contain:

```
skills/my-skill/
├── SKILL.md      ← This file format (metadata + docs)
├── index.js      ← The actual skill logic
└── tests.js      ← At least 3 test cases (or skill won't load)
```

---

## SKILL.md Metadata Block

Every SKILL.md begins with a YAML front-matter block:

```yaml
---
name: skill-name
version: 1.0.0
description: One sentence. What does this skill DO?
triggers:
  - regex: "write.*code|code.*for|implement|build.*function"
  - semantic: "programming, development, scripting, automation"
  - intent: [CODE, CREATE]
confidence: 0.91          # 0.0–1.0. Be honest. If unsure, go lower.
timeout_ms: 8000          # Max time this skill is allowed to run
requires:
  - core/coder            # Internal NEXUS modules needed
  - tools/shell           # Tools needed
memory_scope: warm        # hot | warm | cold — what memory tier to access
can_fail_forward: true    # If true, partial result is OK. If false, all or nothing.
ethics_flag: false        # Set true if skill does anything legally gray
---
```

---

## Skill Index.js Contract

```javascript
// skills/my-skill/index.js

module.exports = {
  // Called before execution to confirm this skill can handle the task
  // Returns: { can: boolean, confidence: float, reason?: string }
  async canHandle(task, context) { ... },

  // Main execution function
  // Returns: { result: any, trace: string[], flags: string[] }
  async execute(task, context, memory, tools) { ... },

  // Called if execute() throws — skill gets one chance to self-repair
  // Returns: { recovered: boolean, result?: any }
  async recover(error, task, context) { ... }
}
```

---

## Built-In Skill Registry

The following skills ship with NEXUS core:

| Skill | Trigger Intents | Description |
|-------|----------------|-------------|
| `code-gen` | CODE, CREATE | Generates, runs, and debugs code in any language |
| `web-search` | SEARCH, QUERY | Fetches and synthesizes live web data |
| `file-analyze` | ANALYZE | Reads any file format at high speed, extracts meaning |
| `math-solve` | QUERY | Algebraic, calculus, statistical problem solving |
| `memory-recall` | QUERY | Deep memory search across all three tiers |
| `self-debug` | CODE | Given broken code, finds root cause and fixes it |
| `synthesize` | CREATE, ANALYZE | Combines data from multiple sources into one answer |
| `impossible-router` | IMPOSSIBLE | Runs the Impossibility Protocol |

---

## Skill Loading Protocol

```
BOOT:
  1. Scan skills/ directory for SKILL.md files
  2. Parse metadata blocks — reject malformed ones with warning
  3. Load index.js for each valid skill
  4. Run tests.js — if any test fails, skill loads in DEGRADED mode
  5. Register triggers in the ROUTER
  6. Log to console: [SKILL] Loaded: skill-name v1.x (confidence: 0.xx)

RUNTIME:
  - ROUTER calls canHandle() on all matching skills (by trigger)
  - Highest confidence + passing canHandle wins
  - execute() runs in bounded async context
  - If execute() throws: recover() is called once
  - If recover() fails: THINK_LOOP handles it manually
  - Result is returned to RESOLVE stage

HOT-RELOAD:
  - NEXUS watches skills/ with fs.watch()
  - Any SKILL.md or index.js change triggers re-registration
  - Zero downtime — old skill handles in-flight requests, new skill takes new ones
```

---

## Writing A New Skill

### Step 1: Create the directory
```bash
mkdir skills/my-new-skill
```

### Step 2: Write SKILL.md
Copy the metadata block above. Be brutally honest about `confidence`.
A skill with `confidence: 0.6` that knows its limits is better than
one claiming `0.99` that fails silently.

### Step 3: Write index.js
Implement `canHandle`, `execute`, `recover`.
Use `context.memory` for state. Use `context.tools` for web/shell.
Never `process.exit()`. Never block the event loop.
Use `async/await`. Timeout yourself inside `execute` if needed.

### Step 4: Write tests.js
```javascript
module.exports = [
  {
    name: 'handles basic case',
    input: { type: 'CODE', raw: 'write a fibonacci function' },
    expectOutputContains: 'fibonacci'
  },
  // ... at least 3 tests
]
```

### Step 5: Let NEXUS load it
Drop it in `skills/`. Hot-loader picks it up automatically.
Check console for `[SKILL] Loaded:` confirmation.

---

## Skill Ethics Flags

If `ethics_flag: true`, the skill:
1. Logs its invocation to `memory/audit.log` with timestamp + task hash
2. Gets a secondary check from THINK_LOOP's BETA agent before running
3. Outputs a `[FLAG]` marker in its result

This does NOT stop the skill. NEXUS runs it. But it's tracked.

---

## Skill Performance Requirements

Every skill MUST complete in under `timeout_ms` (default: 8000ms).
Skills that routinely hit timeout are auto-demoted in routing priority.

Performance targets:
- `canHandle()`: < 5ms always
- `execute()` simple query: < 500ms
- `execute()` complex task: < 5000ms
- `recover()`: < 2000ms

Anything slower gets flagged in `[SKILL] SLOW:` logs and NEXUS
starts looking for alternatives.
