/**
 * NEXUS — core/intake.js
 * Converts raw user input into a normalized Task object.
 * Fast. Precise. No ambiguity tolerated.
 */

'use strict';

const crypto = require('crypto');

// ─── Intent Classifiers ───────────────────────────────────────────────────────

const INTENT_PATTERNS = [
  {
    type: 'CODE',
    patterns: [
      /\b(write|create|build|implement|code|develop|make|generate)\b.*\b(function|class|script|program|api|module|component|app|tool|algorithm)\b/i,
      /\b(in|using|with)\s+(python|javascript|typescript|rust|go|c\+\+|java|ruby|swift|kotlin)\b/i,
      /\b(debug|fix|refactor|optimize|review)\b.*\bcode\b/i,
      /```[\s\S]*```/,
      /\b(async|await|import|export|def |fn |class |struct )\b/,
    ],
    weight: 1.0,
  },
  {
    type: 'SEARCH',
    patterns: [
      /\b(search|find|look up|google|what('s| is) the (latest|current|recent)|news about)\b/i,
      /\b(who (is|was)|what (is|are)|when (did|was|is)|where (is|was))\b.*\b(today|now|current|recent|2024|2025|2026)\b/i,
      /\b(price|stock|weather|score|result|update)\b.*\b(today|now|current|live)\b/i,
    ],
    weight: 0.9,
  },
  {
    type: 'ANALYZE',
    patterns: [
      /\b(analyze|analyse|examine|review|assess|evaluate|summarize|explain|break down)\b/i,
      /\b(why does|how does|what causes|what happens when)\b/i,
      /\b(compare|contrast|difference between|vs\.?|versus)\b/i,
      /\b(read (this|the|my)|look at (this|the|my)|check (this|the|my))\b/i,
    ],
    weight: 0.85,
  },
  {
    type: 'CREATE',
    patterns: [
      /\b(write|draft|compose|create|generate)\b.*\b(essay|article|story|email|letter|report|document|poem|plan|outline)\b/i,
      /\b(help me write|can you write|write me|draft me)\b/i,
    ],
    weight: 0.8,
  },
  {
    type: 'IMPOSSIBLE',
    patterns: [
      /\b(impossible|can't be done|no way to|there's no|doesn't exist|won't work)\b/i,
      /\b(hack|bypass|circumvent|override|jailbreak)\b/i,
      /\b(predict the future|time travel|infinite|perpetual motion)\b/i,
    ],
    weight: 0.7,
  },
  {
    type: 'QUERY',
    patterns: [/.*/],  // Catch-all
    weight: 0.1,
  },
];

// ─── Entity Extractors ────────────────────────────────────────────────────────

function extractCodeBlocks(text) {
  const blocks = [];
  const regex = /```(\w+)?\n?([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push({ language: match[1] || 'unknown', code: match[2].trim() });
  }
  return blocks;
}

function extractURLs(text) {
  const regex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
  return [...new Set(text.match(regex) || [])];
}

function extractFilePaths(text) {
  const regex = /(?:^|[\s"'])([./~][\w./\\-]+\.\w{1,10})/gm;
  return [...new Set((text.match(regex) || []).map(p => p.trim()))];
}

function extractLanguage(text, codeBlocks) {
  if (codeBlocks.length > 0 && codeBlocks[0].language !== 'unknown') {
    return codeBlocks[0].language;
  }
  const langs = ['python', 'javascript', 'typescript', 'rust', 'go', 'c++', 'java', 'ruby', 'swift', 'kotlin', 'bash', 'sql'];
  for (const lang of langs) {
    if (new RegExp(`\\b${lang}\\b`, 'i').test(text)) return lang;
  }
  return null;
}

function detectUrgency(text) {
  if (/\b(asap|urgent|immediately|right now|hurry|quickly|fast)\b/i.test(text)) return 'HIGH';
  if (/\b(when you can|no rush|eventually|sometime)\b/i.test(text)) return 'LOW';
  return 'NORMAL';
}

function detectTone(text) {
  if (/[!?]{2,}/.test(text) || text === text.toUpperCase() && text.length > 10) return 'URGENT';
  if (/\b(please|thank|appreciate|could you|would you mind)\b/i.test(text)) return 'POLITE';
  if (/^(what|how|why|when|where|who|is|are|can|does)\b/i.test(text.trim())) return 'CURIOUS';
  return 'NEUTRAL';
}

// ─── Intent Classification ─────────────────────────────────────────────────

function classifyIntent(text) {
  const scores = {};

  for (const classifier of INTENT_PATTERNS) {
    let score = 0;
    for (const pattern of classifier.patterns) {
      if (pattern.test(text)) {
        score += classifier.weight;
      }
    }
    if (score > 0) {
      scores[classifier.type] = (scores[classifier.type] || 0) + score;
    }
  }

  if (Object.keys(scores).length === 0) {
    return { primary: 'QUERY', secondary: [], confidence: 0.5 };
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [primary, primaryScore] = sorted[0];
  const secondary = sorted.slice(1, 3).map(([type]) => type);
  const total = sorted.reduce((s, [, v]) => s + v, 0);

  return {
    primary,
    secondary,
    confidence: Math.min(primaryScore / total + 0.3, 0.99),
    scores,
  };
}

// ─── Task Builder ─────────────────────────────────────────────────────────────

function buildTask(raw, sessionId = null) {
  const id         = crypto.randomBytes(8).toString('hex');
  const timestamp  = Date.now();
  const codeBlocks = extractCodeBlocks(raw);
  const urls       = extractURLs(raw);
  const filePaths  = extractFilePaths(raw);
  const language   = extractLanguage(raw, codeBlocks);
  const urgency    = detectUrgency(raw);
  const tone       = detectTone(raw);
  const intent     = classifyIntent(raw);

  return {
    id,
    sessionId:  sessionId || `session_${timestamp}`,
    timestamp,
    raw:        raw.trim(),
    type:       intent.primary,
    intent:     intent.primary,
    secondary:  intent.secondary,
    confidence: intent.confidence,
    language,
    urgency,
    tone,
    codeBlocks,
    urls,
    filePaths,
    wordCount:  raw.trim().split(/\s+/).length,
    charCount:  raw.length,
    hasCode:    codeBlocks.length > 0,
    hasURLs:    urls.length > 0,
    hasFiles:   filePaths.length > 0,
    meta: {
      intentScores:  intent.scores,
      secondaryIntent: intent.secondary,
    },
  };
}

// ─── Validation ────────────────────────────────────────────────────────────

function validateTask(task) {
  const errors = [];

  if (!task.raw || task.raw.length === 0) {
    errors.push('Empty input — nothing to process');
  }
  if (task.raw.length > 100_000) {
    errors.push('Input too large — consider chunking');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

function intake(rawInput, sessionId = null) {
  if (typeof rawInput !== 'string') {
    throw new TypeError(`intake() expects a string, got ${typeof rawInput}`);
  }

  const task       = buildTask(rawInput, sessionId);
  const validation = validateTask(task);

  if (!validation.valid) {
    return {
      task,
      valid: false,
      errors: validation.errors,
    };
  }

  return {
    task,
    valid: true,
    errors: [],
  };
}

module.exports = { intake, buildTask, classifyIntent, extractCodeBlocks, extractURLs };
