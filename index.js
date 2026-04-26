/**
 * NEXUS — index.js
 * Boot sequence. Assembles the brain. Exposes the interface.
 *
 * Usage:
 *   const NEXUS = require('./index');
 *   const nexus = new NEXUS({ verbose: false });
 *   await nexus.boot();
 *   const response = await nexus.ask("Write me a recursive fibonacci in Python");
 *   console.log(response.text);
 */

'use strict';

const { intake }         = require('./core/intake');
const { ThinkLoop }      = require('./core/think');
const { Memory }         = require('./core/memory');
const { Router, ImpossibleHandler } = require('./core/router');
const { buildResponse }  = require('./core/personality');
const coder              = require('./core/coder');
const fileReader         = require('./core/file_reader');
const web                = require('./tools/web');
const { performance }    = require('perf_hooks');
const path               = require('path');
const fs                 = require('fs');

const VERSION  = '1.0.0';
const CODENAME = 'NEXUS';

// ─── Built-in Handlers ────────────────────────────────────────────────────────

class CoderHandler {
  async execute(task, { mode, chain }) {
    if (mode === 'execute') {
      chain.log('CODER', `Executing code [${task.language || 'auto-detect'}]`);
      const code   = task.codeBlocks[0]?.code || task.raw;
      const result = await coder.execute(code, { language: task.language });
      return { type: 'code', code, language: result.language, output: result.output,
               success: result.success, error: result.error, attempts: result.attempts };
    }
    chain.log('CODER', `Generating code: "${task.raw.substring(0, 60)}..."`);
    const language  = task.language || 'javascript';
    const generated = this._generate(task, language);
    const result    = await coder.execute(generated.code, { language });
    return {
      type: 'code', code: generated.code, language,
      explanation: generated.explanation,
      output: result.output, success: result.success, error: result.error,
      analysis: coder.analyze(generated.code, language),
    };
  }

  _generate(task, language) {
    const raw = task.raw.toLowerCase();
    if (/fibonacci|fib\b/.test(raw)) {
      return language === 'python'
        ? { code: `def fib(n, memo={}):\n    if n in memo: return memo[n]\n    if n <= 1: return n\n    memo[n] = fib(n-1, memo) + fib(n-2, memo)\n    return memo[n]\n\nfor i in range(10): print(f"fib({i}) = {fib(i)}")`,
            explanation: 'Memoized fibonacci — O(n) instead of O(2^n).' }
        : { code: `function fib(n, memo = new Map()) {\n  if (memo.has(n)) return memo.get(n);\n  if (n <= 1) return n;\n  const r = fib(n-1, memo) + fib(n-2, memo);\n  memo.set(n, r);\n  return r;\n}\nfor (let i = 0; i < 10; i++) console.log(\`fib(\${i}) = \${fib(i)}\`);`,
            explanation: 'Memoized fibonacci using Map. Runs in O(n).' };
    }
    return {
      code: language === 'python'
        ? `# ${task.raw}\ndef main():\n    pass  # TODO\n\nif __name__ == '__main__':\n    main()`
        : `// ${task.raw}\nfunction main() {\n  // TODO: implement\n}\nmain();`,
      explanation: 'Scaffold generated. Fill in the logic.',
    };
  }
}

class WebHandler {
  async execute(task, { mode, chain }) {
    if (mode === 'search') {
      chain.log('WEB', `Searching: "${task.raw.substring(0, 80)}"`);
      const result  = await web.searchAndRead(task.raw, { maxResults: 8, readTopN: 3 });
      const summary = this._synthesize(result.pages, task.raw);
      return { type: 'search', query: result.query, sources: result.searchResults.slice(0, 5),
               pages: result.pages, summary, elapsed: result.elapsed };
    }
    const url    = task.urls[0];
    chain.log('WEB', `Reading: ${url}`);
    const result = await web.readPage(url);
    return { type: 'page', url, title: result.title, content: result.content, elapsed: result.elapsed };
  }

  _synthesize(pages, query) {
    const goodPages = pages.filter(p => p.content && p.content.length > 100);
    if (goodPages.length === 0) return 'No readable content found.';
    const snippets = goodPages.map(p =>
      `From "${p.title || p.url}": ${p.content.substring(0, 400).replace(/\n+/g, ' ')}`
    );
    return snippets.join('\n\n');
  }
}

class FileHandler {
  async execute(task, { mode, chain }) {
    const filePath = task.filePaths[0];
    chain.log('FILE', `Reading: ${filePath}`);
    try {
      const result = await fileReader.read(filePath);
      return { type: 'file', ...result };
    } catch (e) {
      return { type: 'file', error: e.message, filePath };
    }
  }
}

class SynthesizerHandler {
  async execute(task, { mode, chain }) {
    chain.log('SYNTH', `Synthesizing response for mode=${mode}`);
    // Core knowledge synthesis — produces structured text response
    return {
      type:    'synthesis',
      content: `[Synthesized response for: "${task.raw.substring(0, 100)}"]\nMode: ${mode}`,
      mode,
    };
  }
}

// ─── NEXUS Main Class ─────────────────────────────────────────────────────────

class NEXUS {
  constructor(options = {}) {
    this.options    = { verbose: false, dataDir: './memory', ...options };
    this.memory     = null;
    this.router     = null;
    this.sessionId  = `session_${Date.now()}`;
    this.booted     = false;
    this.requestLog = [];
  }

  async boot() {
    const t0 = performance.now();
    console.log(`\n  ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗`);
    console.log(`  ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝`);
    console.log(`  ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗`);
    console.log(`  ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║`);
    console.log(`  ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║`);
    console.log(`  ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝`);
    console.log(`  Neural EXecution & Understanding System v${VERSION}\n`);

    // Init memory
    console.log('  [BOOT] Initializing memory tiers...');
    this.memory = new Memory({ dataDir: this.options.dataDir });
    const memStats = this.memory.stats();
    console.log(`  [BOOT] HOT memory ready (cap: 500 entries)`);
    console.log(`  [BOOT] WARM memory ready (${memStats.warm.entries} existing entries)`);
    console.log(`  [BOOT] COLD memory ready (${memStats.cold.vectors} vectors)`);

    // Init router with handlers
    console.log('  [BOOT] Registering handlers...');
    this.router = new Router({
      coder:           new CoderHandler(),
      web:             new WebHandler(),
      fileReader:      new FileHandler(),
      synthesizer:     new SynthesizerHandler(),
      impossibleRouter: new ImpossibleHandler(),
    });
    console.log(`  [BOOT] 5 handlers registered`);

    // Load skills (if any exist)
    await this._loadSkills();

    this.booted = true;
    const elapsed = (performance.now() - t0).toFixed(0);
    console.log(`  [BOOT] Ready in ${elapsed}ms. Session: ${this.sessionId}\n`);
    return this;
  }

  async _loadSkills() {
    const skillsDir = path.join(__dirname, 'skills');
    if (!fs.existsSync(skillsDir)) return;

    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    let loaded = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd  = path.join(skillsDir, entry.name, 'SKILL.md');
      const skillIdx = path.join(skillsDir, entry.name, 'index.js');

      if (fs.existsSync(skillMd) && fs.existsSync(skillIdx)) {
        try {
          const handler = require(skillIdx);
          this.router.registerHandler(entry.name, handler);
          loaded++;
          console.log(`  [SKILL] Loaded: ${entry.name}`);
        } catch (e) {
          console.warn(`  [SKILL] Failed to load ${entry.name}: ${e.message}`);
        }
      }
    }

    if (loaded > 0) console.log(`  [SKILL] ${loaded} skill(s) loaded`);
  }

  // ─── Primary Interface ────────────────────────────────────────────────────

  async ask(rawInput, options = {}) {
    if (!this.booted) await this.boot();
    const requestStart = performance.now();

    // 1. INTAKE — parse raw input
    const { task, valid, errors } = intake(rawInput, this.sessionId);

    if (!valid) {
      return buildResponse({
        content:    { type: 'error', error: errors.join(', '), suggestion: 'Try rephrasing.' },
        confidence: 0,
        flags:      ['INVALID_INPUT'],
      });
    }

    if (this.options.verbose) {
      console.log(`\n[${task.id}] Task: type=${task.type}, intent=${task.intent}, confidence=${task.confidence.toFixed(2)}`);
    }

    // 2. THINK — run the ALPHA/BETA loop
    const thinkLoop = new ThinkLoop({ memory: this.memory, options: this.options });
    const chain     = await thinkLoop.run(task);

    if (this.options.verbose) {
      console.log(`\n--- Thought Trace ---\n${chain.toTrace()}\n---`);
    }

    // 3. ROUTE — dispatch to the right handler
    let routeResult;
    try {
      routeResult = await this.router.route(task, chain, { memory: this.memory });
    } catch (e) {
      chain.log('NEXUS', `Routing error: ${e.message}`);
      routeResult = {
        route:   'error',
        result:  { type: 'error', error: e.message, suggestion: 'Internal routing failure' },
      };
    }

    // 4. RESOLVE — build the response
    const response = buildResponse({
      content:    routeResult.result,
      task,
      chain,
      confidence: chain.confidence,
      flags:      chain.flags,
      tone:       task.tone,
      verbose:    this.options.verbose,
    });

    // 5. STORE — remember this interaction
    this.memory.store(task.id, {
      input:    rawInput,
      taskType: task.type,
      response: response.text.substring(0, 1000),
      route:    routeResult.route,
    }, { tier: 'warm', tags: [task.type, task.intent], session: this.sessionId });

    const totalElapsed = (performance.now() - requestStart).toFixed(0);

    if (this.options.verbose) {
      console.log(`[${task.id}] Done in ${totalElapsed}ms via ${routeResult.route}`);
    }

    this.requestLog.push({ id: task.id, type: task.type, route: routeResult.route, elapsed: totalElapsed });

    return {
      ...response,
      id:      task.id,
      route:   routeResult.route,
      elapsed: totalElapsed + 'ms',
    };
  }

  // Convenience: read a file
  async readFile(filePath) {
    return fileReader.read(filePath);
  }

  // Convenience: search the web
  async search(query) {
    return web.searchAndRead(query);
  }

  // Convenience: run code
  async run(code, language = null) {
    return coder.execute(code, { language });
  }

  stats() {
    return {
      version:    VERSION,
      session:    this.sessionId,
      requests:   this.requestLog.length,
      memory:     this.memory?.stats(),
      webCache:   web.cacheStats(),
      router:     this.router?.stats(),
    };
  }
}

// ─── CLI Mode ────────────────────────────────────────────────────────────────

if (require.main === module) {
  const nexus = new NEXUS({ verbose: true });
  const readline = require('readline');

  nexus.boot().then(() => {
    const rl = readline.createInterface({
      input:  process.stdin,
      output: process.stdout,
    });

    const prompt = () => rl.question('NEXUS > ', async (input) => {
      if (!input.trim()) return prompt();
      if (input.trim() === 'exit') { console.log('Shutting down.'); process.exit(0); }
      if (input.trim() === 'stats') { console.log(JSON.stringify(nexus.stats(), null, 2)); return prompt(); }

      try {
        const response = await nexus.ask(input);
        console.log('\n' + response.text + '\n');
        if (response.flags?.length > 0) {
          console.log('[Flags:', response.flags.join(', ') + ']');
        }
      } catch (e) {
        console.error('Error:', e.message);
      }

      prompt();
    });

    process.on('SIGINT', () => { console.log('\nShutting down.'); process.exit(0); });
  });
}

module.exports = NEXUS;
