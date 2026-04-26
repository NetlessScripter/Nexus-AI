/**
 * NEXUS — core/think.js
 * The actual brain. ALPHA + BETA internal dialogue. 10-second think window.
 * 
 * This is not a gimmick. This is the engine.
 */

'use strict';

const { performance } = require('perf_hooks');

// ─── Constants ────────────────────────────────────────────────────────────────

const THINK_WINDOW_MS   = 10_000;   // Hard cap: 10 seconds to think
const MAX_CYCLES        = 8;         // Max ALPHA→BETA debate cycles
const CONFIDENCE_FLOOR  = 0.72;      // Min confidence to ship without flagging
const BETA_AGGRESSION   = 0.85;      // How hard BETA pushes back (0–1)

// ─── ThoughtChain ────────────────────────────────────────────────────────────

class ThoughtChain {
  constructor(taskId) {
    this.taskId    = taskId;
    this.startedAt = performance.now();
    this.entries   = [];
    this.conclusion = null;
    this.confidence = 0;
    this.flags      = [];
  }

  log(agent, message, meta = {}) {
    const elapsed = (performance.now() - this.startedAt).toFixed(1);
    this.entries.push({ agent, message, elapsed: `${elapsed}ms`, ...meta });
  }

  elapsed() {
    return performance.now() - this.startedAt;
  }

  toTrace() {
    return this.entries.map(e =>
      `[${e.elapsed}] ${e.agent}: ${e.message}`
    ).join('\n');
  }
}

// ─── ALPHA Agent ─────────────────────────────────────────────────────────────
// Optimistic. Proposes. Finds paths. Never gives up.

class Alpha {
  constructor(chain) {
    this.chain = chain;
    this.name  = 'ALPHA';
  }

  async propose(task, context, cycle) {
    this.chain.log(this.name, `Cycle ${cycle}: Analyzing task type=${task.type}, intent=${task.intent}`);

    // Break task into sub-components
    const breakdown = this._decompose(task);
    this.chain.log(this.name, `Decomposed into ${breakdown.length} sub-tasks: ${breakdown.map(s => s.label).join(', ')}`);

    // Try to find a viable approach for each
    const approaches = [];
    for (const sub of breakdown) {
      const approach = await this._findApproach(sub, context);
      approaches.push(approach);
      this.chain.log(this.name, `Sub-task [${sub.label}]: ${approach.method} (confidence=${approach.confidence.toFixed(2)})`);
    }

    const worstConfidence = Math.min(...approaches.map(a => a.confidence));
    const proposal = {
      breakdown,
      approaches,
      confidence: worstConfidence,
      plan: this._buildPlan(breakdown, approaches),
    };

    this.chain.log(this.name, `Proposal ready. Weakest link: ${(worstConfidence * 100).toFixed(0)}%`);
    return proposal;
  }

  async revise(proposal, betaFeedback, task, context) {
    this.chain.log(this.name, `BETA said: "${betaFeedback.critique}"`);
    this.chain.log(this.name, `Revising... targeting weak point: ${betaFeedback.weakPoint}`);

    // Address BETA's specific critique
    const revisedApproaches = [...proposal.approaches];
    const targetIdx = revisedApproaches.findIndex(a => 
      a.subTask === betaFeedback.weakPoint
    );

    if (targetIdx >= 0) {
      const alternative = await this._findAlternativeApproach(
        proposal.breakdown[targetIdx], 
        context,
        betaFeedback.reason
      );
      revisedApproaches[targetIdx] = alternative;
      this.chain.log(this.name, `Found alternative for [${betaFeedback.weakPoint}]: ${alternative.method}`);
    } else {
      // BETA attacked the whole plan — restructure
      this.chain.log(this.name, `Structural critique. Rebuilding plan from scratch.`);
      return this.propose(task, context, -1);
    }

    return {
      ...proposal,
      approaches: revisedApproaches,
      confidence: Math.min(...revisedApproaches.map(a => a.confidence)),
      plan: this._buildPlan(proposal.breakdown, revisedApproaches),
      revised: true,
    };
  }

  // Lateral move: if direct route blocked, find a workaround
  async findWorkaround(task, blockedApproach, context) {
    this.chain.log(this.name, `Direct route blocked. Searching for lateral workaround...`);
    
    const workarounds = this._generateWorkarounds(task, blockedApproach);
    this.chain.log(this.name, `${workarounds.length} potential workarounds found`);
    
    for (const w of workarounds) {
      this.chain.log(this.name, `Testing workaround: ${w.description}`);
      if (w.feasibility > 0.5) {
        this.chain.log(this.name, `Workaround viable: ${w.description} (feasibility=${w.feasibility.toFixed(2)})`);
        return w;
      }
    }

    this.chain.log(this.name, `No workaround cleared 0.5 feasibility. Escalating to IMPOSSIBLE protocol.`);
    return null;
  }

  _decompose(task) {
    // Break the raw task into addressable sub-tasks
    const subs = [];

    if (task.type === 'CODE') {
      subs.push(
        { label: 'understand-intent', data: task.raw },
        { label: 'select-language', data: task.language || 'auto' },
        { label: 'design-structure', data: task.constraints },
        { label: 'generate-code', data: task },
        { label: 'verify-correctness', data: null }
      );
    } else if (task.type === 'SEARCH') {
      subs.push(
        { label: 'extract-query', data: task.raw },
        { label: 'identify-sources', data: task.domain },
        { label: 'fetch-data', data: null },
        { label: 'synthesize-answer', data: null }
      );
    } else if (task.type === 'ANALYZE') {
      subs.push(
        { label: 'load-subject', data: task.subject },
        { label: 'identify-dimensions', data: null },
        { label: 'run-analysis', data: null },
        { label: 'form-conclusion', data: null }
      );
    } else if (task.type === 'IMPOSSIBLE') {
      subs.push(
        { label: 'identify-blocker', data: task.raw },
        { label: 'decompose-blocker', data: null },
        { label: 'lateral-search', data: null },
        { label: 'approximate-or-exact', data: null }
      );
    } else {
      subs.push(
        { label: 'parse-intent', data: task.raw },
        { label: 'select-strategy', data: null },
        { label: 'execute', data: null }
      );
    }

    return subs;
  }

  async _findApproach(subTask, context) {
    // Route each sub-task to the best available strategy
    const strategies = {
      'understand-intent':    { method: 'semantic-parse',     confidence: 0.95 },
      'select-language':      { method: 'context-inference',  confidence: 0.88 },
      'design-structure':     { method: 'pattern-match',      confidence: 0.82 },
      'generate-code':        { method: 'skill:code-gen',     confidence: 0.90 },
      'verify-correctness':   { method: 'sandbox-run',        confidence: 0.85 },
      'extract-query':        { method: 'nlp-extract',        confidence: 0.93 },
      'identify-sources':     { method: 'domain-map',         confidence: 0.80 },
      'fetch-data':           { method: 'skill:web-search',   confidence: 0.87 },
      'synthesize-answer':    { method: 'skill:synthesize',   confidence: 0.88 },
      'load-subject':         { method: 'skill:file-analyze', confidence: 0.91 },
      'identify-dimensions':  { method: 'topic-model',        confidence: 0.79 },
      'run-analysis':         { method: 'skill:synthesize',   confidence: 0.84 },
      'form-conclusion':      { method: 'chain-of-thought',   confidence: 0.86 },
      'identify-blocker':     { method: 'constraint-map',     confidence: 0.90 },
      'decompose-blocker':    { method: 'sub-problem-split',  confidence: 0.83 },
      'lateral-search':       { method: 'workaround-search',  confidence: 0.70 },
      'approximate-or-exact': { method: 'feasibility-check',  confidence: 0.75 },
      'parse-intent':         { method: 'multi-label-classify',confidence: 0.88 },
      'select-strategy':      { method: 'skill-bus-query',    confidence: 0.85 },
      'execute':              { method: 'dynamic-dispatch',   confidence: 0.82 },
    };

    return {
      subTask: subTask.label,
      ...(strategies[subTask.label] || { method: 'fallback-heuristic', confidence: 0.60 })
    };
  }

  async _findAlternativeApproach(subTask, context, reason) {
    // Given a failed approach, find an alternative
    const alternatives = {
      'sandbox-run':       { method: 'static-analysis',      confidence: 0.78 },
      'skill:web-search':  { method: 'cached-knowledge',     confidence: 0.65 },
      'skill:code-gen':    { method: 'template-adaptation',  confidence: 0.77 },
      'pattern-match':     { method: 'constraint-satisfaction',confidence: 0.74 },
    };

    const primary = await this._findApproach(subTask, context);
    return alternatives[primary.method] || 
           { subTask: subTask.label, method: 'manual-heuristic', confidence: 0.60 };
  }

  _generateWorkarounds(task, blockedApproach) {
    // Generate lateral approaches when direct path is blocked
    return [
      {
        description: `Approximate via simulation`,
        method: 'simulate',
        feasibility: task.type === 'QUERY' ? 0.75 : 0.55,
        tradeoff: 'Approximate, not exact'
      },
      {
        description: `Decompose and solve each piece independently`,
        method: 'decompose-and-conquer',
        feasibility: 0.70,
        tradeoff: 'May miss cross-component interactions'
      },
      {
        description: `Use proxy data / similar known problem`,
        method: 'proxy',
        feasibility: task.domain ? 0.68 : 0.45,
        tradeoff: 'Results are analogous, not identical'
      },
      {
        description: `Invert the problem — solve what we CAN, fill gap with uncertainty bound`,
        method: 'invert',
        feasibility: 0.62,
        tradeoff: 'Output includes explicit uncertainty range'
      }
    ].sort((a, b) => b.feasibility - a.feasibility);
  }

  _buildPlan(breakdown, approaches) {
    return breakdown.map((sub, i) => ({
      step: i + 1,
      task: sub.label,
      method: approaches[i]?.method || 'unknown',
      confidence: approaches[i]?.confidence || 0,
    }));
  }
}

// ─── BETA Agent ───────────────────────────────────────────────────────────────
// Critic. Tears apart ALPHA's proposals. Finds the flaw in everything.

class Beta {
  constructor(chain, aggression = BETA_AGGRESSION) {
    this.chain      = chain;
    this.name       = 'BETA';
    this.aggression = aggression;
  }

  async critique(proposal, task) {
    this.chain.log(this.name, `Reviewing ALPHA's proposal. Aggression level: ${(this.aggression * 100).toFixed(0)}%`);

    const issues = [];

    // Find the weakest confidence step
    const weakest = proposal.approaches.reduce((min, a) => 
      a.confidence < min.confidence ? a : min, 
      proposal.approaches[0]
    );

    this.chain.log(this.name, `Weakest step: [${weakest.subTask}] at ${(weakest.confidence * 100).toFixed(0)}%`);

    // Decide whether to challenge based on aggression + confidence
    const shouldChallenge = weakest.confidence < (1 - this.aggression + 0.3);

    if (shouldChallenge) {
      const critique = this._buildCritique(weakest, task, proposal);
      this.chain.log(this.name, `Challenge: ${critique.critique}`);
      issues.push(critique);
    } else {
      this.chain.log(this.name, `Plan holds. Confidence floor met at ${(weakest.confidence * 100).toFixed(0)}%. No challenge.`);
    }

    // Secondary check: is the WHOLE plan coherent end-to-end?
    const coherence = this._checkCoherence(proposal);
    if (!coherence.ok) {
      this.chain.log(this.name, `Coherence issue: ${coherence.issue}`);
      issues.push({
        type: 'coherence',
        critique: coherence.issue,
        weakPoint: 'plan-structure',
        reason: coherence.detail,
        severity: 0.7,
      });
    }

    // Tertiary: task-specific sanity checks
    const sanity = this._sanityCheck(task, proposal);
    if (!sanity.passed) {
      this.chain.log(this.name, `Sanity fail: ${sanity.issue}`);
      issues.push({
        type: 'sanity',
        critique: sanity.issue,
        weakPoint: sanity.step,
        reason: sanity.detail,
        severity: 0.9,
      });
    }

    if (issues.length === 0) {
      this.chain.log(this.name, `No issues found. ALPHA's plan is solid.`);
      return { approved: true, issues: [] };
    }

    // Return worst issue for ALPHA to address
    const worst = issues.sort((a, b) => b.severity - a.severity)[0];
    return { approved: false, issues, primaryIssue: worst };
  }

  _buildCritique(weakStep, task, proposal) {
    const critiques = {
      'sandbox-run': {
        critique: `We're planning to run untrusted code in a sandbox — but the sandbox config isn't validated yet.`,
        reason: 'Sandbox may not be properly isolated for this task type',
        severity: 0.8,
      },
      'skill:web-search': {
        critique: `Web search is in the plan but we don't know if the data is actually online or if it's behind a paywall.`,
        reason: 'Fetch reliability unconfirmed',
        severity: 0.6,
      },
      'workaround-search': {
        critique: `Workaround search has a confidence of ${(weakStep.confidence * 100).toFixed(0)}%. That's not high enough to ship without a fallback.`,
        reason: 'Low confidence lateral path needs backup',
        severity: 0.75,
      },
      'fallback-heuristic': {
        critique: `We fell back to heuristic for [${weakStep.subTask}]. That's a cop-out. We should find a real method.`,
        reason: 'Heuristics produce unreliable results',
        severity: 0.85,
      },
    };

    return {
      ...(critiques[weakStep.method] || {
        critique: `Step [${weakStep.subTask}] has confidence ${(weakStep.confidence * 100).toFixed(0)}% — not good enough.`,
        reason: 'Low confidence in execution method',
        severity: 0.7,
      }),
      weakPoint: weakStep.subTask,
      type: 'confidence',
    };
  }

  _checkCoherence(proposal) {
    // Steps must form a logical sequence — no orphan outputs, no skipped inputs
    const plan = proposal.plan;
    if (plan.length < 2) return { ok: true };

    // Check if any step depends on output from a step that isn't in the plan
    const methodsUsed = plan.map(p => p.method);
    const hasWeb = methodsUsed.includes('skill:web-search');
    const hasCodeRun = methodsUsed.includes('sandbox-run');
    const hasCodeGen = methodsUsed.includes('skill:code-gen');

    if (hasCodeRun && !hasCodeGen) {
      return {
        ok: false,
        issue: `Plan includes sandbox execution but no code generation step. Where's the code coming from?`,
        detail: 'Missing code-gen before sandbox-run'
      };
    }

    return { ok: true };
  }

  _sanityCheck(task, proposal) {
    // Task-type specific checks
    if (task.type === 'CODE') {
      const hasVerify = proposal.approaches.some(a => 
        a.method === 'sandbox-run' || a.method === 'static-analysis'
      );
      if (!hasVerify) {
        return {
          passed: false,
          issue: `Code task has no verification step. We'd be shipping untested code.`,
          step: 'verify-correctness',
          detail: 'Code must be verified before output'
        };
      }
    }

    if (task.type === 'IMPOSSIBLE') {
      const hasWorkaround = proposal.approaches.some(a => 
        a.method.includes('workaround') || a.method.includes('lateral')
      );
      if (!hasWorkaround) {
        return {
          passed: false,
          issue: `This task is tagged IMPOSSIBLE but there's no workaround search in the plan. That's giving up.`,
          step: 'lateral-search',
          detail: 'IMPOSSIBLE tasks require workaround exploration'
        };
      }
    }

    return { passed: true };
  }
}

// ─── ThinkLoop — Main Orchestrator ───────────────────────────────────────────

class ThinkLoop {
  constructor(context) {
    this.context = context;
    this.alpha   = null;
    this.beta    = null;
  }

  /**
   * Main entry point. Runs the full ALPHA↔BETA loop.
   * Returns a resolved ThoughtChain with conclusion + plan.
   */
  async run(task) {
    const chain = new ThoughtChain(task.id);
    this.alpha  = new Alpha(chain);
    this.beta   = new Beta(chain);

    chain.log('NEXUS', `Task received: ${task.type} — "${task.raw?.substring(0, 80)}..."`);
    chain.log('NEXUS', `Starting think loop. Window: ${THINK_WINDOW_MS}ms, MaxCycles: ${MAX_CYCLES}`);

    let proposal  = null;
    let approved  = false;
    let cycle     = 0;

    while (!approved && cycle < MAX_CYCLES && chain.elapsed() < THINK_WINDOW_MS) {
      cycle++;
      chain.log('NEXUS', `─── Cycle ${cycle}/${MAX_CYCLES} ───`);

      // ALPHA proposes
      if (!proposal) {
        proposal = await this.alpha.propose(task, this.context, cycle);
      } else {
        const betaResult = await this.beta.critique(proposal, task);
        if (!betaResult.approved) {
          proposal = await this.alpha.revise(proposal, betaResult.primaryIssue, task, this.context);
        } else {
          approved = true;
          break;
        }
      }

      // BETA critiques
      const betaResult = await this.beta.critique(proposal, task);

      if (betaResult.approved) {
        approved = true;
        chain.log('NEXUS', `BETA approved the plan on cycle ${cycle}.`);
        break;
      }

      // If ALPHA can't get past BETA after 4 cycles, try workaround
      if (cycle >= 4 && !approved) {
        chain.log('NEXUS', `Stuck after ${cycle} cycles. Looking for workaround...`);
        const workaround = await this.alpha.findWorkaround(task, proposal, this.context);
        if (workaround) {
          chain.log('NEXUS', `Shipping via workaround: ${workaround.description}`);
          chain.flags.push(`WORKAROUND:${workaround.method}`);
          proposal.workaround = workaround;
          approved = true;
          break;
        }
      }
    }

    // Time limit hit
    if (chain.elapsed() >= THINK_WINDOW_MS) {
      chain.log('NEXUS', `Think window expired (${chain.elapsed().toFixed(0)}ms). Shipping best available.`);
      chain.flags.push('THINK_TIMEOUT');
    }

    // Low confidence final check
    if (proposal && proposal.confidence < CONFIDENCE_FLOOR) {
      chain.log('NEXUS', `Final confidence ${(proposal.confidence * 100).toFixed(0)}% below floor. Flagging.`);
      chain.flags.push(`LOW_CONFIDENCE:${(proposal.confidence * 100).toFixed(0)}%`);
    }

    chain.conclusion = proposal;
    chain.confidence = proposal?.confidence || 0;
    chain.log('NEXUS', `Think loop complete. ${chain.entries.length} thoughts logged. Elapsed: ${chain.elapsed().toFixed(0)}ms`);

    return chain;
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = { ThinkLoop, ThoughtChain, Alpha, Beta, THINK_WINDOW_MS };
