/**
 * NEXUS — core/router.js
 * Routes tasks to the right skill/handler after the think loop.
 * Smart. Fast. Never blocks. Falls through to fallback if needed.
 */

'use strict';

const { performance } = require('perf_hooks');

// ─── Route Definitions ────────────────────────────────────────────────────────

const ROUTES = [
  {
    name:     'code-execute',
    matches:  (task) => task.type === 'CODE' && task.hasCode,
    priority: 100,
    handler:  'coder',
    mode:     'execute',
  },
  {
    name:     'code-generate',
    matches:  (task) => task.type === 'CODE' && !task.hasCode,
    priority: 90,
    handler:  'coder',
    mode:     'generate',
  },
  {
    name:     'web-search',
    matches:  (task) => task.type === 'SEARCH' || (task.secondary.includes('SEARCH') && task.hasURLs),
    priority: 85,
    handler:  'web',
    mode:     'search',
  },
  {
    name:     'url-read',
    matches:  (task) => task.hasURLs && task.urls.length > 0,
    priority: 80,
    handler:  'web',
    mode:     'readPage',
  },
  {
    name:     'file-analyze',
    matches:  (task) => task.hasFiles && task.filePaths.length > 0,
    priority: 88,
    handler:  'fileReader',
    mode:     'analyze',
  },
  {
    name:     'analyze',
    matches:  (task) => task.type === 'ANALYZE',
    priority: 70,
    handler:  'synthesizer',
    mode:     'analyze',
  },
  {
    name:     'create',
    matches:  (task) => task.type === 'CREATE',
    priority: 65,
    handler:  'synthesizer',
    mode:     'create',
  },
  {
    name:     'impossible',
    matches:  (task) => task.type === 'IMPOSSIBLE',
    priority: 95,
    handler:  'impossibleRouter',
    mode:     'resolve',
  },
  {
    name:     'query-fallback',
    matches:  () => true,     // Always matches
    priority: 0,
    handler:  'synthesizer',
    mode:     'query',
  },
];

// ─── Router ───────────────────────────────────────────────────────────────────

class Router {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.routes   = [...ROUTES].sort((a, b) => b.priority - a.priority);
    this.stats    = { routed: 0, fallbacks: 0, errors: 0 };
  }

  registerHandler(name, handler) {
    this.handlers[name] = handler;
  }

  // Find the best route for this task
  findRoute(task) {
    for (const route of this.routes) {
      if (route.matches(task)) {
        return route;
      }
    }
    return this.routes[this.routes.length - 1]; // Fallback
  }

  // Find ALL matching routes (for multi-step tasks)
  findAllRoutes(task) {
    return this.routes.filter(r => r.matches(task));
  }

  // Execute routing
  async route(task, chain, context = {}) {
    const t0    = performance.now();
    const route = this.findRoute(task);

    this.stats.routed++;
    chain.log('ROUTER', `Routing task [${task.type}] → ${route.handler}:${route.mode} (priority=${route.priority})`);

    const handler = this.handlers[route.handler];

    if (!handler) {
      this.stats.errors++;
      chain.log('ROUTER', `No handler registered for '${route.handler}'. Using fallback.`);
      return this._fallback(task, chain, context);
    }

    try {
      const result = await handler.execute(task, { mode: route.mode, chain, ...context });
      chain.log('ROUTER', `Handler '${route.handler}' completed in ${(performance.now() - t0).toFixed(1)}ms`);
      return {
        route:   route.name,
        handler: route.handler,
        mode:    route.mode,
        result,
        elapsed: performance.now() - t0,
      };
    } catch (error) {
      this.stats.errors++;
      chain.log('ROUTER', `Handler '${route.handler}' threw: ${error.message}. Trying fallback.`);
      return this._fallback(task, chain, context, error);
    }
  }

  async _fallback(task, chain, context, previousError = null) {
    this.stats.fallbacks++;
    chain.log('ROUTER', `Executing fallback handler`);

    // Fallback: synthesize a best-effort response using available context
    return {
      route:   'fallback',
      handler: 'internal',
      mode:    'fallback',
      result:  {
        type:    'fallback',
        content: `I hit a problem${previousError ? ` (${previousError.message})` : ''} routing this task. Here's what I know: the task was [${task.type}] and the raw input was "${task.raw.substring(0, 200)}"`,
        task,
        error:   previousError?.message,
      },
    };
  }

  stats() {
    return this.stats;
  }
}

// ─── Built-in Handler Stubs ───────────────────────────────────────────────────
// Real handlers are injected at boot. These are the contracts.

const HandlerContract = {
  // All handlers must implement this
  async execute(task, options) {
    throw new Error('execute() not implemented');
  }
};

// ─── Handler: Impossible Router ───────────────────────────────────────────────

class ImpossibleHandler {
  async execute(task, { mode, chain }) {
    chain.log('IMPOSSIBLE', `Running Impossibility Protocol on: "${task.raw.substring(0, 100)}"`);

    // Step 1: Identify the actual blocker
    const blocker = this._findBlocker(task);
    chain.log('IMPOSSIBLE', `Core blocker: ${blocker.description}`);

    // Step 2: Generate workarounds
    const workarounds = this._generateWorkarounds(task, blocker);
    chain.log('IMPOSSIBLE', `Found ${workarounds.length} potential workarounds`);

    // Step 3: Rank by feasibility
    const best = workarounds.sort((a, b) => b.feasibility - a.feasibility)[0];

    if (best && best.feasibility > 0.4) {
      chain.log('IMPOSSIBLE', `Best workaround: ${best.description} (${(best.feasibility * 100).toFixed(0)}% feasible)`);
      return {
        type:       'workaround',
        content:    best.description,
        method:     best.method,
        tradeoffs:  best.tradeoffs,
        feasibility: best.feasibility,
        blocker,
      };
    }

    // Step 4: If truly impossible, explain EXACTLY why
    chain.log('IMPOSSIBLE', `No workaround above threshold. Explaining constraint.`);
    return {
      type:    'impossible',
      content: blocker.explanation,
      blocker,
      workarounds: workarounds.map(w => ({
        description: w.description,
        feasibility: w.feasibility,
        why_rejected: w.feasibility <= 0.4 ? 'Below feasibility threshold' : 'Superseded by better option',
      })),
    };
  }

  _findBlocker(task) {
    const raw = task.raw.toLowerCase();

    const blockers = [
      {
        triggers:    ['time travel', 'go back in time', 'change the past'],
        description: 'Causal physics violation',
        explanation: 'Time travel backward is physically impossible — causality is a constraint of the universe, not a software limitation.',
        category:    'physics',
      },
      {
        triggers:    ['infinite', 'unlimited', 'endless', 'perpetual'],
        description: 'Resource boundedness violation',
        explanation: 'All physical systems are bounded. "Infinite" performance requires infinite resources, which don\'t exist.',
        category:    'physics',
      },
      {
        triggers:    ['hack', 'bypass', 'jailbreak', 'circumvent'],
        description: 'Security constraint',
        explanation: 'This depends on the specific system. What exactly needs to be bypassed?',
        category:    'security',
      },
      {
        triggers:    ['predict', 'future', 'know what will'],
        description: 'Epistemic limitation',
        explanation: 'Future prediction with certainty is impossible for chaotic systems. Probabilistic modeling is possible.',
        category:    'epistemics',
      },
    ];

    for (const blocker of blockers) {
      if (blocker.triggers.some(t => raw.includes(t))) {
        return blocker;
      }
    }

    return {
      description: 'Unclassified constraint',
      explanation: 'The specific constraint here isn\'t one I\'ve pre-mapped. Let me reason through it.',
      category:    'unknown',
    };
  }

  _generateWorkarounds(task, blocker) {
    const category = blocker.category;
    const raw      = task.raw.toLowerCase();

    const universal = [
      {
        description: 'Simulate the desired outcome in a sandboxed environment',
        method:      'simulation',
        feasibility: 0.65,
        tradeoffs:   'Results are synthetic, not real',
      },
      {
        description: 'Solve an analogous, achievable problem and map the solution',
        method:      'analogy',
        feasibility: 0.60,
        tradeoffs:   'May not transfer perfectly to original problem',
      },
      {
        description: 'Identify what IS possible and maximize within those bounds',
        method:      'bounded-optimization',
        feasibility: 0.75,
        tradeoffs:   'Doesn\'t achieve the impossible part, achieves the maximum possible',
      },
    ];

    if (category === 'physics') {
      return [
        ...universal,
        {
          description: 'Model the physics to show what WOULD happen under different conditions',
          method:      'counterfactual-modeling',
          feasibility: 0.70,
          tradeoffs:   'Theoretical, not executable in reality',
        },
      ];
    }

    if (category === 'security') {
      return [
        {
          description: 'Identify the exact security mechanism — some can be legitimately tested',
          method:      'constraint-identification',
          feasibility: 0.72,
          tradeoffs:   'Depends heavily on what\'s actually being requested',
        },
        ...universal,
      ];
    }

    return universal;
  }
}

module.exports = { Router, ImpossibleHandler, ROUTES };
