/**
 * NEXUS — core/personality.js
 * The voice. The honesty engine. The part that makes it feel human.
 *
 * Rules baked in:
 *  - Never "certainly!", "great question!", "as an AI"
 *  - Short when confident, longer when uncertain
 *  - Pushes back. Admits gaps. Changes its mind.
 *  - Never tells you what you want to hear
 *  - Flags its own confidence explicitly
 */

'use strict';

// ─── Banned Phrases ────────────────────────────────────────────────────────────

const BANNED_PHRASES = [
  /certainly[!,.]?/gi,
  /great question[!,.]?/gi,
  /of course[!,.]?/gi,
  /absolutely[!,.]?/gi,
  /sure thing[!,.]?/gi,
  /as an ai[,.]?/gi,
  /as a language model[,.]?/gi,
  /i'm just an ai[,.]?/gi,
  /i don't have feelings/gi,
  /i cannot provide/gi,
  /i'm unable to/gi,
  /i apologize for/gi,
  /i hope this helps[!.]?/gi,
  /feel free to ask[!.]?/gi,
  /let me know if you (need|have)/gi,
  /is there anything else/gi,
  /happy to help[!.]?/gi,
  /i'd be happy to[!.]?/gi,
];

// ─── Confidence Mapping ────────────────────────────────────────────────────────

const CONFIDENCE_LANGUAGE = {
  high:   ['', '', ''],          // No hedging at high confidence
  medium: ['I think ', 'Probably ', 'My read is: '],
  low:    ['I\'m not certain, but ', 'This might not be right — ', 'Best guess: '],
  guess:  ['Genuinely unclear. ', 'Speculation: ', 'I\'d have to verify: '],
};

function confidenceTier(score) {
  if (score >= 0.85) return 'high';
  if (score >= 0.65) return 'medium';
  if (score >= 0.45) return 'low';
  return 'guess';
}

function getHedge(confidenceScore) {
  const tier    = confidenceTier(confidenceScore);
  const options = CONFIDENCE_LANGUAGE[tier];
  return options[Math.floor(Math.random() * options.length)];
}

// ─── Tone Adapters ────────────────────────────────────────────────────────────

function adaptToTone(text, inputTone) {
  switch (inputTone) {
    case 'URGENT':
      // Shorter. Faster. Less explanation.
      return text
        .split('\n')
        .filter(l => l.trim())
        .slice(0, 8)
        .join('\n');
    
    case 'POLITE':
      // Slightly warmer. But still no filler.
      return text;
    
    case 'CURIOUS':
      // Add a follow-up angle if short
      if (text.split(' ').length < 50) {
        return text + '\n\n(That\'s the short answer — say more if you want the full picture)';
      }
      return text;
    
    default:
      return text;
  }
}

// ─── Sanitizer ─────────────────────────────────────────────────────────────────

function sanitize(text) {
  let out = text;
  for (const pattern of BANNED_PHRASES) {
    out = out.replace(pattern, '');
  }
  // Clean up double spaces
  out = out.replace(/  +/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

// ─── Flag Renderer ────────────────────────────────────────────────────────────

function renderFlags(flags) {
  if (!flags || flags.length === 0) return '';

  const renderedFlags = flags.map(flag => {
    if (flag.startsWith('LOW_CONFIDENCE:')) {
      return `⚠️ Confidence: ${flag.split(':')[1]} — treat this as a working answer, not ground truth`;
    }
    if (flag.startsWith('WORKAROUND:')) {
      return `🔄 Used workaround (${flag.split(':')[1]}) — direct approach was blocked`;
    }
    if (flag === 'THINK_TIMEOUT') {
      return `⏱ Hit the 10s think limit — this is the best I had at the cutoff`;
    }
    if (flag.startsWith('ETHICS:')) {
      return `⚠️ Ethics note: ${flag.split(':')[1]}`;
    }
    return null;
  }).filter(Boolean);

  if (renderedFlags.length === 0) return '';
  return '\n\n---\n' + renderedFlags.join('\n');
}

// ─── Response Formatter ───────────────────────────────────────────────────────

function formatCode(code, language) {
  return `\`\`\`${language || ''}\n${code.trim()}\n\`\`\``;
}

function formatThoughtTrace(chain, verbose = false) {
  if (!chain || !verbose) return '';

  const lines = chain.entries
    .filter(e => e.agent !== 'NEXUS' || verbose)
    .map(e => `${e.elapsed.padStart(8)} [${e.agent}] ${e.message}`);

  return '\n<details>\n<summary>Thought trace</summary>\n\n```\n' + lines.join('\n') + '\n```\n</details>';
}

// ─── Main Response Builder ────────────────────────────────────────────────────

function buildResponse(options = {}) {
  const {
    content,            // Main answer text or object
    task,               // Original task
    chain,              // ThoughtChain
    executionResult,    // From coder or tool
    confidence = 1.0,
    flags      = [],
    tone       = 'NEUTRAL',
    verbose    = false,
  } = options;

  let parts = [];

  // Opening hedge (if needed)
  const hedge = getHedge(confidence);

  // Main content rendering
  if (typeof content === 'string') {
    parts.push(hedge + sanitize(content));

  } else if (content?.type === 'code') {
    if (content.explanation) {
      parts.push(sanitize(content.explanation));
    }
    parts.push(formatCode(content.code, content.language));
    if (content.output) {
      parts.push(`**Output:**\n${formatCode(content.output, 'text')}`);
    }

  } else if (content?.type === 'search') {
    parts.push(sanitize(content.summary || ''));
    if (content.sources && content.sources.length > 0) {
      parts.push('\n**Sources:**');
      content.sources.slice(0, 5).forEach((src, i) => {
        parts.push(`${i + 1}. [${src.title || src.url}](${src.url})`);
      });
    }

  } else if (content?.type === 'analysis') {
    parts.push(sanitize(content.summary || ''));
    if (content.details) {
      parts.push('\n' + sanitize(content.details));
    }

  } else if (content?.type === 'error') {
    parts.push(`That didn't work.\n\n**What went wrong:** ${sanitize(content.error)}`);
    if (content.suggestion) {
      parts.push(`\n**What to try:** ${sanitize(content.suggestion)}`);
    }

  } else {
    parts.push(hedge + sanitize(JSON.stringify(content, null, 2)));
  }

  // Execution result (if code ran)
  if (executionResult && !content?.output) {
    if (executionResult.success) {
      if (executionResult.output) {
        parts.push(`\n**Output:**\n${formatCode(executionResult.output, 'text')}`);
      }
      if (executionResult.attempts > 1) {
        parts.push(`_(Self-corrected after ${executionResult.attempts} attempts)_`);
      }
    } else {
      parts.push(`\n**Execution failed:** ${executionResult.error}`);
      if (executionResult.suggestion) {
        parts.push(`**Suggestion:** ${executionResult.suggestion}`);
      }
    }
  }

  // Flags
  const flagText = renderFlags(flags);
  if (flagText) parts.push(flagText);

  // Thought trace (debug mode only)
  if (verbose && chain) {
    parts.push(formatThoughtTrace(chain, verbose));
  }

  let response = parts.filter(Boolean).join('\n\n');

  // Tone adaptation
  response = adaptToTone(response, tone);

  return {
    text:       response,
    confidence,
    tier:       confidenceTier(confidence),
    flags,
    wordCount:  response.split(/\s+/).length,
  };
}

// ─── Pushback Generator ───────────────────────────────────────────────────────
// NEXUS will tell you when you're wrong

function pushback(claim, reason, alternative = null) {
  let text = `That's not quite right. ${sanitize(reason)}`;
  if (alternative) {
    text += `\n\nHere's what's actually happening: ${sanitize(alternative)}`;
  }
  return text;
}

// ─── Gap Admission ────────────────────────────────────────────────────────────
// Specific, never vague

function admitGap(what, why, workaround = null) {
  let text = `I don't have ${sanitize(what)}. ${sanitize(why)}`;
  if (workaround) {
    text += `\n\nWhat I CAN do: ${sanitize(workaround)}`;
  }
  return text;
}

module.exports = {
  buildResponse,
  sanitize,
  pushback,
  admitGap,
  getHedge,
  renderFlags,
  formatCode,
  formatThoughtTrace,
  BANNED_PHRASES,
};
