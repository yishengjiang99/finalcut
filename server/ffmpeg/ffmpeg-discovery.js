// Discovers FFmpeg capabilities (filters, codecs, encoders, decoders, formats) from the CLI and caches them.
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runProcess, FFMPEG_BIN } from './ffmpeg-executor.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CACHE_PATH = path.join(DIR, 'ffmpeg-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_HELP_CHARS = 6000;
const SAFE_NAME = /^[A-Za-z0-9_]+$/;

const SOURCES = {
  filters: ['-hide_banner', '-filters'],
  codecs: ['-hide_banner', '-codecs'],
  encoders: ['-hide_banner', '-encoders'],
  decoders: ['-hide_banner', '-decoders'],
  formats: ['-hide_banner', '-formats'],
};

/** " T.. scale  V->V  Scale the input video" → { name, flags, io, description }
 *  (ffmpeg ≤7 uses 3-char flags "TSC"; ffmpeg 8+ uses 2-char flags "TS".) */
export function parseFilters(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s([T.][S.](?:[C.])?)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (m && m[2] !== '=') out.push({ name: m[2], flags: m[1], io: m[3], description: m[4].trim() });
  }
  return out;
}

/** Codec / encoder / decoder / format lists share "<flags> <name> <description>" layout. */
export function parseFlagged(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s([A-Z.]{6}|[A-Z. ]{2,3})\s+(\S+)\s+(.*)$/);
    if (m && !/^=+$/.test(m[2])) out.push({ name: m[2], flags: m[1].trim(), description: m[3].trim() });
  }
  return out;
}

const PARSERS = { filters: parseFilters, codecs: parseFlagged, encoders: parseFlagged, decoders: parseFlagged, formats: parseFlagged };

function matching(list, query, limit) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list.slice(0, limit);
  const scored = [];
  for (const item of list) {
    const name = item.name.toLowerCase();
    const hay = `${name} ${item.description.toLowerCase()}`;
    // Any word may match; items matching more words (and by name) rank first.
    const score = words.reduce((s, w) => s + (name === w ? 3 : name.includes(w) ? 2 : hay.includes(w) ? 1 : 0), 0);
    if (score > 0) scored.push({ item, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.item);
}

export class FfmpegDiscovery {
  constructor({ run = runProcess, bin = FFMPEG_BIN, cachePath = DEFAULT_CACHE_PATH, ttlMs = CACHE_TTL_MS } = {}) {
    this.run = run;
    this.bin = bin;
    this.cachePath = cachePath;
    this.ttlMs = ttlMs;
    this.data = null;
    this.loading = null;
    this.helpCache = new Map();
  }

  async #readDisk() {
    if (!this.cachePath) return null;
    try {
      const parsed = JSON.parse(await fs.readFile(this.cachePath, 'utf8'));
      if (parsed && Date.now() - parsed.discoveredAt < this.ttlMs && parsed.filters) return parsed;
    } catch { /* no usable cache */ }
    return null;
  }

  async #discover() {
    const data = { discoveredAt: Date.now() };
    for (const [key, args] of Object.entries(SOURCES)) {
      const res = await this.run(this.bin, args, { timeoutMs: 30000 });
      if (res.code !== 0 && !res.stdout) throw new Error(`ffmpeg ${args.join(' ')} failed${res.spawnError ? ` (${res.spawnError})` : ''}`);
      data[key] = PARSERS[key](res.stdout);
    }
    if (this.cachePath) await fs.writeFile(this.cachePath, JSON.stringify(data)).catch(() => {});
    return data;
  }

  /** Load capabilities once (memory → disk → CLI). */
  async load({ force = false } = {}) {
    if (this.data && !force) return this.data;
    if (!this.loading || force) {
      this.loading = (async () => {
        this.data = (!force && await this.#readDisk()) || await this.#discover();
        return this.data;
      })().finally(() => { this.loading = null; });
    }
    return this.loading;
  }

  async #list(key) { return (await this.load())[key]; }
  async getFilters() { return this.#list('filters'); }
  async getCodecs() { return this.#list('codecs'); }
  async getEncoders() { return this.#list('encoders'); }
  async getDecoders() { return this.#list('decoders'); }
  async getFormats() { return this.#list('formats'); }

  async getFiltersMatching(query, limit = 20) { return matching(await this.getFilters(), query, limit); }
  async getCodecsMatching(query, limit = 20) { return matching(await this.getCodecs(), query, limit); }
  async getEncodersMatching(query, limit = 20) { return matching(await this.getEncoders(), query, limit); }
  async getDecodersMatching(query, limit = 20) { return matching(await this.getDecoders(), query, limit); }

  async hasFilter(name) { return (await this.getFilters()).some(f => f.name === name); }
  async hasEncoder(name) { return (await this.getEncoders()).some(e => e.name === name); }

  /** Closest names (substring / shared prefix) for "did you mean" suggestions. */
  async suggestFilters(name, limit = 5) {
    const n = String(name || '').toLowerCase();
    const filters = await this.getFilters();
    const scored = filters.map(f => {
      const fn = f.name.toLowerCase();
      let s = 0;
      if (fn.includes(n) || n.includes(fn)) s = 3;
      else if (n.length >= 3 && fn.startsWith(n.slice(0, 3))) s = 2;
      else if (f.description.toLowerCase().includes(n)) s = 1;
      return { name: f.name, s };
    }).filter(x => x.s > 0);
    return scored.sort((a, b) => b.s - a.s).slice(0, limit).map(x => x.name);
  }

  /** Help text for a specific filter/encoder/decoder (`ffmpeg -h filter=NAME`), truncated. */
  async getHelp(kind, name) {
    if (!['filter', 'encoder', 'decoder', 'muxer', 'demuxer'].includes(kind) || !SAFE_NAME.test(String(name))) {
      throw new Error('Invalid help topic');
    }
    const key = `${kind}=${name}`;
    if (!this.helpCache.has(key)) {
      const res = await this.run(this.bin, ['-hide_banner', '-h', key], { timeoutMs: 15000 });
      this.helpCache.set(key, (res.stdout || res.stderr).slice(0, MAX_HELP_CHARS));
    }
    return this.helpCache.get(key);
  }
}

export const discovery = new FfmpegDiscovery();
