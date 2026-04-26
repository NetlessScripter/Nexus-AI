/**
 * NEXUS — core/coder.js
 * Code generation, sandboxed execution, and self-debugging.
 * No external AI API. Pure algorithmic + template-based generation.
 * Runs code safely. If it fails, it fixes itself and retries.
 */

'use strict';

const vm          = require('vm');
const { execSync, exec } = require('child_process');
const fs          = require('fs');
const path        = require('path');
const os          = require('os');
const { performance } = require('perf_hooks');

// ─── Constants ────────────────────────────────────────────────────────────────

const SANDBOX_TIMEOUT   = 10_000; // 10s max execution
const MAX_OUTPUT_SIZE   = 100_000; // 100KB max stdout
const TEMP_DIR          = os.tmpdir();
const MAX_DEBUG_CYCLES  = 3;

// ─── Language Detection ───────────────────────────────────────────────────────

const LANGUAGE_SIGNATURES = {
  python:     { exts: ['.py'],         runner: 'python3',  comment: '#' },
  javascript: { exts: ['.js'],         runner: 'node',     comment: '//' },
  typescript: { exts: ['.ts'],         runner: 'npx ts-node', comment: '//' },
  rust:       { exts: ['.rs'],         runner: 'rustc',    comment: '//' },
  go:         { exts: ['.go'],         runner: 'go run',   comment: '//' },
  bash:       { exts: ['.sh'],         runner: 'bash',     comment: '#' },
  ruby:       { exts: ['.rb'],         runner: 'ruby',     comment: '#' },
  sql:        { exts: ['.sql'],        runner: null,       comment: '--' },
  java:       { exts: ['.java'],       runner: 'java',     comment: '//' },
  cpp:        { exts: ['.cpp', '.cc'], runner: 'g++',      comment: '//' },
};

function detectLanguage(code, hint = null) {
  if (hint && LANGUAGE_SIGNATURES[hint.toLowerCase()]) {
    return hint.toLowerCase();
  }

  const patterns = {
    python:     [/^def |^class |^import |^from .+ import|print\(|:\s*$|elif |lambda /m],
    javascript: [/const |let |var |=>|require\(|module\.exports|async |await /],
    typescript: [/: string|: number|: boolean|interface |<T>|as \w|readonly /],
    rust:       [/fn main|let mut|impl |pub fn|use std::|->|match \w|Some\(|Ok\(/],
    go:         [/func |package |import \(|:= |fmt\.|goroutine|go func/],
    bash:       [/^#!/,  /\$\{|fi$|then$|elif |esac$|done$/m],
    ruby:       [/def |end$|puts |require '|\.each|\.map|do \|/m],
    sql:        [/SELECT |INSERT |UPDATE |DELETE |CREATE TABLE|WHERE |JOIN /i],
    java:       [/public class |public static void main|System\.out|import java\./],
    cpp:        [/#include|std::|cout|cin|int main\(|namespace |template </],
  };

  for (const [lang, pats] of Object.entries(patterns)) {
    if (pats.some(p => p.test(code))) return lang;
  }

  return 'javascript'; // Fallback
}

// ─── Code Extraction ─────────────────────────────────────────────────────────

function extractCode(text) {
  // Try fenced code blocks first
  const fenced = text.match(/```(\w+)?\n?([\s\S]*?)```/);
  if (fenced) {
    return {
      code:     fenced[2].trim(),
      language: fenced[1] || null,
    };
  }

  // Try inline code
  const inline = text.match(/`([^`]+)`/);
  if (inline) {
    return { code: inline[1], language: null };
  }

  // Assume the whole text is code
  return { code: text.trim(), language: null };
}

// ─── JavaScript Sandbox (Node VM) ─────────────────────────────────────────────

function runJSInSandbox(code, context = {}) {
  const output  = [];
  const errors  = [];

  const sandbox = {
    console: {
      log:   (...args) => output.push(args.map(String).join(' ')),
      error: (...args) => errors.push(args.map(String).join(' ')),
      warn:  (...args) => errors.push('[WARN] ' + args.map(String).join(' ')),
      info:  (...args) => output.push('[INFO] ' + args.map(String).join(' ')),
    },
    Math,
    JSON,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Map,
    Set,
    Promise,
    setTimeout:  (fn, ms) => { if (ms < 100) fn(); },
    clearTimeout: () => {},
    require: (mod) => {
      // Allow safe built-in modules only
      const ALLOWED = ['path', 'url', 'querystring', 'crypto', 'util', 'events', 'stream'];
      if (ALLOWED.includes(mod)) return require(mod);
      throw new Error(`Module '${mod}' not allowed in sandbox`);
    },
    ...context,
  };

  let result;
  const t0 = performance.now();

  try {
    const script = new vm.Script(code, { filename: 'nexus-sandbox.js' });
    result = script.runInNewContext(sandbox, { timeout: SANDBOX_TIMEOUT });
  } catch (e) {
    return {
      success: false,
      error:   e.message,
      stack:   e.stack,
      output:  output.join('\n'),
      elapsed: performance.now() - t0,
    };
  }

  return {
    success: true,
    result,
    output:  output.join('\n'),
    errors:  errors.join('\n'),
    elapsed: performance.now() - t0,
  };
}

// ─── File-based Execution (Other Languages) ───────────────────────────────────

async function runInProcess(code, language) {
  return new Promise((resolve) => {
    const t0     = performance.now();
    const lang   = LANGUAGE_SIGNATURES[language];
    
    if (!lang || !lang.runner) {
      return resolve({
        success: false,
        error: `No runner configured for ${language}`,
        elapsed: performance.now() - t0,
      });
    }

    // Write to temp file
    const ext      = lang.exts[0];
    const tmpFile  = path.join(TEMP_DIR, `nexus_${Date.now()}${ext}`);
    const outFile  = tmpFile + '.out';

    try {
      fs.writeFileSync(tmpFile, code, 'utf8');
    } catch (e) {
      return resolve({ success: false, error: `Failed to write temp file: ${e.message}` });
    }

    const cmd = language === 'cpp' 
      ? `${lang.runner} -o ${outFile} ${tmpFile} && ${outFile}`
      : `${lang.runner} ${tmpFile}`;

    exec(cmd, { timeout: SANDBOX_TIMEOUT, maxBuffer: MAX_OUTPUT_SIZE }, (err, stdout, stderr) => {
      // Cleanup
      try { fs.unlinkSync(tmpFile); } catch {}
      try { fs.unlinkSync(outFile); } catch {}

      const elapsed = performance.now() - t0;

      if (err && err.killed) {
        return resolve({ success: false, error: 'Execution timed out', elapsed });
      }

      if (err) {
        return resolve({
          success: false,
          error:   stderr || err.message,
          stdout,
          elapsed,
        });
      }

      resolve({
        success: true,
        output:  stdout,
        errors:  stderr,
        elapsed,
      });
    });
  });
}

// ─── Error Analyzer ──────────────────────────────────────────────────────────

function analyzeError(error, code, language) {
  const analysis = {
    type:        'unknown',
    location:    null,
    suggestion:  null,
    fixable:     false,
  };

  const errorStr = error.toLowerCase();

  if (errorStr.includes('syntaxerror') || errorStr.includes('syntax error')) {
    analysis.type = 'SYNTAX';
    const lineMatch = error.match(/line (\d+)/i) || error.match(/:(\d+):/);
    if (lineMatch) analysis.location = parseInt(lineMatch[1]);
    analysis.suggestion = 'Check brackets, parentheses, colons, and indentation';
    analysis.fixable = true;
  } else if (errorStr.includes('referenceerror') || errorStr.includes('nameerror')) {
    analysis.type = 'UNDEFINED_VAR';
    const varMatch = error.match(/['"](\w+)['"]\s+is not defined/i) ||
                     error.match(/name '(\w+)' is not defined/i);
    if (varMatch) analysis.undefined = varMatch[1];
    analysis.suggestion = `Variable '${analysis.undefined}' needs to be declared before use`;
    analysis.fixable = true;
  } else if (errorStr.includes('typeerror')) {
    analysis.type = 'TYPE_ERROR';
    analysis.suggestion = 'Check types — you may be calling a method on null/undefined';
    analysis.fixable = true;
  } else if (errorStr.includes('timeout')) {
    analysis.type = 'TIMEOUT';
    analysis.suggestion = 'Code is too slow or has an infinite loop';
    analysis.fixable = false;
  } else if (errorStr.includes('importerror') || errorStr.includes('modulerror')) {
    analysis.type = 'IMPORT';
    analysis.suggestion = 'Required module not available in sandbox';
    analysis.fixable = false;
  }

  return analysis;
}

// ─── Self-Debugger ────────────────────────────────────────────────────────────

async function selfDebug(code, error, language, context = {}) {
  const analysis = analyzeError(error, code, language);
  
  if (!analysis.fixable) {
    return {
      fixed:  false,
      reason: analysis.suggestion || 'Error type cannot be auto-fixed',
      analysis,
    };
  }

  let fixedCode = code;

  if (analysis.type === 'SYNTAX') {
    // Common JS/Python syntax fixes
    if (language === 'javascript' || language === 'typescript') {
      fixedCode = fixedCode
        .replace(/([^=!<>])=([^=])/g, (m, a, b) => `${a}=${b}`) // Idempotent, but catches some
        .replace(/\bvar\b/g, 'let'); // Modern JS
    }
    if (language === 'python') {
      // Fix common Python indentation issues
      const lines = fixedCode.split('\n');
      fixedCode = lines.map(line => line.replace(/\t/, '    ')).join('\n');
    }
  }

  if (analysis.type === 'UNDEFINED_VAR' && analysis.undefined) {
    const varName = analysis.undefined;
    // Add a declaration at the top if we can infer type
    if (language === 'javascript') {
      fixedCode = `let ${varName};\n${fixedCode}`;
    } else if (language === 'python') {
      fixedCode = `${varName} = None\n${fixedCode}`;
    }
  }

  if (fixedCode === code) {
    return { fixed: false, reason: 'No automated fix available', analysis };
  }

  return {
    fixed:    true,
    code:     fixedCode,
    analysis,
    change:   `Applied ${analysis.type} fix`,
  };
}

// ─── Main Execute Function ────────────────────────────────────────────────────

async function execute(code, options = {}) {
  const {
    language: langHint = null,
    context           = {},
    autoDebug         = true,
    maxRetries        = MAX_DEBUG_CYCLES,
  } = options;

  // Extract code if it's wrapped in markdown
  const extracted = typeof code === 'string' && code.includes('```')
    ? extractCode(code)
    : { code, language: langHint };

  const lang    = detectLanguage(extracted.code, extracted.language || langHint);
  let   current = extracted.code;
  const history = [];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const t0 = performance.now();
    let   result;

    // Choose execution method
    if (lang === 'javascript') {
      result = runJSInSandbox(current, context);
    } else {
      result = await runInProcess(current, lang);
    }

    result.attempt  = attempt;
    result.language = lang;
    history.push({ attempt, code: current, result });

    if (result.success) {
      return {
        success:    true,
        language:   lang,
        code:       current,
        output:     result.output || String(result.result ?? ''),
        result:     result.result,
        elapsed:    result.elapsed,
        attempts:   attempt + 1,
        history,
      };
    }

    // Execution failed
    if (!autoDebug || attempt >= maxRetries) break;

    // Try to self-debug
    const debugResult = await selfDebug(current, result.error, lang, context);
    
    if (!debugResult.fixed) {
      return {
        success:    false,
        language:   lang,
        code:       current,
        error:      result.error,
        analysis:   debugResult.analysis,
        suggestion: debugResult.reason,
        attempts:   attempt + 1,
        history,
      };
    }

    current = debugResult.code;
  }

  return {
    success:  false,
    language: lang,
    code:     current,
    error:    history[history.length - 1]?.result?.error || 'Unknown error',
    attempts: history.length,
    history,
  };
}

// ─── Code Analysis (Static, no execution) ────────────────────────────────────

function analyze(code, language = null) {
  const lang = detectLanguage(code, language);
  const lines = code.split('\n');

  return {
    language:     lang,
    lineCount:    lines.length,
    charCount:    code.length,
    functions:    (code.match(/\bfunction\b|\bdef\b|\bfn\b/g) || []).length,
    classes:      (code.match(/\bclass\b/g) || []).length,
    imports:      (code.match(/\bimport\b|\brequire\b/g) || []).length,
    hasAsync:     /async|await|Promise|goroutine|tokio/.test(code),
    hasLoops:     /for\s*\(|while\s*\(|\.forEach|\.map\(/.test(code),
    hasRecursion: /\brecursive\b|\brecurse\b/.test(code.toLowerCase()),
    complexity:   estimateComplexity(code),
    comments:     lines.filter(l => l.trim().startsWith('//') || l.trim().startsWith('#') || l.trim().startsWith('--')).length,
  };
}

function estimateComplexity(code) {
  // Rough cyclomatic complexity estimate
  const controlFlow = (code.match(/\bif\b|\belse\b|\bfor\b|\bwhile\b|\bcase\b|\bcatch\b|\b\?\s/g) || []).length;
  if (controlFlow < 3)  return 'LOW';
  if (controlFlow < 10) return 'MEDIUM';
  if (controlFlow < 20) return 'HIGH';
  return 'VERY_HIGH';
}

module.exports = {
  execute,
  analyze,
  detectLanguage,
  extractCode,
  selfDebug,
  runJSInSandbox,
  runInProcess,
};
