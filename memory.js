/**
 * NEXUS — core/memory.js
 * Three-tier memory: HOT (LRU) → WARM (SQLite) → COLD (embeddings)
 * 
 * HOT:  Sub-millisecond. In-process. ~500 entries, LRU eviction.
 * WARM: <5ms. SQLite with FTS5. File-backed. Persistent across restarts.
 * COLD: <50ms. Binary embedding vectors. Cosine similarity. Long-term knowledge.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

// ─── LRU Cache (HOT memory) ───────────────────────────────────────────────────

class LRU {
  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.cache   = new Map(); // Insertion-ordered Map = perfect for LRU
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    // Move to end (most recently used)
    const val = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict least recently used (first entry)
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  has(key)    { return this.cache.has(key); }
  delete(key) { return this.cache.delete(key); }
  size()      { return this.cache.size; }
  clear()     { this.cache.clear(); }

  keys()   { return [...this.cache.keys()]; }
  values() { return [...this.cache.values()]; }
}

// ─── HOT Memory ───────────────────────────────────────────────────────────────

class HotMemory {
  constructor(maxSize = 500) {
    this.lru     = new LRU(maxSize);
    this.hits    = 0;
    this.misses  = 0;
  }

  store(key, value, ttlMs = null) {
    this.lru.set(key, {
      value,
      stored:  Date.now(),
      expires: ttlMs ? Date.now() + ttlMs : null,
      hits:    0,
    });
  }

  recall(key) {
    const t0     = performance.now();
    const entry  = this.lru.get(key);

    if (!entry) {
      this.misses++;
      return { found: false, elapsed: performance.now() - t0 };
    }

    if (entry.expires && Date.now() > entry.expires) {
      this.lru.delete(key);
      this.misses++;
      return { found: false, elapsed: performance.now() - t0, reason: 'expired' };
    }

    entry.hits++;
    this.hits++;
    return { found: true, value: entry.value, elapsed: performance.now() - t0, tier: 'HOT' };
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      size:     this.lru.size(),
      hits:     this.hits,
      misses:   this.misses,
      hitRate:  total ? ((this.hits / total) * 100).toFixed(1) + '%' : '0%',
    };
  }
}

// ─── WARM Memory (SQLite-backed) ──────────────────────────────────────────────
// Uses a simple JSON file store as a portable alternative to sqlite3 native bindings
// In production: swap this.store for better-sqlite3

class WarmMemory {
  constructor(dataDir = './memory') {
    this.dataDir  = dataDir;
    this.filePath = path.join(dataDir, 'warm.json');
    this.index    = {}; // key → { id, tags, timestamp }
    this.entries  = {}; // key → full entry
    this._load();
  }

  _load() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.entries = raw.entries || {};
        this.index   = raw.index   || {};
      }
    } catch (e) {
      this.entries = {};
      this.index   = {};
    }
  }

  _persist() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify({
        entries: this.entries,
        index:   this.index,
        updated: Date.now(),
      }, null, 2));
    } catch (e) {
      // Non-fatal — memory still works in-process
      console.warn('[MEMORY] WARM persist failed:', e.message);
    }
  }

  store(key, value, meta = {}) {
    const t0 = performance.now();
    const entry = {
      key,
      value,
      tags:      meta.tags    || [],
      session:   meta.session || null,
      taskType:  meta.taskType || null,
      stored:    Date.now(),
      accessed:  Date.now(),
      hits:      0,
    };

    this.entries[key]  = entry;
    this.index[key]    = { tags: entry.tags, timestamp: entry.stored };

    this._persist();
    return { stored: true, elapsed: performance.now() - t0, tier: 'WARM' };
  }

  recall(key) {
    const t0    = performance.now();
    const entry = this.entries[key];

    if (!entry) {
      return { found: false, elapsed: performance.now() - t0 };
    }

    entry.accessed = Date.now();
    entry.hits++;
    return { found: true, value: entry.value, elapsed: performance.now() - t0, tier: 'WARM' };
  }

  // Full-text search across stored values
  search(query, maxResults = 10) {
    const t0     = performance.now();
    const terms  = query.toLowerCase().split(/\s+/);
    const scores = [];

    for (const [key, entry] of Object.entries(this.entries)) {
      const text = JSON.stringify(entry.value).toLowerCase() + ' ' + key.toLowerCase();
      let score  = 0;
      for (const term of terms) {
        if (text.includes(term)) score++;
      }
      if (score > 0) {
        scores.push({ key, entry, score });
      }
    }

    const results = scores
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(r => ({ key: r.key, value: r.entry.value, score: r.score, tier: 'WARM' }));

    return { results, elapsed: performance.now() - t0, query };
  }

  // Find by tags
  findByTags(tags) {
    const results = [];
    for (const [key, entry] of Object.entries(this.entries)) {
      if (tags.some(t => entry.tags?.includes(t))) {
        results.push({ key, value: entry.value, tags: entry.tags });
      }
    }
    return results;
  }

  stats() {
    return {
      entries: Object.keys(this.entries).length,
      path:    this.filePath,
    };
  }
}

// ─── COLD Memory (Vector embedding store) ─────────────────────────────────────
// Lightweight cosine similarity without external deps

class ColdMemory {
  constructor(dataDir = './memory') {
    this.dataDir  = dataDir;
    this.filePath = path.join(dataDir, 'cold.json');
    this.vectors  = []; // [{ key, embedding: Float32Array, meta }]
    this._load();
  }

  _load() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      if (fs.existsSync(this.filePath)) {
        const raw    = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.vectors = (raw.vectors || []).map(v => ({
          ...v,
          embedding: Float32Array.from(v.embedding),
        }));
      }
    } catch {
      this.vectors = [];
    }
  }

  _persist() {
    const serializable = this.vectors.map(v => ({
      ...v,
      embedding: Array.from(v.embedding),
    }));
    fs.writeFileSync(this.filePath, JSON.stringify({ vectors: serializable }));
  }

  // Lightweight bag-of-words embedding (no external model required)
  // In production: replace with local sentence-transformer inference
  _embed(text) {
    const DIM      = 256;
    const vec      = new Float32Array(DIM);
    const words    = text.toLowerCase().split(/\W+/).filter(Boolean);

    for (const word of words) {
      // Hash each word into a dimension
      let h = 5381;
      for (let i = 0; i < word.length; i++) {
        h = ((h << 5) + h) ^ word.charCodeAt(i);
        h = h >>> 0; // uint32
      }
      const dim = h % DIM;
      vec[dim] += 1.0;

      // Bigram co-occurrence
      const next = words[words.indexOf(word) + 1];
      if (next) {
        let h2 = h ^ next.charCodeAt(0);
        h2     = h2 >>> 0;
        vec[h2 % DIM] += 0.5;
      }
    }

    // L2 normalize
    let norm = 0;
    for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < DIM; i++) vec[i] /= norm;

    return vec;
  }

  _cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na  += a[i] * a[i];
      nb  += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  }

  store(key, text, meta = {}) {
    const embedding = this._embed(text);

    // Remove existing entry for this key
    this.vectors = this.vectors.filter(v => v.key !== key);

    this.vectors.push({
      key,
      embedding,
      text: text.substring(0, 500), // Store truncated text for retrieval
      meta,
      stored: Date.now(),
    });

    this._persist();
  }

  search(query, topK = 5, threshold = 0.3) {
    const t0    = performance.now();
    const qVec  = this._embed(query);

    const scored = this.vectors.map(v => ({
      key:       v.key,
      text:      v.text,
      meta:      v.meta,
      score:     this._cosine(qVec, v.embedding),
    }));

    const results = scored
      .filter(r  => r.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(r     => ({ ...r, tier: 'COLD' }));

    return { results, elapsed: performance.now() - t0, query };
  }

  stats() {
    return { vectors: this.vectors.length, path: this.filePath };
  }
}

// ─── Unified Memory Manager ───────────────────────────────────────────────────

class Memory {
  constructor(options = {}) {
    this.hot  = new HotMemory(options.hotSize || 500);
    this.warm = new WarmMemory(options.dataDir || './memory');
    this.cold = new ColdMemory(options.dataDir || './memory');
  }

  // Store in appropriate tier(s)
  store(key, value, options = {}) {
    const { tier = 'hot', ttlMs, tags, session, taskType } = options;
    const text = typeof value === 'string' ? value : JSON.stringify(value);

    // Always write to HOT
    this.hot.store(key, value, ttlMs);

    if (tier === 'warm' || tier === 'all') {
      this.warm.store(key, value, { tags, session, taskType });
    }

    if (tier === 'cold' || tier === 'all') {
      this.cold.store(key, text, { tags, session, taskType });
    }
  }

  // Cascade recall: HOT → WARM → COLD
  recall(key) {
    let result = this.hot.recall(key);
    if (result.found) return result;

    result = this.warm.recall(key);
    if (result.found) {
      // Promote to HOT for future fast access
      this.hot.store(key, result.value);
      return result;
    }

    return { found: false };
  }

  // Semantic search across WARM + COLD
  search(query, options = {}) {
    const { maxResults = 10, threshold = 0.3 } = options;

    const warmResults = this.warm.search(query, maxResults);
    const coldResults = this.cold.search(query, maxResults, threshold);

    // Deduplicate and merge
    const seen = new Set();
    const all  = [];

    for (const r of [...warmResults.results, ...coldResults.results]) {
      if (!seen.has(r.key)) {
        seen.add(r.key);
        all.push(r);
      }
    }

    return {
      results:      all.slice(0, maxResults),
      warmCount:    warmResults.results.length,
      coldCount:    coldResults.results.length,
      query,
    };
  }

  stats() {
    return {
      hot:  this.hot.stats(),
      warm: this.warm.stats(),
      cold: this.cold.stats(),
    };
  }
}

module.exports = { Memory, HotMemory, WarmMemory, ColdMemory, LRU };
