const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');

// Ignore empty / 0 / invalid PORT values so the documented port is kept.
const ENV_PORT = Number.parseInt(process.env.PORT, 10);
const PORT = Number.isFinite(ENV_PORT) && ENV_PORT > 0 && ENV_PORT < 65536 ? ENV_PORT : 3000;
const DATA_DIR = path.join(__dirname, 'data');
const TTS_CACHE_DIR = path.join(DATA_DIR, 'tts-cache');
const STATE_FILE = path.join(DATA_DIR, 'game-state.json');

fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });

const SHOP_NAME = 'SUNNY SIDE SIPS';

// ============================================================================
// 1. DRINK MENU (assets live in public/assets/drinks)
// ============================================================================
const DRINK_MENU = [
  {
    id: 'lemonade',
    name: 'Fresh Lemonade',
    price: 5,
    image: '/assets/drinks/Lemonade.jpg',
    color: '#ffd34d'
  },
  {
    id: 'iced-coffee',
    name: 'Iced Coffee',
    price: 6,
    image: '/assets/drinks/Iced_Coffee.jpg',
    color: '#a9724a'
  },
  {
    id: 'orange-soda',
    name: 'Orange Soda',
    price: 4,
    image: '/assets/drinks/Orange_Soda.jpg',
    color: '#ff9433'
  },
  {
    id: 'smoothie',
    name: 'Berry Smoothie',
    price: 7,
    image: '/assets/drinks/Smoothie.jpg',
    color: '#e46a9b'
  },
  {
    id: 'slushie',
    name: 'Blue Slushie',
    price: 5,
    image: '/assets/drinks/Slushie.jpg',
    color: '#4bb8e8'
  },
  {
    id: 'cola',
    name: 'Classic Cola',
    price: 3,
    image: '/assets/drinks/coca.jpg',
    color: '#c0392b'
  }
];

// 1b. COIN → DRINK MENU (the gift's coin value selects the drink)
// Gift icons are decorative menu art only — gift identity never chooses a drink.
// ============================================================================
const GIFT_ICONS = {
  rose: '/assets/gift_icon/rose.webp',
  rosa: '/assets/gift_icon/rosa10.webp',
  prayercandle: '/assets/gift_icon/PrayerCandle.webp',
  bouquet20: '/assets/gift_icon/Bouquet20.webp',
  flowergarland15: '/assets/gift_icon/flowergarland15.webp',
  grandceremony: '/assets/gift_icon/grandCeremony.webp'
};

const COIN_MENU = [
  { coins: 1, drinkId: 'cola', icon: GIFT_ICONS.rose },
  { coins: 5, drinkId: 'smoothie', icon: GIFT_ICONS.rosa },
  { coins: 10, drinkId: 'slushie', icon: GIFT_ICONS.prayercandle },
  { coins: 15, drinkId: 'orange-soda', icon: GIFT_ICONS.bouquet20 },
  { coins: 20, drinkId: 'iced-coffee', icon: GIFT_ICONS.flowergarland15 },
  { coins: 25, drinkId: 'lemonade', icon: GIFT_ICONS.grandceremony }
];

// Exact match only: an unsupported coin value never triggers an order.
function coinTier(coins) {
  const value = Math.round(Number(coins) || 0);
  return COIN_MENU.find((tier) => tier.coins === value) || null;
}

function coinMenuEntries() {
  return COIN_MENU.map((tier) => {
    const drink = DRINK_MENU.find((item) => item.id === tier.drinkId) || {};
    return {
      coins: tier.coins,
      giftIcon: tier.icon,
      drinkId: tier.drinkId,
      drinkName: drink.name,
      drinkImage: drink.image,
      color: drink.color
    };
  });
}

// ============================================================================
// 2. MYSTERY SIP CARDS (legacy temple.drawFortune method)
// ============================================================================
const MYSTERY_DECK = [
  {
    id: 'blue-ribbon',
    rank: 'HOUSE FAVORITE',
    title: 'Blue Ribbon Lemonade',
    poem: 'Sun on the counter, ice in the cup,\nOne long sip and the mood goes up.',
    meaning: 'A classic cure for a hot afternoon. Sweet tip, happy customer, zero complaints.',
    ttsText: 'The mystery sip is Blue Ribbon Lemonade. Sun on the counter, ice in the cup.'
  },
  {
    id: 'double-shot',
    rank: 'EXTRA BOOST',
    title: 'Double Shot Iced Coffee',
    poem: 'Cold brew over ice, a double pour,\nOne sip and you are ready for more.',
    meaning: 'Big energy for a big shift. Perfect for the customer who is in a hurry.',
    ttsText: 'The mystery sip is a Double Shot Iced Coffee. Cold brew over ice, ready for more.'
  },
  {
    id: 'sunset-orange',
    rank: 'CROWD PLEASER',
    title: 'Sunset Orange Soda',
    poem: 'Fizz in the glass, a sunset glow,\nEvery table wants one, you know.',
    meaning: 'A fizzy crowd pleaser. Expect a second round from the same table.',
    ttsText: 'The mystery sip is Sunset Orange Soda. A fizzy crowd pleaser with a sunset glow.'
  },
  {
    id: 'berry-cloud',
    rank: 'SWEET PICK',
    title: 'Berry Cloud Smoothie',
    poem: 'Berries spun light like a summer cloud,\nSipped in the shade when the street gets loud.',
    meaning: 'The sweet pick of the day. Kids and grandparents order it alike.',
    ttsText: 'The mystery sip is the Berry Cloud Smoothie. Light, sweet and spun thick.'
  },
  {
    id: 'neon-slush',
    rank: 'BRAIN FREEZE',
    title: 'Neon Blue Slushie',
    poem: 'Electric blue in a paper cup,\nBrain freeze quick but you drink it up.',
    meaning: 'A loud, bright favorite. Guaranteed photo on the way out.',
    ttsText: 'The mystery sip is the Neon Blue Slushie. Electric blue, ice cold and bright.'
  },
  {
    id: 'old-fashioned',
    rank: 'ALL-AMERICAN',
    title: 'Classic Cola Float',
    poem: 'Dark cola over crushed ice,\nA small-town classic, always nice.',
    meaning: 'No surprises, just a steady seller the whole neighborhood trusts.',
    ttsText: 'The mystery sip is the Classic Cola Float. A small town classic, always nice.'
  }
];

// ============================================================================
// 3. PIPER TTS WORKER MANAGER (local ONNX voices in config/piper, no downloads)
// ============================================================================
function normalizeGender(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (['female', 'f', 'woman', 'girl', 'nữ', 'nu'].includes(raw)) return 'female';
  if (['male', 'm', 'man', 'boy', 'nam'].includes(raw)) return 'male';
  return null;
}

function prettyVoiceName(stem) {
  const cleaned = String(stem || '')
    .replace(/^piper[-_]/i, '')
    .replace(/^(en|vi)[-_][A-Za-z]{2}[-_]/i, '')
    .replace(/^(en|vi)[-_]/i, '')
    .replace(/\b(medium|low|high|x_low|x-low)\b/gi, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return String(stem || 'Voice');
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (/^[A-Z0-9]+$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

class PiperTTSManager {
  constructor() {
    this.proc = null;
    this.ready = false;
    this.status = 'starting';
    this.error = null;
    this.version = null;
    this.exe = null;
    this.exeKind = null;
    this.workerVoices = [];
    this.modelsRoot = path.join(__dirname, 'config', 'piper');
    this.pending = new Map();
    this.inflight = new Map();
    this.reqCounter = 0;
    this.buffer = '';
    this.lastScanAt = null;
    this.cacheVoices = this.scanVoices();
    this.lastScanAt = Date.now();
    this.exe = this.resolvePiperExe();
    this.startWorker();
    this.watchModels();
    console.log(
      `[Piper TTS] Discovered ${this.listVoices().length} valid local voices in ${path.relative(__dirname, this.modelsRoot)}`
    );
  }

  // Optional display/gender metadata shipped next to the models.
  readVoiceMetadata(dir) {
    const map = new Map();
    try {
      const entries = JSON.parse(fs.readFileSync(path.join(dir, 'voices.json'), 'utf8'));
      for (const entry of Array.isArray(entries) ? entries : []) {
        const audioPath = String(entry.audio_path || '').replace(/\\/g, '/');
        const stem = path.basename(audioPath).replace(/\.onnx$/i, '').toLowerCase();
        if (!stem) continue;
        map.set(stem, {
          name: String(entry.name || '').trim(),
          gender: normalizeGender(entry.gender),
          description: String(entry.description || '').trim()
        });
      }
    } catch (_) {
      /* voices.json is optional; discovery must still work without it. */
    }
    return map;
  }

  // Local models only: config/piper/<language>/<name>.onnx + <name>.onnx.json
  scanVoices() {
    const found = [];
    const seen = new Set();
    // Vietnamese models live in config/piper/vn and are exposed as language "vi".
    for (const folder of ['en', 'vi', 'vn']) {
      const dir = path.join(this.modelsRoot, folder);
      const language = folder === 'vn' ? 'vi' : folder;
      if (!fs.existsSync(dir)) continue;
      const metadata = this.readVoiceMetadata(dir);
      for (const file of fs.readdirSync(dir).sort()) {
        if (!/\.onnx$/i.test(file)) continue;
        const id = file.replace(/\.onnx$/i, '');
        if (seen.has(id)) continue;
        seen.add(id);
        const modelPath = path.join(dir, file);
        const configPath = `${modelPath}.json`;
        const meta = metadata.get(id.toLowerCase()) || {};
        const warnings = [];
        let config = null;
        let problem = null;
        if (!fs.existsSync(configPath)) {
          problem = 'missing .onnx.json config';
        } else {
          try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          } catch (err) {
            problem = `invalid .onnx.json (${err.message})`;
          }
        }
        let bytes = 0;
        try {
          bytes = fs.statSync(modelPath).size;
        } catch (_) {
          bytes = 0;
        }
        if (!problem && bytes < 1024) problem = 'model file is empty or truncated';
        if (!meta.gender) warnings.push('gender metadata missing');
        found.push({
          id,
          language,
          name: meta.name && !/[_-]/.test(meta.name) ? meta.name : prettyVoiceName(meta.name || id),
          gender: meta.gender || null,
          description: meta.description || '',
          sampleRate: Number(config && config.audio && config.audio.sample_rate) || 22050,
          espeak: (config && config.espeak && config.espeak.voice) || language,
          path: path.relative(__dirname, modelPath).replace(/\\/g, '/'),
          configPath: path.relative(__dirname, configPath).replace(/\\/g, '/'),
          bytes,
          valid: !problem,
          problem,
          warnings
        });
      }
    }
    return found.sort((a, b) =>
      a.language === b.language ? a.name.localeCompare(b.name) : a.language.localeCompare(b.language)
    );
  }

  // The worker rescans config/piper on every request; keep its findings in sync.
  mergeWorkerVoices(workerVoices = []) {
    const byId = new Map(this.cacheVoices.map((voice) => [voice.id, voice]));
    for (const entry of Array.isArray(workerVoices) ? workerVoices : []) {
      if (!entry || !entry.id) continue;
      const existing = byId.get(entry.id);
      if (existing) {
        existing.sampleRate = Number(entry.sampleRate) || existing.sampleRate;
        existing.espeak = entry.espeak || existing.espeak;
        continue;
      }
      byId.set(entry.id, {
        id: entry.id,
        language: entry.language === 'vi' || entry.language === 'vn' ? 'vi' : entry.language || 'en',
        name: entry.name || prettyVoiceName(entry.id),
        gender: null,
        description: '',
        sampleRate: Number(entry.sampleRate) || 22050,
        espeak: entry.espeak || entry.language || 'en',
        path: '',
        configPath: '',
        bytes: 0,
        valid: true,
        problem: null,
        warnings: ['discovered by the TTS worker only']
      });
    }
    this.cacheVoices = [...byId.values()];
  }

  listVoices() {
    return this.cacheVoices.filter((voice) => voice.valid !== false);
  }

  voicePayload(voice) {
    return {
      id: voice.id,
      name: voice.name,
      friendlyName: `${voice.name} · ${voice.language === 'vi' ? 'Vietnamese' : 'English'}`,
      language: voice.language,
      gender: voice.gender || null,
      description: voice.description || '',
      path: voice.path || '',
      configPath: voice.configPath || '',
      sampleRate: voice.sampleRate || 22050,
      valid: voice.valid !== false,
      problem: voice.problem || null,
      warnings: Array.isArray(voice.warnings) ? voice.warnings : []
    };
  }

  // Grouped catalog used by the admin panel and the announcer.
  getCatalog() {
    const voices = this.cacheVoices.map((voice) => this.voicePayload(voice));
    const en = voices.filter((voice) => voice.language === 'en');
    const vi = voices.filter((voice) => voice.language === 'vi');
    return {
      en,
      vi,
      vn: vi,
      total: voices.length,
      valid: voices.filter((voice) => voice.valid).length,
      languages: ['en', 'vi'],
      modelsRoot: path.relative(__dirname, this.modelsRoot).replace(/\\/g, '/'),
      lastScanAt: this.lastScanAt || null,
      skipped: voices
        .filter((voice) => !voice.valid)
        .map((voice) => ({ id: voice.id, path: voice.path, problem: voice.problem }))
    };
  }

  requestWorkerVoices() {
    if (!this.proc || !this.ready) return;
    try {
      this.proc.stdin.write(JSON.stringify({ cmd: 'voices' }) + '\n');
    } catch (_) {}
  }

  refreshVoices(trigger = 'manual') {
    const signature = (voices) =>
      voices
        .map((voice) => `${voice.id}:${voice.valid === false ? 0 : 1}`)
        .sort()
        .join('|');
    const before = signature(this.cacheVoices);
    this.cacheVoices = this.scanVoices();
    this.lastScanAt = Date.now();
    const changed = signature(this.cacheVoices) !== before;
    this.requestWorkerVoices();
    if (changed || trigger !== 'watch') {
      const catalog = this.getCatalog();
      console.log(
        `[Piper TTS] Voice catalog refreshed (${trigger}) · ${catalog.valid}/${catalog.total} playable · en:${catalog.en.length} vi:${catalog.vi.length}`
      );
      broadcastNotification('tts.status', this.getStatus());
      return catalog;
    }
    return this.getCatalog();
  }

  // Adding a model while the server runs is noticed without a restart.
  watchModels() {
    if (this.watchers) return;
    const dirs = ['en', 'vi', 'vn']
      .map((folder) => path.join(this.modelsRoot, folder))
      .filter((dir) => fs.existsSync(dir));
    if (!dirs.length) return;
    let timer = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          this.refreshVoices('watch');
        } catch (err) {
          console.warn('[Piper TTS] Voice rescan failed:', err.message);
        }
      }, 800);
      if (timer.unref) timer.unref();
    };
    this.watchers = dirs
      .map((dir) => {
        try {
          return fs.watch(dir, schedule);
        } catch (err) {
          console.warn(`[Piper TTS] Cannot watch ${dir}:`, err.message);
          return null;
        }
      })
      .filter(Boolean);
  }

  voicesFor(language) {
    const lang = String(language || 'en').toLowerCase() === 'vi' ? 'vi' : 'en';
    const all = this.listVoices();
    return all.filter((voice) => voice.language === lang);
  }

  defaultVoice(language) {
    const list = this.voicesFor(language);
    return list.length ? list[0].id : null;
  }

  resolvePythonBin() {
    const winVenv = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
    if (fs.existsSync(winVenv)) return winVenv;
    const venvPy = path.join(__dirname, '.venv', 'bin', 'python');
    if (fs.existsSync(venvPy)) return venvPy;
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  // Detect a Piper executable: env var, config/piper, project root, PATH, or "python -m piper".
  resolvePiperExe() {
    const candidates = [
      process.env.PIPER_BIN,
      path.join(this.modelsRoot, 'piper.exe'),
      path.join(this.modelsRoot, 'piper'),
      path.join(this.modelsRoot, 'bin', 'piper.exe'),
      path.join(this.modelsRoot, 'bin', 'piper'),
      path.join(__dirname, 'piper', 'piper.exe'),
      path.join(__dirname, 'piper.exe')
    ].filter(Boolean);

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          this.exeKind = 'piper';
          return candidate;
        }
      } catch (_) {}
    }

    try {
      const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['piper'], { encoding: 'utf8' });
      const firstLine = String(probe.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (probe.status === 0 && firstLine) {
        this.exeKind = 'piper';
        return firstLine;
      }
    } catch (_) {}

    const pyBin = this.resolvePythonBin();
    try {
      const probe = spawnSync(pyBin, ['-m', 'piper', '--help'], { encoding: 'utf8', timeout: 15000 });
      const text = `${probe.stdout || ''}${probe.stderr || ''}`;
      if (/--model/i.test(text)) {
        this.exeKind = 'python-module';
        return `${pyBin} -m piper`;
      }
    } catch (_) {}

    this.exeKind = null;
    return null;
  }

  startWorker() {
    const pyBin = this.resolvePythonBin();
    const scriptPath = path.join(__dirname, 'piper_worker.py');
    if (!fs.existsSync(scriptPath)) {
      this.status = 'unavailable';
      this.error = 'piper_worker.py is missing';
      console.warn('[Piper TTS] Worker script missing:', scriptPath);
      return;
    }

    console.log(`[Piper TTS] Starting worker with ${pyBin} ...`);
    this.status = 'loading';
    try {
      this.proc = spawn(pyBin, [scriptPath], {
        cwd: __dirname,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PIPER_EXE: this.exe || '',
          PIPER_EXE_KIND: this.exeKind || ''
        }
      });
    } catch (err) {
      this.status = 'unavailable';
      this.error = err.message;
      console.warn('[Piper TTS] Worker could not start:', err.message);
      return;
    }

    // A missing Python / Piper install must never take the shop server down.
    this.proc.on('error', (err) => {
      this.ready = false;
      this.status = 'unavailable';
      this.error = err.message;
      console.warn('[Piper TTS] Worker unavailable:', err.message);
    });

    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        this.handleWorkerLine(line.trim());
      }
    });

    this.proc.stderr.on('data', (chunk) => {
      const msg = chunk.toString('utf8').trim();
      if (msg) console.log(`[Piper TTS stderr] ${msg}`);
    });

    this.proc.on('exit', (code) => {
      console.warn(`[Piper TTS] Worker exited with code ${code}`);
      this.ready = false;
      this.status = 'stopped';
      for (const [, item] of this.pending) {
        clearTimeout(item.timer);
        item.resolve({ ok: false, error: 'Piper worker exited' });
      }
      this.pending.clear();
    });
  }

  handleWorkerLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      console.log('[Piper TTS stdout]', line);
      return;
    }

    if (msg.type === 'ready') {
      this.ready = true;
      this.status = 'ready';
      this.version = msg.version || null;
      this.workerVoices = Array.isArray(msg.voices) ? msg.voices : [];
      this.mergeWorkerVoices(this.workerVoices);
      if (msg.exe) this.exe = msg.exe;
      if (msg.exeKind) this.exeKind = msg.exeKind;
      const languages = this.listVoices().reduce((acc, voice) => {
        acc[voice.language] = (acc[voice.language] || 0) + 1;
        return acc;
      }, {});
      console.log(
        `[Piper TTS] Ready · ${this.listVoices().length} local voices (${Object.entries(languages)
          .map(([lang, count]) => `${lang}:${count}`)
          .join(', ')}) · engine ${this.version || 'unknown'}`
      );
      broadcastNotification('tts.status', this.getStatus());
      // Warm the selected voice so the first live comment is spoken instantly.
      this.warm(state.settings.ttsVoice, state.settings.ttsLanguage);
    } else if (msg.type === 'voices') {
      this.mergeWorkerVoices(Array.isArray(msg.voices) ? msg.voices : []);
      broadcastNotification('tts.status', this.getStatus());
    } else if (msg.type === 'warning') {
      console.warn('[Piper TTS]', msg.message);
      this.error = msg.message || this.error;
    } else if (msg.type === 'result' && msg.id != null) {
      const entry = this.pending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        entry.resolve(msg);
      }
    } else if (msg.type === 'error') {
      console.error('[Piper TTS Error]', msg.error);
      this.status = 'error';
      this.error = msg.error || 'Piper error';
      broadcastNotification('tts.status', this.getStatus());
    }
  }

  getStatus() {
    const voices = this.listVoices().map((voice) => this.voicePayload(voice));
    return {
      ready: this.ready,
      status: this.status,
      engine: 'Piper (local ONNX voices)',
      version: this.version,
      executable: this.exe,
      executableKind: this.exeKind,
      modelsRoot: path.relative(__dirname, this.modelsRoot).replace(/\\/g, '/'),
      languages: ['en', 'vi'],
      language: state.settings.ttsLanguage,
      voice: state.settings.ttsVoice,
      speed: state.settings.ttsSpeed,
      volume: state.settings.ttsVolume,
      voices,
      catalog: this.getCatalog(),
      lastScanAt: this.lastScanAt || null,
      error: this.error
    };
  }

  warm(voice, language) {
    if (!this.proc || !this.ready) return;
    try {
      this.proc.stdin.write(
        JSON.stringify({ cmd: 'warm', voice: voice || state.settings.ttsVoice, language: language || state.settings.ttsLanguage }) +
          '\n'
      );
    } catch (_) {}
  }

  synthesize(text, options = {}) {
    const limit = clamp(state.settings.ttsMaxChars || 140, 40, 220);
    const cleanText = String(text || '').trim().slice(0, limit);
    if (!cleanText) return Promise.resolve({ ok: false, error: 'Empty text' });

    const language = String(options.language || state.settings.ttsLanguage || 'en').toLowerCase() === 'vi' ? 'vi' : 'en';
    let voice = String(options.voice || state.settings.ttsVoice || '').trim();
    if (!voice || !this.voicesFor(language).some((candidate) => candidate.id === voice)) {
      voice = this.defaultVoice(language);
    }
    if (!voice) {
      return Promise.resolve({
        ok: false,
        error: `No Piper voice model found in ${path.join(this.modelsRoot, language)}`
      });
    }

    const speed = clamp(Number(options.speed || state.settings.ttsSpeed || 1), 0.5, 2);
    const dedupKey = `${language}::${voice}::${speed.toFixed(2)}::${cleanText}`;
    if (this.inflight.has(dedupKey)) return this.inflight.get(dedupKey);

    const promise = new Promise((resolve) => {
      if (!this.proc || !this.ready) {
        return resolve({ ok: false, error: `Piper worker status: ${this.status}` });
      }
      const id = ++this.reqCounter;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'Piper synthesis timeout' });
      }, 60000);

      this.pending.set(id, { resolve, timer });
      try {
        this.proc.stdin.write(JSON.stringify({ id, text: cleanText, voice, language, speed }) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: err.message });
      }
    }).finally(() => {
      this.inflight.delete(dedupKey);
    });

    this.inflight.set(dedupKey, promise);
    return promise;
  }
}

// ============================================================================
// 4. SHOP STATE
// ============================================================================
const DEFAULT_STATE = {
  customersServed: 0,
  drinksSold: 0,
  totalTips: 0,
  likes: 0,
  follows: 0,
  comments: 0,
  gifts: 0,
  totalCoins: 0,
  recentGifts: [],
  supporters: {},
  recentEvents: [],
  settings: {
    running: true,
    paused: false,
    spawnRate: 1,
    ttsEnabled: true,
    ttsLanguage: 'en',
    ttsVoice: 'en_US-amy-medium',
    ttsSpeed: 1,
    ttsMaxChars: 120,
    bgMusicEnabled: true,
    sfxEnabled: true,
    musicVolume: 0.55,
    ttsVolume: 0.9,
    sfxVolume: 0.85,
    autoSim: false,
    autoSimIntervalMs: 9000
  },
  tiktok: {
    connected: false,
    connecting: false,
    reconnecting: false,
    status: 'disconnected',
    username: process.env.TIKTOK_USER || '',
    roomId: null,
    viewerCount: 0,
    connectedAt: null,
    attempts: 0,
    lastEvent: null,
    lastError: null
  }
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return {
        ...DEFAULT_STATE,
        ...saved,
        supporters: saved.supporters || {},
        recentGifts: Array.isArray(saved.recentGifts) ? saved.recentGifts.slice(0, 12) : [],
        settings: { ...DEFAULT_STATE.settings, ...(saved.settings || {}) },
        tiktok: { ...DEFAULT_STATE.tiktok }
      };
    }
  } catch (e) {
    console.warn('[State] Could not read game-state.json, using defaults:', e.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

const state = loadState();

// ============================================================================
// 4a. VOICE CHARACTER PROFILES
// Four independent Piper profiles (male seller, female seller, announcer,
// customer). Settings live on the server so Admin and Stage always agree and
// survive restarts. Piper models are still discovered dynamically.
// ============================================================================
const VOICE_PROFILE_IDS = ['maleSeller', 'femaleSeller', 'announcer', 'customer'];
const ANNOUNCER_MODES = ['maleSeller', 'femaleSeller', 'alternate', 'random'];
const SELLER_PROFILE_IDS = ['maleSeller', 'femaleSeller'];

const VOICE_PROFILE_META = {
  maleSeller: {
    label: 'Male Seller',
    icon: '🧑‍🍳',
    role: 'seller',
    personality: 'Friendly, energetic, casual American shopkeeper — occasionally humorous.'
  },
  femaleSeller: {
    label: 'Female Seller',
    icon: '👩‍🍳',
    role: 'seller',
    personality: 'Warm, cheerful, welcoming American shopkeeper — occasionally playful.'
  },
  announcer: {
    label: 'AI Announcer',
    icon: '📣',
    role: 'announcer',
    personality: 'Uses the selected seller profile with that seller\'s complete voice settings.'
  },
  customer: {
    label: 'Customer Responses',
    icon: '🙋',
    role: 'customer',
    personality: 'Customer voice, independent of both sellers.'
  }
};

// Automatic TikTok speech is routed by role, never by a hardcoded voice.
const VOICE_ROUTES = {
  giftOrder: 'seller',
  partyOrder: 'seller',
  followGuest: 'seller',
  viewerJoin: 'seller',
  serveDrink: 'seller',
  commentOrder: 'seller',
  announcement: 'announcer',
  customerResponse: 'customer'
};

// The installed engine (piper-tts 1.8.0) exposes no pitch control. Never fake it.
const VOICE_CAPABILITIES = {
  speed: true,
  volume: true,
  pitch: false,
  pitchReason:
    'The installed piper-tts engine exposes speaker_id, length_scale, noise_scale, noise_w_scale, normalize_audio and volume — there is no pitch parameter.',
  engineParameters: ['speaker_id', 'length_scale', 'noise_scale', 'noise_w_scale', 'normalize_audio', 'volume'],
  speedRange: [0.5, 2],
  note: 'Volume is applied per speech item at playback, so a settings change never alters audio already queued or playing.'
};

function profileNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function defaultVoiceProfiles() {
  const english = piperTts.voicesFor('en');
  const male = english.find((voice) => voice.gender === 'male') || english[0] || null;
  const female = english.find((voice) => voice.gender === 'female') || english[1] || english[0] || null;
  // The customer voice deliberately differs from both sellers when possible.
  const customer =
    english.find((voice) => voice.id !== (male && male.id) && voice.id !== (female && female.id)) ||
    female ||
    male ||
    null;
  return {
    maleSeller: { enabled: true, voice: male ? male.id : '', language: 'en', speed: 1, volume: 0.9 },
    femaleSeller: { enabled: true, voice: female ? female.id : '', language: 'en', speed: 1.05, volume: 0.9 },
    announcer: { enabled: true, voice: '', language: 'en', speed: 1, volume: 0.9, mode: 'alternate' },
    customer: { enabled: true, voice: customer ? customer.id : '', language: 'en', speed: 1, volume: 0.85 }
  };
}

function normalizeVoiceProfiles(raw) {
  const defaults = defaultVoiceProfiles();
  const source = raw && typeof raw === 'object' ? raw : {};
  const normalized = {};
  for (const id of VOICE_PROFILE_IDS) {
    const base = defaults[id];
    const given = source[id] && typeof source[id] === 'object' ? source[id] : {};
    const entry = {
      id,
      enabled: given.enabled !== false,
      voice: typeof given.voice === 'string' ? given.voice.trim().slice(0, 80) : base.voice,
      language: given.language === 'vi' ? 'vi' : given.language === 'en' ? 'en' : base.language,
      speed: Math.round(clamp(profileNumber(given.speed, base.speed), 0.5, 2) * 100) / 100,
      volume: Math.round(clamp(profileNumber(given.volume, base.volume), 0, 1) * 100) / 100
    };
    if (id === 'announcer') {
      entry.mode = ANNOUNCER_MODES.includes(given.mode) ? given.mode : base.mode;
    }
    normalized[id] = entry;
  }
  return normalized;
}

function ensureVoiceProfiles() {
  if (!state.voiceProfiles || typeof state.voiceProfiles !== 'object') state.voiceProfiles = {};
  state.voiceProfiles = normalizeVoiceProfiles(state.voiceProfiles);
  return state.voiceProfiles;
}

// A configured voice that vanished from config/piper is reported, not overwritten.
function resolveProfileVoice(profile) {
  const language = profile.language === 'vi' ? 'vi' : 'en';
  const voices = piperTts.voicesFor(language);
  const configured = String(profile.voice || '').trim();
  const match = configured ? voices.find((voice) => voice.id === configured) : null;
  const fallback = (voices[0] && voices[0].id) || piperTts.defaultVoice('en') || '';
  const fallbackVoice = fallback ? piperTts.listVoices().find((voice) => voice.id === fallback) : null;
  return {
    language,
    voice: match ? match.id : fallback,
    name: match ? match.name : fallbackVoice ? fallbackVoice.name : '',
    gender: match ? match.gender || null : fallbackVoice ? fallbackVoice.gender || null : null,
    missing: Boolean(configured) && !match,
    configured
  };
}

let sellerTurn = 0;
let announcerTurn = 0;

function enabledSellers(profiles) {
  return SELLER_PROFILE_IDS.map((id) => profiles[id]).filter((profile) => profile && profile.enabled !== false);
}

// Seller dialogue alternates so the same sentence never lands on one seller twice.
function nextSellerProfile() {
  const profiles = ensureVoiceProfiles();
  const sellers = enabledSellers(profiles);
  if (!sellers.length) return null;
  const choice = sellers[sellerTurn % sellers.length];
  sellerTurn += 1;
  return choice;
}

function resolveAnnouncerSeller() {
  const profiles = ensureVoiceProfiles();
  const mode = profiles.announcer.mode || 'alternate';
  const sellers = enabledSellers(profiles);
  if (!sellers.length) return null;
  if (mode === 'maleSeller') return profiles.maleSeller.enabled !== false ? profiles.maleSeller : sellers[0];
  if (mode === 'femaleSeller') return profiles.femaleSeller.enabled !== false ? profiles.femaleSeller : sellers[0];
  if (mode === 'random') return sellers[Math.floor(Math.random() * sellers.length)];
  const choice = sellers[announcerTurn % sellers.length];
  announcerTurn += 1;
  return choice;
}

function activeProfileForRole(role) {
  const profiles = ensureVoiceProfiles();
  if (role === 'customer') return profiles.customer.enabled !== false ? profiles.customer : null;
  if (role === 'announcer') {
    if (profiles.announcer.enabled === false) return null;
    // An exact announcer voice overrides the seller-selection modes.
    if (profiles.announcer.voice) return profiles.announcer;
    return resolveAnnouncerSeller() || null;
  }
  return nextSellerProfile();
}

// Resolved once when speech is queued. Every item keeps this snapshot, so later
// profile edits cannot change audio that is already queued or playing.
function speechFor(role) {
  const profiles = ensureVoiceProfiles();
  const profile = activeProfileForRole(role);
  if (!profile) {
    return {
      ttsProfile: role === 'customer' ? 'customer' : role === 'announcer' ? 'announcer' : 'maleSeller',
      ttsProfileEnabled: false,
      ttsVoice: state.settings.ttsVoice,
      ttsLanguage: state.settings.ttsLanguage,
      ttsSpeed: state.settings.ttsSpeed,
      ttsVolume: state.settings.ttsVolume
    };
  }
  const resolved = resolveProfileVoice(profile);
  return {
    ttsProfile: profile.id,
    ttsProfileEnabled: true,
    ttsVoice: resolved.voice,
    ttsLanguage: resolved.language,
    ttsSpeed: profile.speed,
    ttsVolume: profile.volume,
    ttsVoiceMissing: resolved.missing
  };
}

function voiceProfilesSnapshot() {
  const profiles = ensureVoiceProfiles();
  const entries = {};
  for (const id of VOICE_PROFILE_IDS) {
    const profile = profiles[id];
    const resolved = resolveProfileVoice(profile);
    const meta = VOICE_PROFILE_META[id];
    entries[id] = {
      ...profile,
      label: meta.label,
      icon: meta.icon,
      role: meta.role,
      personality: meta.personality,
      resolvedVoice: resolved.voice,
      resolvedVoiceName: resolved.name,
      gender: resolved.gender,
      missing: resolved.missing,
      missingVoice: resolved.missing ? resolved.configured : ''
    };
  }
  return {
    profiles: entries,
    ids: [...VOICE_PROFILE_IDS],
    announcerMode: profiles.announcer.mode,
    announcerModes: [...ANNOUNCER_MODES],
    routes: { ...VOICE_ROUTES },
    capabilities: { ...VOICE_CAPABILITIES },
    sellerTurn,
    savedAt: state.voiceProfilesSavedAt || null
  };
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const toSave = {
      customersServed: state.customersServed,
      drinksSold: state.drinksSold,
      totalTips: state.totalTips,
      likes: state.likes,
      follows: state.follows,
      comments: state.comments,
      gifts: state.gifts,
      totalCoins: state.totalCoins,
      recentGifts: state.recentGifts.slice(0, 12),
      supporters: state.supporters,
      settings: state.settings,
      voiceProfiles: state.voiceProfiles || null
    };
    fs.promises.writeFile(STATE_FILE, JSON.stringify(toSave, null, 2), 'utf8').catch((e) => {
      console.error('[State] Write failed:', e.message);
    });
  }, 1000);
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}

// Current live session only — restarting the shop starts a fresh scoreboard.
function getLeaderboard(limit = 6) {
  return [...liveSession.supporters.values()]
    .sort((a, b) => (b.coins || 0) - (a.coins || 0) || (b.drinks || 0) - (a.drinks || 0))
    .slice(0, limit)
    .map((s, index) => ({
      rank: index + 1,
      name: s.name,
      uniqueId: s.uniqueId,
      avatar: s.avatar || '',
      coins: round2(s.coins || 0),
      drinks: s.drinks || 0,
      gifts: s.gifts || 0,
      vipLevel: s.vipLevel || 0,
      vipName: vipLevelFor(s.coins || 0).name
    }));
}

// All-time totals, kept separate from the live session scoreboard.
function getLifetimeLeaderboard(limit = 8) {
  return Object.values(state.supporters)
    .sort((a, b) => (b.coins || 0) - (a.coins || 0) || b.tips - a.tips)
    .slice(0, limit)
    .map((s, index) => ({
      rank: index + 1,
      name: s.name,
      uniqueId: s.uniqueId,
      avatar: s.avatar || '',
      tips: round2(s.tips),
      coins: round2(s.coins || 0),
      drinks: s.drinks || 0,
      lastNote: s.lastNote || ''
    }));
}

// ---------------------------------------------------------------------------
// Text hygiene: block spam glyphs while keeping plain English (and any names)
// ---------------------------------------------------------------------------
const WEIRD_SPAM_RE = /[\u{12000}-\u{1254F}\uFDFD\u2800-\u28FF\u2580-\u259F]|[\u0300-\u036F]{3,}/u;
const BRACKET_EMOTE_RE = /\[[^\]]{1,24}\]/g;
const ALLOWED_TEXT_RE = /[^\p{L}\p{N}\s.,!?'"&$+#-]/gu;
const ALLOWED_NAME_RE = /[^\p{L}\p{N}\s._-]/gu;
const LETTER_RE = /\p{L}/gu;
const BAD_WORDS_RE = /(n[i1]gg|f[a4]gg|r[e3]t[a4]rd|wh[o0]re|sl[u4]t|asshole|b[i1]tch)/i;

function isBlockedSpamOrToxic(raw) {
  if (!raw) return true;
  const s = String(raw);
  if (WEIRD_SPAM_RE.test(s)) return true;
  if (BAD_WORDS_RE.test(s)) return true;
  return false;
}

function sanitizeUserName(rawName) {
  const normalized = String(rawName || '')
    .normalize('NFKC')
    .normalize('NFC')
    .replace(BRACKET_EMOTE_RE, ' ')
    .replace(ALLOWED_NAME_RE, ' ')
    .replace(/(.)\1{3,}/gi, '$1$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);

  if (!normalized || BAD_WORDS_RE.test(normalized)) return 'Guest';
  const letters = normalized.match(LETTER_RE) || [];
  if (letters.length < 2) return 'Guest';
  return normalized;
}

function sanitizeOrderText(rawText) {
  if (!rawText) return '';
  const cleaned = String(rawText)
    .normalize('NFKC')
    .normalize('NFC')
    .replace(BRACKET_EMOTE_RE, ' ')
    .replace(ALLOWED_TEXT_RE, ' ')
    .replace(/([.,!?])\1+/g, '$1')
    .replace(/(.)\1{2,}/gi, '$1$1')
    .replace(/\s+/g, ' ')
    .replace(/^[.,!?\s-]+|[.,!?\s-]+$/g, '')
    .slice(0, 90);

  if (!cleaned || BAD_WORDS_RE.test(cleaned)) return '';
  const letters = cleaned.match(LETTER_RE) || [];
  if (letters.length < 3) return '';
  return cleaned;
}

// Spoken lines follow the selected Piper language so comments read naturally.
function speakLine(english, vietnamese) {
  return state.settings.ttsLanguage === 'vi' ? vietnamese : english;
}

function recordSupporter(name, uniqueId, avatar, tipDelta = 0, drinkDelta = 0, giftDelta = 0, note = '', coinsDelta = 0) {
  const key = String(uniqueId || name || 'guest').slice(0, 40);
  if (!state.supporters[key]) {
    state.supporters[key] = {
      name,
      uniqueId: uniqueId || key,
      avatar: avatar || '',
      tips: 0,
      coins: 0,
      drinks: 0,
      gifts: 0,
      lastNote: ''
    };
  }
  const supporter = state.supporters[key];
  supporter.name = name || supporter.name;
  if (avatar) supporter.avatar = avatar;
  supporter.tips = round2(supporter.tips + tipDelta);
  supporter.coins = round2((supporter.coins || 0) + coinsDelta);
  supporter.drinks += drinkDelta;
  supporter.gifts += giftDelta;
  if (note) supporter.lastNote = note;

  state.totalTips = round2(state.totalTips + tipDelta);
  return supporter;
}

function pushEventLog(evt) {
  const entry = {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    ...evt
  };
  state.recentEvents.unshift(entry);
  if (state.recentEvents.length > 30) state.recentEvents.length = 30;
  return entry;
}

function pickDrink(rawId) {
  const key = String(rawId || '').toLowerCase();
  const found = DRINK_MENU.find(
    (d) => d.id === key || d.name.toLowerCase() === key || d.name.toLowerCase().includes(key)
  );
  if (found && key) return found;
  return DRINK_MENU[Math.floor(Math.random() * DRINK_MENU.length)];
}

function pickMysteryCard() {
  return MYSTERY_DECK[Math.floor(Math.random() * MYSTERY_DECK.length)];
}

// ============================================================================
// 4b. VIEWER CHARACTER SYSTEM
// One TikTok viewer = one persistent game character for the whole live session.
// ============================================================================
// VIP progression is driven by coins donated during the current live session.
const VIP_LEVELS = [
  { level: 0, key: 'regular', name: 'Regular Customer', min: 0 },
  { level: 1, key: 'vip', name: 'VIP Customer', min: 25 },
  { level: 2, key: 'super', name: 'Super VIP', min: 50 },
  { level: 3, key: 'diamond', name: 'Diamond VIP', min: 100 }
];

function vipLevelFor(coins) {
  const value = Number(coins) || 0;
  let found = VIP_LEVELS[0];
  for (const tier of VIP_LEVELS) {
    if (value >= tier.min) found = tier;
  }
  return found;
}

// Individual gift coin value decides how big the celebration is.
function celebrationFor(coins) {
  const value = Number(coins) || 0;
  if (value >= 500) return { tier: 'grand', label: 'GRAND CELEBRATION', coins: value };
  if (value >= 100) return { tier: 'fireworks', label: 'VIP CELEBRATION', coins: value };
  if (value >= 50) return { tier: 'gold', label: 'GOLDEN CELEBRATION', coins: value };
  if (value >= 25) return { tier: 'small', label: 'CELEBRATION', coins: value };
  return { tier: 'none', label: '', coins: value };
}

// No character cap and no waiting-slot cap: every viewer on stage is eligible to
// appear. Only the retention window is bounded, so a returning viewer keeps their
// identity (and their character) for 15 minutes after leaving.
const VIEWER_RETENTION_MS = 15 * 60 * 1000;
const CUSTOMER_SPRITE_COUNT = 10;

const viewerSessions = new Map();
let viewerSeq = 0;
let sessionSeq = 0;

const liveSession = {
  id: '',
  startedAt: '',
  coins: 0,
  drinks: 0,
  served: 0,
  supporters: new Map()
};

function startLiveSession() {
  sessionSeq += 1;
  liveSession.id = `live_${Date.now()}_${sessionSeq}`;
  liveSession.startedAt = new Date().toISOString();
  liveSession.coins = 0;
  liveSession.drinks = 0;
  liveSession.served = 0;
  liveSession.supporters.clear();
  // A new live session starts everyone back at Regular Customer.
  for (const viewer of viewerSessions.values()) {
    viewer.sessionCoins = 0;
    viewer.vipLevel = 0;
  }
}
startLiveSession();

function viewerKey(user, uniqueId) {
  const uid = String(uniqueId || '').trim().toLowerCase();
  if (uid) return `u:${uid.slice(0, 40)}`;
  return `n:${sanitizeUserName(user || 'guest').toLowerCase()}`;
}

// A departure can arrive as anything the client has: the internal viewerId, a
// uniqueId, or just the display name. Resolve the one record instead of creating
// a second viewer (or missing the departure and leaving a ghost on stage).
function findViewerRecord(params = {}) {
  const wantedId = String(params.viewerId || params.viewerID || params.id || '').trim();
  if (wantedId) {
    for (const viewer of viewerSessions.values()) {
      if (viewer.id === wantedId) return viewer;
    }
  }
  const byKey = viewerSessions.get(viewerKey(params.user || params.uniqueId, params.uniqueId));
  if (byKey) return byKey;
  const wantedUid = String(params.uniqueId || '').trim().toLowerCase();
  if (wantedUid) {
    for (const viewer of viewerSessions.values()) {
      if (String(viewer.uniqueId || '').toLowerCase() === wantedUid) return viewer;
    }
  }
  const wantedName = sanitizeUserName(params.user || '').toLowerCase();
  if (wantedName && wantedName !== 'guest') {
    for (const viewer of viewerSessions.values()) {
      if (String(viewer.name || '').toLowerCase() === wantedName) return viewer;
    }
  }
  return null;
}

// Gift senders jump ahead of passive viewers; ties fall back to arrival order.
function activeViewers() {
  return [...viewerSessions.values()]
    .filter((viewer) => !viewer.leftAt)
    .sort((a, b) => {
      if ((b.giftOrders || 0) !== (a.giftOrders || 0)) return (b.giftOrders || 0) - (a.giftOrders || 0);
      return a.joinedAt - b.joinedAt;
    });
}

function viewerRank(viewer) {
  const index = activeViewers().findIndex((entry) => entry.id === viewer.id);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

// Spread characters over the ten customer sprites instead of cloning faces.
function pickViewerSprite() {
  const used = new Map();
  for (const viewer of viewerSessions.values()) {
    if (viewer.leftAt) continue;
    used.set(viewer.sprite, (used.get(viewer.sprite) || 0) + 1);
  }
  const counts = [];
  for (let i = 0; i < CUSTOMER_SPRITE_COUNT; i++) counts.push(used.get(i) || 0);
  const fewest = Math.min(...counts);
  const free = [];
  for (let i = 0; i < CUSTOMER_SPRITE_COUNT; i++) if (counts[i] === fewest) free.push(i);
  return free[Math.floor(Math.random() * free.length)];
}

function viewerSnapshot(viewer, rank = viewerRank(viewer)) {
  if (!viewer) return null;
  return {
    id: viewer.id,
    uniqueId: viewer.uniqueId,
    name: viewer.name,
    avatar: viewer.avatar,
    sprite: viewer.sprite,
    vip: Boolean(viewer.vip) || (viewer.vipLevel || 0) > 0,
    vipLevel: viewer.vipLevel || 0,
    vipName: vipLevelFor(viewer.sessionCoins || 0).name,
    sessionCoins: round2(viewer.sessionCoins || 0),
    coins: round2(viewer.coins),
    drinks: viewer.drinks,
    likes: viewer.likes,
    comments: viewer.comments,
    follows: viewer.follows,
    gifts: viewer.gifts,
    joinedAt: viewer.joinedAt,
    leftAt: viewer.leftAt || 0,
    rank,
    // Every active viewer is on stage; nothing is parked off-stage anymore.
    visible: !viewer.leftAt,
    holding: false,
    pendingOrders: viewer.orders.length,
    orders: viewer.orders.slice(0, 5)
  };
}

// Repeated joins, follows and gifts all resolve to the same viewer record.
function ensureViewer(params = {}) {
  const now = Date.now();
  const name = sanitizeUserName(params.user || params.uniqueId || 'Guest');
  const key = viewerKey(name, params.uniqueId);
  let viewer = viewerSessions.get(key);
  let created = false;
  let rejoined = false;

  if (viewer && viewer.leftAt && now - viewer.leftAt > VIEWER_RETENTION_MS) {
    viewerSessions.delete(key);
    viewer = null;
  }

  if (!viewer) {
    viewer = {
      id: `v_${++viewerSeq}`,
      key,
      uniqueId: String(params.uniqueId || key).slice(0, 40),
      name,
      avatar: params.avatar || '',
      sprite: pickViewerSprite(),
      vip: Boolean(params.vip),
      joinedAt: now,
      lastSeenAt: now,
      leftAt: 0,
      coins: 0,
      sessionCoins: 0,
      vipLevel: 0,
      drinks: 0,
      likes: 0,
      comments: 0,
      follows: 0,
      gifts: 0,
      giftOrders: 0,
      orders: [],
      joins: 1,
      reconnects: 0
    };
    viewerSessions.set(key, viewer);
    created = true;
  } else {
    if (viewer.leftAt) {
      viewer.leftAt = 0;
      viewer.reconnects += 1;
      viewer.joins += 1;
      rejoined = true;
    }
    viewer.lastSeenAt = now;
    if (name && name !== 'Guest') viewer.name = name;
    if (params.avatar && !viewer.avatar) viewer.avatar = params.avatar;
    if (params.vip) viewer.vip = true;
  }

  return { viewer, created, rejoined };
}

function recordViewerStats(viewer, delta = {}) {
  if (!viewer) return { levelUp: false, level: 0, previous: 0 };
  const previous = viewer.vipLevel || 0;
  viewer.coins = round2(viewer.coins + (delta.coins || 0));
  viewer.sessionCoins = round2((viewer.sessionCoins || 0) + (delta.coins || 0));
  viewer.drinks += delta.drinks || 0;
  viewer.likes += delta.likes || 0;
  viewer.comments += delta.comments || 0;
  viewer.follows += delta.follows || 0;
  viewer.gifts += delta.gifts || 0;
  viewer.giftOrders += delta.giftOrders || 0;

  const level = vipLevelFor(viewer.sessionCoins);
  viewer.vipLevel = level.level;
  if (level.level > 0) viewer.vip = true;

  liveSession.coins = round2(liveSession.coins + (delta.coins || 0));
  liveSession.drinks += delta.drinks || 0;

  const support =
    liveSession.supporters.get(viewer.id) ||
    { name: viewer.name, uniqueId: viewer.uniqueId, avatar: viewer.avatar || '', coins: 0, drinks: 0, gifts: 0, vipLevel: 0 };
  support.name = viewer.name;
  support.avatar = viewer.avatar || '';
  support.coins = round2(support.coins + (delta.coins || 0));
  support.drinks += delta.drinks || 0;
  support.gifts += delta.gifts || 0;
  support.vipLevel = level.level;
  liveSession.supporters.set(viewer.id, support);

  return { levelUp: level.level > previous, level: level.level, previous, name: level.name };
}

// A viewer keeps a personal order queue; every gift appends to it.
function enqueueViewerOrder(viewer, order) {
  if (!viewer || !order) return null;
  const entry = {
    id: order.id || `ord_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    drinkId: order.drinkId,
    drinkName: order.drinkName,
    drinkImage: order.drinkImage || '',
    coins: round2(order.coins || 0),
    tip: round2(order.tip || 0),
    giftName: order.giftName || '',
    giftIcon: order.giftIcon || '',
    at: new Date().toISOString()
  };
  // Combo updates replay the same order id — never queue it twice.
  if (viewer.orders.some((existing) => existing.id === entry.id)) return entry;
  viewer.orders.push(entry);
  if (viewer.orders.length > 20) viewer.orders.splice(0, viewer.orders.length - 20);
  return entry;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, viewer] of viewerSessions) {
    if (viewer.leftAt && now - viewer.leftAt > VIEWER_RETENTION_MS) viewerSessions.delete(key);
  }
}, 60 * 1000).unref?.();

function getPublicState() {
  return {
    shop: SHOP_NAME,
    customersServed: state.customersServed,
    drinksSold: state.drinksSold,
    totalTips: round2(state.totalTips),
    likes: state.likes,
    follows: state.follows,
    comments: state.comments,
    gifts: state.gifts,
    totalCoins: round2(state.totalCoins),
    menu: DRINK_MENU,
    coinMenu: coinMenuEntries(),
    giftCatalog: coinMenuEntries(),
    donation: {
      totalCoins: round2(state.totalCoins),
      drinksServed: state.drinksSold,
      giftsReceived: state.gifts,
      topSupporters: getLeaderboard(3),
      recentGifts: state.recentGifts.slice(0, 6)
    },
    leaderboard: getLeaderboard(8),
    lifetimeLeaderboard: getLifetimeLeaderboard(8),
    session: {
      id: liveSession.id,
      startedAt: liveSession.startedAt,
      coins: round2(liveSession.coins),
      drinks: liveSession.drinks,
      served: liveSession.served,
      supporters: liveSession.supporters.size
    },
    viewers: activeViewers().map((viewer, index) => viewerSnapshot(viewer, index)),
    vipSummary: {
      total: activeViewers().filter((viewer) => (viewer.vipLevel || 0) > 0).length,
      vip: activeViewers().filter((viewer) => (viewer.vipLevel || 0) === 1).length,
      superVip: activeViewers().filter((viewer) => (viewer.vipLevel || 0) === 2).length,
      diamond: activeViewers().filter((viewer) => (viewer.vipLevel || 0) === 3).length,
      sessionDonations: round2(liveSession.coins)
    },
    viewerSummary: {
      active: activeViewers().length,
      total: viewerSessions.size,
      visible: activeViewers().length,
      holding: 0,
      recentlyLeft: [...viewerSessions.values()].filter((viewer) => viewer.leftAt).length,
      retentionMs: VIEWER_RETENTION_MS
    },
    recentEvents: state.recentEvents.slice(0, 12),
    settings: state.settings,
    tiktok: tiktokSnapshot(),
    tts: piperTts.getStatus(),
    voiceProfiles: voiceProfilesSnapshot(),
    voiceRoutes: { ...VOICE_ROUTES }
  };
}

// ============================================================================
// 5. SHOP ACTIONS (each one returns { event, state })
// ============================================================================
const Actions = {
  serveDrink(params = {}) {
    const name = sanitizeUserName(params.user || params.uniqueId);
    const uniqueId = params.uniqueId || '';
    const avatar = params.avatar || '';
    const count = Math.round(clamp(params.count || 1, 1, 6));
    const drink = pickDrink(params.drinkId || params.drink);
    const note = sanitizeOrderText(params.order || params.message || '');
    const tip = round2(drink.price * count + (params.vip ? 6 : 1));

    state.customersServed += count;
    state.drinksSold += count;
    if (params.guest !== true) state.comments += 1;
    const supporter = recordSupporter(name, uniqueId, avatar, tip, count, 0, note);
    const { viewer } = ensureViewer({ user: supporter.name, uniqueId, avatar });
    recordViewerStats(viewer, { drinks: count });
    const viewerOrder = enqueueViewerOrder(viewer, {
      id: params.orderId,
      drinkId: drink.id,
      drinkName: drink.name,
      drinkImage: drink.image,
      coins: 0,
      tip
    });

    const ttsText =
      params.readTts === false
        ? ''
        : speakLine(
            `Order up! ${count > 1 ? count + ' ' + drink.name : drink.name} for ${supporter.name}.`,
            `Đơn hàng đây! ${count > 1 ? count + ' ly ' + drink.name : drink.name} cho ${supporter.name}.`
          );

    const event = pushEventLog({
      type: 'serveDrink',
      viewerId: viewer.id,
      orderId: viewerOrder ? viewerOrder.id : null,
      user: supporter.name,
      uniqueId: supporter.uniqueId,
      avatar: supporter.avatar,
      drink,
      count,
      tip,
      message: note,
      vip: Boolean(params.vip),
      ttsText,
      ...speechFor('seller')
    });

    saveState();
    broadcastNotification('temple.event', { event, state: getPublicState() });
    return { event, state: getPublicState() };
  },

  freeDrink(params = {}) {
    return this.serveDrink({ ...params, count: 1, vip: true, order: params.message || 'A free sample, on the house!' });
  },

  likeBurst(params = {}) {
    const name = sanitizeUserName(params.user || params.uniqueId);
    const uniqueId = params.uniqueId || '';
    const avatar = params.avatar || '';
    const count = Math.round(clamp(params.count || 1, 1, 30));
    const tip = round2(0.25 * count);

    state.likes += count;
    const supporter = recordSupporter(name, uniqueId, avatar, tip, 0, 0, 'Sent some love to the shop');
    const { viewer } = ensureViewer({ user: supporter.name, uniqueId, avatar });
    recordViewerStats(viewer, { likes: count });

    const event = pushEventLog({
      type: 'likeBurst',
      viewerId: viewer.id,
      wave: true,
      user: supporter.name,
      uniqueId: supporter.uniqueId,
      avatar: supporter.avatar,
      count,
      tip,
      ttsText: '',
      ...speechFor('seller')
    });

    saveState();
    broadcastNotification('temple.event', { event, state: getPublicState() });
    return { event, state: getPublicState() };
  },

  followGuest(params = {}) {
    const name = sanitizeUserName(params.user || params.uniqueId);
    const uniqueId = params.uniqueId || '';
    const avatar = params.avatar || '';
    const drink = pickDrink(params.drinkId);
    const tip = round2(drink.price + 7);

    state.follows += 1;
    state.customersServed += 1;
    state.drinksSold += 1;
    const supporter = recordSupporter(name, uniqueId, avatar, tip, 1, 0, 'Followed the shop');
    const { viewer } = ensureViewer({ user: supporter.name, uniqueId, avatar });
    viewer.vip = true;
    recordViewerStats(viewer, { drinks: 1, follows: 1 });

    const ttsText =
      params.readTts === false
        ? ''
        : speakLine(
            `${supporter.name} just followed! Free ${drink.name}, on the house.`,
            `${supporter.name} vừa theo dõi tiệm! Tặng bạn một ly ${drink.name} miễn phí.`
          );

    const event = pushEventLog({
      type: 'followGuest',
      viewerId: viewer.id,
      celebrate: true,
      user: supporter.name,
      uniqueId: supporter.uniqueId,
      avatar: supporter.avatar,
      drink,
      count: 1,
      tip,
      vip: true,
      message: 'New follower: free drink!',
      ttsText,
      ...speechFor('seller')
    });

    saveState();
    broadcastNotification('temple.event', { event, state: getPublicState() });
    return { event, state: getPublicState() };
  },

  // TikTok gift → drink order. The coin value alone selects the drink.
  giftOrder(params = {}) {
    const coinsPerGift = Math.round(Number(params.coins) || 0);
    const tier = coinTier(coinsPerGift);
    if (!tier) {
      return {
        ok: false,
        ignored: true,
        coins: coinsPerGift,
        reason: `No drink configured for ${coinsPerGift} coins`
      };
    }

    const drink = DRINK_MENU.find((item) => item.id === tier.drinkId) || pickDrink(tier.drinkId);
    const name = sanitizeUserName(params.user || params.uniqueId);
    const uniqueId = params.uniqueId || '';
    const avatar = params.avatar || '';
    const units = Math.round(clamp(params.units || params.count || 1, 1, 20));
    const coins = round2(tier.coins * units);
    const tip = round2(drink.price + coins * 0.1);
    const giftName = sanitizeOrderText(params.giftName) || `${tier.coins}-coin gift`;
    const giftId = `coin_${tier.coins}`;

    state.gifts += 1;
    state.totalCoins = round2(state.totalCoins + coins);
    state.customersServed += units;
    state.drinksSold += units;
    const supporter = recordSupporter(
      name,
      uniqueId,
      avatar,
      tip,
      units,
      1,
      `${coinsPerGift} coins${units > 1 ? ' x' + units : ''}`,
      coins
    );

    const ttsText =
      params.readTts === false
        ? ''
        : speakLine(
            `${supporter.name} sent a ${tier.coins} coin gift! ${drink.name} coming right up.`,
            `${supporter.name} vừa tặng ${tier.coins} xu! ${drink.name} đang được pha.`
          );

    const giftEntry = {
      id: `gift_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      user: supporter.name,
      uniqueId: supporter.uniqueId,
      avatar: supporter.avatar,
      giftId,
      giftName,
      giftIcon: tier.icon,
      giftCoins: tier.coins,
      coins,
      units,
      drinkId: drink.id,
      drinkName: drink.name,
      drinkImage: drink.image,
      at: new Date().toISOString()
    };
    state.recentGifts.unshift(giftEntry);
    if (state.recentGifts.length > 12) state.recentGifts.length = 12;

    const { viewer } = ensureViewer({ user: supporter.name, uniqueId, avatar });
    const stats = recordViewerStats(viewer, { coins, drinks: units, gifts: 1, giftOrders: 1 });
    const vipInfo = vipLevelFor(viewer.sessionCoins);
    const celebration = celebrationFor(coinsPerGift);
    for (let i = 0; i < units; i++) {
      enqueueViewerOrder(viewer, {
        id: i === 0 ? giftEntry.id : `${giftEntry.id}_${i}`,
        drinkId: drink.id,
        drinkName: drink.name,
        drinkImage: drink.image,
        coins: tier.coins * units,
        tip: i === 0 ? tip : 0,
        giftName,
        giftIcon: tier.icon
      });
    }

    const event = pushEventLog({
      type: 'giftOrder',
      viewerId: viewer.id,
      orderId: giftEntry.id,
      pendingOrders: viewer.orders.length,
      vipLevel: vipInfo.level,
      vipName: vipInfo.name,
      vipUpgraded: stats.levelUp,
      previousVipLevel: stats.previous,
      sessionCoins: round2(viewer.sessionCoins),
      celebration,
      user: supporter.name,
      uniqueId: supporter.uniqueId,
      avatar: supporter.avatar,
      gift: { id: giftId, name: giftName, icon: tier.icon, coins: tier.coins },
      giftName,
      giftIcon: tier.icon,
      giftCoins: tier.coins,
      coins,
      units,
      count: units,
      drink,
      tip,
      message: `${tier.coins} coins → ${drink.name}`,
      ttsText,
      ...speechFor('seller')
    });

    saveState();
    broadcastNotification('temple.event', { event, state: getPublicState() });
    return { event, state: getPublicState() };
  },

  partyOrder(params = {}) {
    const name = sanitizeUserName(params.user || params.uniqueId);
    const uniqueId = params.uniqueId || '';
    const avatar = params.avatar || '';
    const coins = Math.max(1, Number(params.coins) || 10);
    const groupSize = Math.round(clamp(Math.floor(coins / 8) + 2, 2, 6));
    const giftName = sanitizeOrderText(params.giftName) || 'Drink Party Tray';
    const drink = pickDrink(params.drinkId);
    const tip = round2(Math.max(3, coins * 0.2));

    state.gifts += 1;
    state.customersServed += groupSize;
    state.drinksSold += groupSize;
    const supporter = recordSupporter(name, uniqueId, avatar, tip, groupSize, 1, `Gift: ${giftName}`);
    const { viewer } = ensureViewer({ user: supporter.name, uniqueId, avatar });
    recordViewerStats(viewer, { coins, drinks: groupSize, gifts: 1, giftOrders: 1 });
    for (let i = 0; i < groupSize; i++) {
      enqueueViewerOrder(viewer, {
        drinkId: drink.id,
        drinkName: drink.name,
        drinkImage: drink.image,
        coins: i === 0 ? coins : 0,
        tip: i === 0 ? tip : 0,
        giftName
      });
    }

    const ttsText =
      params.readTts === false
        ? ''
        : speakLine(
            `Big order! ${supporter.name} sent ${giftName}. ${groupSize} drinks coming right up!`,
            `Đơn lớn! ${supporter.name} vừa tặng ${giftName}. ${groupSize} ly nước đang được pha.`
          );

    const event = pushEventLog({
      type: 'partyOrder',
      viewerId: viewer.id,
      pendingOrders: viewer.orders.length,
      vipLevel: viewer.vipLevel || 0,
      vipName: vipLevelFor(viewer.sessionCoins || 0).name,
      sessionCoins: round2(viewer.sessionCoins || 0),
      celebration: celebrationFor(coins),
      user: supporter.name,
      uniqueId: supporter.uniqueId,
      avatar: supporter.avatar,
      giftName,
      coins,
      groupSize,
      drink,
      count: groupSize,
      tip,
      message: giftName,
      ttsText,
      ...speechFor('seller')
    });

    saveState();
    broadcastNotification('temple.event', { event, state: getPublicState() });
    return { event, state: getPublicState() };
  },

  mysteryDrink(params = {}) {
    const name = sanitizeUserName(params.user || params.uniqueId);
    const uniqueId = params.uniqueId || '';
    const avatar = params.avatar || '';
    const card = pickMysteryCard();
    const drink = pickDrink(card.id === 'old-fashioned' ? 'cola' : params.drinkId);
    const tip = round2(drink.price + 2);

    state.customersServed += 1;
    state.drinksSold += 1;
    const supporter = recordSupporter(name, uniqueId, avatar, tip, 1, 0, `Mystery sip: ${card.title}`);
    const { viewer } = ensureViewer({ user: supporter.name, uniqueId, avatar });
    recordViewerStats(viewer, { drinks: 1 });
    enqueueViewerOrder(viewer, {
      drinkId: drink.id,
      drinkName: drink.name,
      drinkImage: drink.image,
      coins: 0,
      tip
    });

    const ttsText =
      params.readTts === false
        ? ''
        : speakLine(
            `${card.ttsText} Ordered by ${supporter.name}.`,
            `Bí ẩn hôm nay là ${card.title}. ${supporter.name} đã gọi món này.`
          );

    const event = pushEventLog({
      type: 'mysteryDrink',
      viewerId: viewer.id,
      user: supporter.name,
      uniqueId: supporter.uniqueId,
      avatar: supporter.avatar,
      drink,
      card,
      count: 1,
      tip,
      message: card.title,
      ttsText,
      ...speechFor('seller')
    });

    saveState();
    broadcastNotification('temple.event', { event, state: getPublicState() });
    return { event, state: getPublicState() };
  },

  commentOrder(params = {}) {
    const name = sanitizeUserName(params.user || params.uniqueId);
    const uniqueId = params.uniqueId || '';
    const avatar = params.avatar || '';
    const text = sanitizeOrderText(params.order || params.message || '');
    const drink = pickDrink(params.drinkId || text);
    const count = Math.round(clamp(params.count || 1, 1, 3));
    const tip = round2(drink.price * count + 1);

    state.comments += 1;
    state.customersServed += count;
    state.drinksSold += count;
    const supporter = recordSupporter(name, uniqueId, avatar, tip, count, 0, text);
    const { viewer } = ensureViewer({ user: supporter.name, uniqueId, avatar });
    recordViewerStats(viewer, { comments: 1, drinks: count });
    enqueueViewerOrder(viewer, {
      drinkId: drink.id,
      drinkName: drink.name,
      drinkImage: drink.image,
      coins: 0,
      tip
    });

    const ttsText =
      params.readTts === false
        ? ''
        : speakLine(
            `${supporter.name} says: ${text || `one ${drink.name} please`}. Coming right up!`,
            `${supporter.name} nhắn: ${text || `cho tôi một ly ${drink.name}`}. Có ngay ạ!`
          );

    const event = pushEventLog({
      type: 'commentOrder',
      viewerId: viewer.id,
      bubbleText: text || `One ${drink.name}, please!`,
      user: supporter.name,
      uniqueId: supporter.uniqueId,
      avatar: supporter.avatar,
      drink,
      count,
      tip,
      message: text,
      ttsText,
      ...speechFor('seller')
    });

    saveState();
    broadcastNotification('temple.event', { event, state: getPublicState() });
    return { event, state: getPublicState() };
  },

  viewerJoin(params = {}) {
    const { viewer, created, rejoined } = ensureViewer(params);
    const rank = viewerRank(viewer);
    const snapshot = viewerSnapshot(viewer, rank);
    const event = pushEventLog({
      type: created || !rejoined ? 'viewerJoin' : 'viewerReconnect',
      viewerId: viewer.id,
      user: viewer.name,
      uniqueId: viewer.uniqueId,
      avatar: viewer.avatar,
      sprite: viewer.sprite,
      vip: viewer.vip,
      created,
      rejoined,
      duplicate: !created && !rejoined,
      rank,
      visible: true,
      holding: false,
      pendingOrders: viewer.orders.length,
      message: created ? 'Joined the live' : rejoined ? 'Came back' : 'Already in the shop',
      ttsText: ''
    });
    broadcastNotification('temple.event', { event, state: getPublicState() });
    return { ok: true, created, rejoined, event, viewer: snapshot, state: getPublicState() };
  },

  viewerLeave(params = {}) {
    const viewer = findViewerRecord(params);
    if (!viewer) return { ok: false, reason: 'Unknown viewer' };
    // Duplicate departures are acknowledged without broadcasting a second ghost.
    if (viewer.leftAt) return { ok: true, alreadyLeft: true, viewer: viewerSnapshot(viewer, 0) };
    viewer.leftAt = Date.now();
    viewer.lastSeenAt = viewer.leftAt;
    const event = pushEventLog({
      type: 'viewerLeave',
      viewerId: viewer.id,
      user: viewer.name,
      uniqueId: viewer.uniqueId,
      sprite: viewer.sprite,
      pendingOrders: viewer.orders.length,
      message: 'Left the live',
      ttsText: ''
    });
    broadcastNotification('temple.event', { event, state: getPublicState() });
    return { ok: true, event, state: getPublicState() };
  },

  // The stage reports a finished order so the personal queue stays accurate.
  viewerServed(params = {}) {
    const viewer = findViewerRecord(params);
    if (!viewer) return { ok: false, reason: 'Unknown viewer' };
    // A serve confirmation that arrives after the departure must not restore them.
    if (viewer.leftAt) return { ok: false, reason: 'Viewer already left', left: true };
    const orderId = String(params.orderId || '');
    const before = viewer.orders.length;
    if (orderId) {
      viewer.orders = viewer.orders.filter((order) => order.id !== orderId);
      if (viewer.orders.length === before) {
        return { ok: false, reason: 'Order already served', pendingOrders: viewer.orders.length };
      }
    } else {
      // Legacy actions enqueue without sending an id to the stage.
      viewer.orders.shift();
    }
    recordViewerStats(viewer, { drinks: 1 });
    liveSession.served += 1;
    return { ok: true, pendingOrders: viewer.orders.length, viewer: viewerSnapshot(viewer) };
  },

  viewerRoster() {
    return {
      session: {
        id: liveSession.id,
        startedAt: liveSession.startedAt,
        coins: round2(liveSession.coins),
        drinks: liveSession.drinks,
        served: liveSession.served
      },
      limits: { retentionMs: VIEWER_RETENTION_MS, maxActive: null, visibleWaiting: null },
      viewers: activeViewers().map((viewer, index) => viewerSnapshot(viewer, index)),
      leaderboard: getLeaderboard(8),
      lifetimeLeaderboard: getLifetimeLeaderboard(8)
    };
  },

  // Admin test buttons: same celebration/VIP visuals, no leaderboard side effects.
  testVip(params = {}) {
    const coins = Math.round(clamp(Number(params.coins) || 25, 1, 5000));
    const level = vipLevelFor(coins);
    const celebration = celebrationFor(coins);
    const isCelebration = params.kind === 'celebration' || coins >= 500;
    const event = pushEventLog({
      type: isCelebration ? 'donationCelebration' : 'vipUpgrade',
      test: true,
      user: 'Test Supporter',
      uniqueId: 'test.supporter',
      avatar: '',
      coins,
      vipLevel: level.level,
      vipName: level.name,
      vipUpgraded: true,
      celebration,
      message: isCelebration ? `${coins} coin test celebration` : `${level.name} test`,
      ttsText: ''
    });
    broadcastNotification('temple.event', { event, state: getPublicState() });
    return { ok: true, event };
  },

  newGuest(params = {}) {
    const name = sanitizeUserName(params.user || params.uniqueId || 'Guest');
    const uniqueId = params.uniqueId || '';
    const avatar = params.avatar || '';
    const drink = pickDrink(params.drinkId);

    const event = pushEventLog({
      type: 'newGuest',
      user: name,
      uniqueId,
      avatar,
      drink,
      tip: 0,
      message: 'Walked into the shop',
      ttsText: ''
    });

    broadcastNotification('temple.event', { event, state: getPublicState() });
    return { event, state: getPublicState() };
  },

  updateSettings(params = {}) {
    const next = { ...state.settings };
    if (typeof params.running === 'boolean') next.running = params.running;
    if (typeof params.paused === 'boolean') next.paused = params.paused;
    if (typeof params.autoSim === 'boolean') next.autoSim = params.autoSim;
    if (typeof params.ttsEnabled === 'boolean') next.ttsEnabled = params.ttsEnabled;
    if (typeof params.bgMusicEnabled === 'boolean') next.bgMusicEnabled = params.bgMusicEnabled;
    if (typeof params.sfxEnabled === 'boolean') next.sfxEnabled = params.sfxEnabled;
    if (typeof params.spawnRate === 'number') next.spawnRate = clamp(params.spawnRate, 0.25, 3);
    if (typeof params.musicVolume === 'number') next.musicVolume = clamp(params.musicVolume, 0, 1);
    if (typeof params.ttsVolume === 'number') next.ttsVolume = clamp(params.ttsVolume, 0, 1);
    if (typeof params.sfxVolume === 'number') next.sfxVolume = clamp(params.sfxVolume, 0, 1);
    if (typeof params.autoSimIntervalMs === 'number') {
      next.autoSimIntervalMs = clamp(params.autoSimIntervalMs, 3000, 60000);
    }
    if (typeof params.ttsLanguage === 'string' && ['en', 'vi'].includes(params.ttsLanguage.toLowerCase())) {
      next.ttsLanguage = params.ttsLanguage.toLowerCase();
    }
    if (typeof params.ttsVoice === 'string' && params.ttsVoice.trim()) {
      next.ttsVoice = params.ttsVoice.trim().slice(0, 40);
    }
    if (typeof params.ttsSpeed === 'number') {
      next.ttsSpeed = Math.round(clamp(params.ttsSpeed, 0.5, 2) * 100) / 100;
    }
    if (typeof params.ttsMaxChars === 'number') {
      next.ttsMaxChars = Math.round(clamp(params.ttsMaxChars, 40, 220));
    }
    const validVoiceIds = piperTts.voicesFor(next.ttsLanguage).map((voice) => voice.id);
    if (!validVoiceIds.includes(next.ttsVoice)) {
      next.ttsVoice = piperTts.defaultVoice(next.ttsLanguage) || next.ttsVoice;
    }
    state.settings = next;
    if (params.ttsLanguage || params.ttsVoice) {
      piperTts.warm(state.settings.ttsVoice, state.settings.ttsLanguage);
    }

    if (typeof params.autoSim === 'boolean') configureAutoSim(params.autoSim);

    saveState();
    broadcastNotification('temple.state', getPublicState());
    return getPublicState();
  },

  startGame() {
    state.settings.running = true;
    state.settings.paused = false;
    saveState();
    broadcastNotification('shop.reset', { soft: true });
    broadcastNotification('temple.state', getPublicState());
    return getPublicState();
  },

  pauseGame(params = {}) {
    state.settings.running = true;
    state.settings.paused = Boolean(params.paused !== false);
    saveState();
    broadcastNotification('temple.state', getPublicState());
    return getPublicState();
  },

  resumeGame() {
    state.settings.running = true;
    state.settings.paused = false;
    saveState();
    broadcastNotification('temple.state', getPublicState());
    return getPublicState();
  },

  setSpawnRate(rate) {
    state.settings.spawnRate = clamp(rate, 0.25, 3);
    saveState();
    broadcastNotification('temple.state', getPublicState());
    return getPublicState();
  },

  spawnCustomer(params = {}) {
    // newGuest already broadcasts temple.event, so the client spawns exactly one guest.
    return this.newGuest(params);
  },

  resetGame() {
    state.customersServed = 0;
    state.drinksSold = 0;
    state.totalTips = 0;
    state.likes = 0;
    state.follows = 0;
    state.comments = 0;
    state.gifts = 0;
    state.totalCoins = 0;
    state.recentGifts = [];
    state.supporters = {};
    state.recentEvents = [];
    viewerSessions.clear();
    startLiveSession();
    saveState();
    broadcastNotification('shop.reset', { soft: false });
    broadcastNotification('temple.state', getPublicState());
    return getPublicState();
  },

  // ------------------------------------------------ voice character profiles
  getVoiceProfiles() {
    return voiceProfilesSnapshot();
  },

  updateVoiceProfile(params = {}) {
    const id = String(params.profile || params.id || '').trim();
    if (!VOICE_PROFILE_IDS.includes(id)) {
      return { ok: false, error: `Unknown voice profile: ${id || '(none)'}` };
    }
    const profiles = ensureVoiceProfiles();
    const current = profiles[id];
    const patch = params.patch && typeof params.patch === 'object' ? params.patch : params;
    const next = { ...current };

    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if (typeof patch.voice === 'string') next.voice = patch.voice.trim().slice(0, 80);
    if (typeof patch.language === 'string') {
      next.language = patch.language.toLowerCase() === 'vi' ? 'vi' : 'en';
    }
    if (patch.speed !== undefined) {
      next.speed = Math.round(clamp(profileNumber(patch.speed, current.speed), 0.5, 2) * 100) / 100;
    }
    if (patch.volume !== undefined) {
      next.volume = Math.round(clamp(profileNumber(patch.volume, current.volume), 0, 1) * 100) / 100;
    }
    if (id === 'announcer' && typeof patch.mode === 'string' && ANNOUNCER_MODES.includes(patch.mode)) {
      next.mode = patch.mode;
    }

    // A voice that is not in the catalog is kept as configured and resolved to a
    // safe fallback at speak time; settings are never silently rewritten.
    profiles[id] = next;
    state.voiceProfilesSavedAt = new Date().toISOString();
    saveState();
    broadcastNotification('temple.state', getPublicState());
    return { ok: true, id, profile: voiceProfilesSnapshot().profiles[id], voiceProfiles: voiceProfilesSnapshot() };
  },

  resetVoiceProfiles() {
    state.voiceProfiles = normalizeVoiceProfiles(defaultVoiceProfiles());
    state.voiceProfilesSavedAt = new Date().toISOString();
    sellerTurn = 0;
    announcerTurn = 0;
    saveState();
    broadcastNotification('temple.state', getPublicState());
    return { ok: true, voiceProfiles: voiceProfilesSnapshot() };
  },

  // Speak one line through an exact profile (Admin test buttons + customer route).
  async testVoiceProfile(params = {}) {
    const id = String(params.profile || params.id || '').trim();
    if (!VOICE_PROFILE_IDS.includes(id)) {
      return { ok: false, error: `Unknown voice profile: ${id || '(none)'}` };
    }
    const profiles = ensureVoiceProfiles();
    const requested = profiles[id];
    if (requested.enabled === false) {
      return { ok: false, error: `${VOICE_PROFILE_META[id].label} is disabled` };
    }
    // Testing profile C must exercise its configured mode (male/female/alternate/random),
    // not silently fall back to the announcer profile's own defaults.
    const profile = id === 'announcer' ? activeProfileForRole('announcer') || requested : requested;
    const resolved = resolveProfileVoice(profile);
    const text = String(params.text || '').trim().slice(0, 220);
    if (!text) return { ok: false, error: 'Empty preview text' };
    const result = await piperTts.synthesize(text, {
      voice: resolved.voice,
      language: resolved.language,
      speed: profile.speed
    });
    if (!result.ok) return { ...result, profile: id };
    const payload = {
      text,
      voice: result.voice,
      language: result.language,
      speed: result.speed,
      volume: profile.volume,
      profile: id,
      url: result.url
    };
    if (params.broadcast !== false) broadcastNotification('tts.play', payload);
    return {
      ...result,
      profile: id,
      resolvedProfile: profile.id,
      profileLabel: VOICE_PROFILE_META[id].label,
      speed: profile.speed,
      volume: profile.volume,
      missingVoice: resolved.missing ? resolved.configured : ''
    };
  }
};

// ============================================================================
// 6. TIKTOK LIVE CONNECTOR & COMMENT PARSER
// ============================================================================
let tiktokConn = null;
const commentCooldownMap = new Map();
const giftComboTracker = new Map();

const DRINK_KEYWORDS = [
  { words: ['lemonade', 'lemon'], id: 'lemonade' },
  { words: ['coffee', 'latte', 'mocha', 'espresso'], id: 'iced-coffee' },
  { words: ['orange', 'soda', 'fanta'], id: 'orange-soda' },
  { words: ['smoothie', 'berry', 'strawberry', 'mango'], id: 'smoothie' },
  { words: ['slush', 'blue', 'icee', 'freeze'], id: 'slushie' },
  { words: ['cola', 'coke', 'pepsi', 'float'], id: 'cola' }
];

function parseViewerComment(commentText, user, uniqueId, avatar) {
  const raw = String(commentText || '').trim();
  if (!raw || isBlockedSpamOrToxic(raw)) return null;

  const cleanOrder = sanitizeOrderText(raw);
  if (!cleanOrder) return null;

  const userKey = uniqueId || user || '';
  const now = Date.now();
  if (userKey) {
    const lastTs = commentCooldownMap.get(userKey) || 0;
    if (now - lastTs < 3000) return null;
    commentCooldownMap.set(userKey, now);
    if (commentCooldownMap.size > 800) {
      const oldestKey = commentCooldownMap.keys().next().value;
      commentCooldownMap.delete(oldestKey);
    }
  }

  const lower = cleanOrder.toLowerCase();
  const request = { user, uniqueId, avatar, order: cleanOrder };

  if (/\b(follow|following|followed)\b/.test(lower)) {
    return Actions.followGuest(request);
  }
  if (/\b(love|like|heart|hearts)\b/.test(lower)) {
    return Actions.likeBurst({ ...request, count: 3 });
  }

  const matched = DRINK_KEYWORDS.find((entry) => entry.words.some((word) => lower.includes(word)));
  if (matched) {
    return Actions.commentOrder({ ...request, drinkId: matched.id });
  }

  return Actions.commentOrder(request);
}

async function resolveTikTokUsername(rawInput) {
  let input = String(rawInput || '').trim();
  if (!input) {
    throw new Error('Please enter a TikTok @username or live link to connect');
  }
  if (input.startsWith('http://') || input.startsWith('https://') || input.includes('tiktok.com/')) {
    const urlToFetch = input.startsWith('http') ? input : `https://${input}`;
    const directMatch = urlToFetch.match(/tiktok\.com\/@([^/?#]+)/i);
    if (directMatch && directMatch[1]) return directMatch[1];
    try {
      const resp = await fetch(urlToFetch, { redirect: 'follow' });
      const finalUrl = resp.url || '';
      const resolvedMatch = finalUrl.match(/tiktok\.com\/@([^/?#]+)/i);
      if (resolvedMatch && resolvedMatch[1]) return resolvedMatch[1];
    } catch (e) {
      console.warn('[TikTok URL Resolve Warning]', e.message);
    }
  }
  return input.replace(/^@/, '').split(/[/?#]/)[0].trim();
}

function extractUserFromEvent(data) {
  const u = data?.user || data || {};
  const uniqueId = u.uniqueId || u.displayId || data?.uniqueId || '';
  const user = u.nickname || uniqueId || data?.nickname || 'Guest';
  const avatar =
    u.profilePictureUrl ||
    u.avatarLarge?.urlList?.[0] ||
    u.avatarThumb?.urlList?.[0] ||
    u.avatarMedium?.urlList?.[0] ||
    data?.profilePictureUrl ||
    '';
  return { user, uniqueId, avatar };
}

const TIKTOK_RECONNECT_MAX = 5;
let tiktokReconnectTimer = null;
let tiktokManualClose = false;

function tiktokErrorText(err) {
  if (!err) return 'Unknown TikTok connection error';
  if (typeof err === 'string') return err;
  const candidates = [err.message, err.info, err.reason, err.code, err.cause && err.cause.message];
  const parts = [];
  for (const value of candidates) {
    if (!value) continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text && !parts.includes(text)) parts.push(text);
  }
  const text = (parts.join(' · ') || String(err))
    .replace(/Â·/g, '·')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 400 ? `${text.slice(0, 397)}…` : text;
}

function tiktokSnapshot() {
  const t = state.tiktok || {};
  const connected = Boolean(t.connected);
  return {
    connected,
    connecting: Boolean(t.connecting),
    reconnecting: Boolean(t.reconnecting),
    status: t.status || (connected ? 'connected' : 'disconnected'),
    username: t.username || '',
    roomId: t.roomId || null,
    viewerCount: Number(t.viewerCount) || 0,
    connectedAt: t.connectedAt || null,
    durationMs: t.connectedAt ? Math.max(0, Date.now() - t.connectedAt) : 0,
    attempts: Number(t.attempts) || 0,
    lastEvent: t.lastEvent || null,
    lastError: t.lastError || null
  };
}

function setTikTokState(patch, options = {}) {
  state.tiktok = { ...state.tiktok, ...patch };
  if (options.broadcast !== false) broadcastNotification('temple.state', getPublicState());
  return tiktokSnapshot();
}

function scheduleTikTokReconnect() {
  if (tiktokManualClose) return;
  const attempts = (Number(state.tiktok.attempts) || 0) + 1;
  if (attempts > TIKTOK_RECONNECT_MAX) {
    setTikTokState({
      connected: false,
      connecting: false,
      reconnecting: false,
      status: 'error',
      attempts,
      connectedAt: null,
      lastError: 'TikTok LIVE connection was lost and could not be restored. Press Connect to try again.'
    });
    console.warn('[TikTok Reconnect] Giving up after', TIKTOK_RECONNECT_MAX, 'attempts');
    return;
  }
  const delay = Math.min(30000, 4000 * attempts);
  setTikTokState({
    connected: false,
    connecting: false,
    reconnecting: true,
    status: 'reconnecting',
    attempts,
    connectedAt: null,
    lastError: `Connection lost. Reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempts}/${TIKTOK_RECONNECT_MAX})…`
  });
  tiktokReconnectTimer = setTimeout(() => {
    tiktokReconnectTimer = null;
    const target = state.tiktok.username;
    if (!target || tiktokManualClose) return;
    connectTikTokLive(target, { auto: true }).catch((err) => {
      console.warn('[TikTok Reconnect] Attempt failed:', tiktokErrorText(err));
    });
  }, delay);
}

async function connectTikTokLive(rawInput, options = {}) {
  // A second click must never start a parallel connection attempt.
  if (state.tiktok.connecting) {
    throw new Error(`Already connecting to @${state.tiktok.username || 'TikTok'}. Wait for that attempt to finish.`);
  }

  const cleanUser = await resolveTikTokUsername(rawInput);
  if (!/^[A-Za-z0-9._]{2,32}$/.test(cleanUser)) {
    const message = `"${cleanUser}" is not a valid TikTok username. Use the @username exactly as it appears in the TikTok app.`;
    setTikTokState({
      connected: false,
      connecting: false,
      reconnecting: false,
      status: 'error',
      connectedAt: null,
      lastError: message
    });
    throw new Error(message);
  }

  if (tiktokReconnectTimer) {
    clearTimeout(tiktokReconnectTimer);
    tiktokReconnectTimer = null;
  }
  tiktokManualClose = false;

  if (tiktokConn) {
    try {
      if (typeof tiktokConn.removeAllListeners === 'function') tiktokConn.removeAllListeners();
      await Promise.resolve(tiktokConn.disconnect()).catch(() => {});
    } catch (_) {}
    tiktokConn = null;
  }

  setTikTokState({
    connected: false,
    connecting: true,
    reconnecting: false,
    status: 'connecting',
    username: cleanUser,
    roomId: null,
    viewerCount: 0,
    connectedAt: null,
    lastError: null,
    lastEvent: options.auto ? state.tiktok.lastEvent : null,
    attempts: options.auto ? Number(state.tiktok.attempts) || 0 : 0
  });
  console.log(`[TikTok Live] Connecting to @${cleanUser}…`);

  const signApiKey = process.env.EULER_API_KEY || process.env.TIKTOK_SIGN_API_KEY || undefined;
  // enableExtendedGiftInfo triggers Euler Stream's premium gift-gallery route,
  // which rejects the connection with "This endpoint requires a Business plan".
  // Gift coin values still arrive on data.gift.diamondCount, so it is not needed.
  const connOptions = {
    processInitialData: true,
    fetchRoomInfoOnConnect: false,
    enableExtendedGiftInfo: false
  };
  if (signApiKey) connOptions.signApiKey = signApiKey;

  tiktokConn = new TikTokLiveConnection(cleanUser, connOptions);
  const conn = tiktokConn;

  const safeOn = (eventName, handler) => {
    if (!eventName) return;
    conn.on(eventName, (...args) => {
      try {
        handler(...args);
      } catch (err) {
        console.warn('[TikTok Handler Warning]', tiktokErrorText(err));
      }
    });
  };

  const recordEvent = (type, data, detail = '') => {
    const { user, uniqueId } = extractUserFromEvent(data || {});
    state.tiktok.lastEvent = {
      type,
      user: user || uniqueId || 'viewer',
      uniqueId: uniqueId || '',
      detail: String(detail || '').slice(0, 120),
      at: Date.now()
    };
  };

  safeOn(ControlEvent.CONNECTED, (roomState) => {
    setTikTokState({
      connected: true,
      connecting: false,
      reconnecting: false,
      status: 'connected',
      roomId: roomState?.roomId || conn.roomId || null,
      connectedAt: Date.now(),
      attempts: 0,
      lastError: null
    });
    console.log(`[TikTok Live] Connected to @${cleanUser} (roomId: ${state.tiktok.roomId})`);
  });

  safeOn(ControlEvent.DISCONNECTED, () => {
    const wasConnected = Boolean(state.tiktok.connected);
    console.log(`[TikTok Live] Disconnected from @${cleanUser}`);
    if (tiktokManualClose) {
      setTikTokState({
        connected: false,
        connecting: false,
        reconnecting: false,
        status: 'disconnected',
        connectedAt: null,
        roomId: null,
        viewerCount: 0
      });
      return;
    }
    if (wasConnected || state.tiktok.status === 'connected') {
      setTikTokState({ connected: false, connectedAt: null, roomId: null, viewerCount: 0 });
      scheduleTikTokReconnect();
      return;
    }
    setTikTokState({
      connected: false,
      connecting: false,
      reconnecting: false,
      status: state.tiktok.status === 'error' ? 'error' : 'disconnected'
    });
  });

  safeOn(ControlEvent.ERROR, (err) => {
    const message = tiktokErrorText(err);
    console.warn('[TikTok Live Warning]', message);
    setTikTokState({ lastError: message });
  });

  safeOn(WebcastEvent.ROOM_USER, (data) => {
    const viewerCount = Number(data?.total ?? data?.viewerCount ?? 0);
    if (viewerCount > 0) {
      state.tiktok.viewerCount = viewerCount;
      broadcastNotification('temple.viewerCount', { viewerCount });
    }
  });

  safeOn(WebcastEvent.MEMBER, (data) => {
    const { user, uniqueId, avatar } = extractUserFromEvent(data);
    recordEvent('MEMBER', data);
    Actions.viewerJoin({ user, uniqueId, avatar });
  });

  safeOn(WebcastEvent.CHAT, (data) => {
    const { user, uniqueId, avatar } = extractUserFromEvent(data);
    const commentText = data?.content || data?.comment || '';
    recordEvent('CHAT', data, commentText);
    console.log(`[TikTok Chat] ${user}: ${commentText}`);
    parseViewerComment(commentText, user, uniqueId, avatar);
  });

  safeOn(WebcastEvent.LIKE, (data) => {
    const { user, uniqueId, avatar } = extractUserFromEvent(data);
    const likeCount = Math.min(15, Math.max(1, Number(data?.count ?? data?.likeCount ?? 1)));
    recordEvent('LIKE', data, `${likeCount} likes`);
    Actions.likeBurst({ user, uniqueId, avatar, count: likeCount });
  });

  const handleFollow = (data) => {
    const { user, uniqueId, avatar } = extractUserFromEvent(data);
    recordEvent('FOLLOW', data);
    Actions.followGuest({ user, uniqueId, avatar, readTts: false });
  };
  safeOn(WebcastEvent.FOLLOW, handleFollow);
  safeOn(WebcastEvent.SHARE, handleFollow);
  safeOn(WebcastEvent.SOCIAL, (data) => {
    const action = String(data?.action || '');
    const disp = String(data?.common?.displayText?.displayType || data?.displayType || '').toLowerCase();
    if (action === '1' || action === '3' || disp.includes('follow') || disp.includes('share')) {
      handleFollow(data);
    }
  });

  safeOn(WebcastEvent.GIFT, (data) => {
    const { user, uniqueId, avatar } = extractUserFromEvent(data);
    const giftObj = data?.gift || data?.giftDetails || {};
    const giftId = String(data?.giftId || giftObj?.id || 'cup');
    const groupId = String(data?.groupId || `${uniqueId}_${giftId}`);
    const repeatCount = Math.max(1, Number(data?.repeatCount || data?.comboCount || 1));

    const prevCount = giftComboTracker.get(groupId) || 0;
    if (repeatCount <= prevCount && data?.repeatEnd) {
      giftComboTracker.delete(groupId);
      return;
    }
    const deltaCount = Math.max(1, repeatCount - prevCount);
    giftComboTracker.set(groupId, repeatCount);
    if (giftComboTracker.size > 500) {
      const firstKey = giftComboTracker.keys().next().value;
      giftComboTracker.delete(firstKey);
    }

    const extended = data?.extendedGiftInfo || {};
    // TikTok sends the per-gift coin value as diamondCount on the gift object
    // (and in extendedGiftInfo when the room provides it).
    const giftCoins = Math.max(
      1,
      Number(
        giftObj?.diamondCount ||
          giftObj?.diamond_count ||
          extended?.diamondCount ||
          extended?.diamond_count ||
          data?.diamondCount ||
          data?.diamond_count ||
          0
      ) || 1
    );
    const rawGiftName = giftObj?.name || data?.giftName || giftObj?.describe || 'Gift';
    const rawGiftId = data?.giftId || giftObj?.id || giftObj?.giftId || rawGiftName;
    const tier = coinTier(giftCoins);
    const displayGiftName = deltaCount > 1 ? `${deltaCount}x ${rawGiftName}` : rawGiftName;
    recordEvent('GIFT', data, displayGiftName);

    if (!tier) {
      console.log(
        `[TikTok Gift] ${user} sent ${displayGiftName} (giftId=${rawGiftId}, ${giftCoins} coins) → no drink configured for this value, ignored`
      );
      return;
    }

    console.log(
      `[TikTok Gift] ${user} sent ${displayGiftName} · ${giftCoins} coins → ${tier.drinkId} · ${deltaCount} order(s)`
    );

    // deltaCount only counts new combo repeats, so combo updates never duplicate customers.
    Actions.giftOrder({
      user,
      uniqueId,
      avatar,
      coins: giftCoins,
      giftName: rawGiftName,
      units: deltaCount
    });
  });

  // Check liveness first: it turns TikTok's opaque signing error into a clear
  // "account is not live" message and avoids pointless websocket attempts.
  let liveCheck = null;
  try {
    liveCheck = await conn.fetchIsLive();
  } catch (err) {
    console.warn('[TikTok Live] Liveness check failed:', tiktokErrorText(err));
  }

  if (liveCheck === false) {
    const message = `@${cleanUser} is not LIVE right now. Start a TikTok LIVE on that account, then press Connect again.`;
    try {
      if (typeof conn.removeAllListeners === 'function') conn.removeAllListeners();
      await Promise.resolve(conn.disconnect()).catch(() => {});
    } catch (_) {}
    if (tiktokConn === conn) tiktokConn = null;
    setTikTokState({
      connected: false,
      connecting: false,
      reconnecting: false,
      status: 'error',
      connectedAt: null,
      viewerCount: 0,
      lastError: message
    });
    throw new Error(message);
  }

  try {
    const roomState = await conn.connect();
    setTikTokState({
      connected: true,
      connecting: false,
      reconnecting: false,
      status: 'connected',
      roomId: roomState?.roomId || conn.roomId || null,
      connectedAt: state.tiktok.connectedAt || Date.now(),
      attempts: 0,
      lastError: null
    });
    return tiktokSnapshot();
  } catch (err) {
    const message = tiktokErrorText(err);
    const offline = /not live|isn't online|is not online|offline/i.test(message);
    setTikTokState({
      connected: false,
      connecting: false,
      reconnecting: false,
      status: 'error',
      connectedAt: null,
      lastError: offline
        ? `@${cleanUser} is not LIVE right now. Start a TikTok LIVE on that account, then press Connect again.`
        : message
    });
    if (options.auto && !offline && !tiktokManualClose) scheduleTikTokReconnect();
    throw new Error(state.tiktok.lastError);
  }
}

function disconnectTikTokLive() {
  tiktokManualClose = true;
  if (tiktokReconnectTimer) {
    clearTimeout(tiktokReconnectTimer);
    tiktokReconnectTimer = null;
  }
  if (tiktokConn) {
    const conn = tiktokConn;
    try {
      if (typeof conn.removeAllListeners === 'function') conn.removeAllListeners();
      Promise.resolve(conn.disconnect()).catch(() => {});
    } catch (_) {}
    tiktokConn = null;
  }
  setTikTokState({
    connected: false,
    connecting: false,
    reconnecting: false,
    status: 'disconnected',
    roomId: null,
    viewerCount: 0,
    connectedAt: null,
    attempts: 0
  });
  return tiktokSnapshot();
}

// ============================================================================
// 7. AUTO-SIMULATION (keeps the shop busy while you test the scene)
// ============================================================================
let autoSimTimer = null;
const SIM_VIEWERS = [
  { user: 'Mia Carter', uniqueId: 'mia.carter', note: 'One lemonade please, extra ice!' },
  { user: 'Dylan Brooks', uniqueId: 'dylanbrooks', note: 'Iced coffee, big order for the crew' },
  { user: 'Ava Sinclair', uniqueId: 'ava_sinclair', note: 'Berry smoothie for me and my sister' },
  { user: 'Grandpa Joe', uniqueId: 'grandpa.joe', note: 'Classic cola, no ice' },
  { user: 'Tyler Nguyen', uniqueId: 'tyler.n', note: 'Orange soda and a slushie to go' },
  { user: 'Sofia Ramos', uniqueId: 'sofiaramos', note: 'Surprise me with the mystery sip!' }
];

function runSingleSimulationStep() {
  const pick = SIM_VIEWERS[Math.floor(Math.random() * SIM_VIEWERS.length)];
  const roll = Math.random();
  if (roll < 0.4) {
    Actions.commentOrder({ user: pick.user, uniqueId: pick.uniqueId, order: pick.note });
  } else if (roll < 0.6) {
    Actions.likeBurst({ user: pick.user, uniqueId: pick.uniqueId, count: 3 });
  } else if (roll < 0.78) {
    Actions.followGuest({ user: pick.user, uniqueId: pick.uniqueId, readTts: false });
  } else if (roll < 0.92) {
    Actions.mysteryDrink({ user: pick.user, uniqueId: pick.uniqueId });
  } else {
    const tier = COIN_MENU[Math.floor(Math.random() * COIN_MENU.length)];
    Actions.giftOrder({ user: pick.user, uniqueId: pick.uniqueId, coins: tier.coins, units: 1 });
  }
}

function configureAutoSim(enabled) {
  state.settings.autoSim = Boolean(enabled);
  if (autoSimTimer) {
    clearInterval(autoSimTimer);
    autoSimTimer = null;
  }
  if (state.settings.autoSim) {
    runSingleSimulationStep();
    autoSimTimer = setInterval(runSingleSimulationStep, state.settings.autoSimIntervalMs || 9000);
  }
}

// ============================================================================
// 8. JSON-RPC 2.0 DISPATCHER (legacy temple.* names are kept as aliases)
// ============================================================================
async function handleRpcCall(method, params = {}) {
  switch (method) {
    case 'temple.getState':
    case 'shop.getState':
    case 'game.getState':
      return getPublicState();

    case 'temple.burnIncense':
    case 'shop.serveDrink':
      return Actions.serveDrink(params);

    case 'temple.strikeWoodenFish':
    case 'shop.like':
      return Actions.likeBurst(params);

    case 'temple.ringBell':
    case 'shop.follow':
      return Actions.followGuest(params);

    case 'temple.sendPrayer':
    case 'shop.freeDrink':
      return Actions.freeDrink(params);

    case 'temple.offerGift':
      return Actions.partyOrder(params);

    case 'shop.gift':
    case 'shop.giftOrder':
    case 'shop.sendGift':
    case 'game.giftOrder':
      return Actions.giftOrder(params);

    case 'temple.drawFortune':
    case 'shop.mysteryDrink':
      return Actions.mysteryDrink(params);

    case 'temple.grandCeremony':
      return Actions.partyOrder({
        ...params,
        coins: Math.max(100, Number(params.coins) || 199),
        giftName: params.giftName || 'Block Party Tray'
      });

    case 'temple.updateSettings':
    case 'shop.setSettings':
      return Actions.updateSettings(params);

    case 'temple.resetMerit':
    case 'shop.reset':
    case 'game.reset':
      return Actions.resetGame();

    case 'temple.comment':
    case 'shop.comment':
      return parseViewerComment(params.comment, params.user, params.uniqueId, params.avatar);

    case 'shop.start':
    case 'game.start':
      return Actions.startGame();

    case 'shop.pause':
    case 'game.pause':
      return Actions.pauseGame(params);

    case 'shop.resume':
    case 'game.resume':
      return Actions.resumeGame();

    case 'shop.setSpawnRate':
    case 'game.setSpawnRate':
      return Actions.setSpawnRate(params.rate ?? params.value);

    case 'shop.spawnCustomer':
    case 'game.spawnCustomer':
      return Actions.spawnCustomer(params);

    case 'temple.speak':
    case 'shop.speak': {
      // Optional profile routing: { profile: 'customer' | 'maleSeller' | ... }
      let speed = params.speed;
      let language = params.language;
      let voice = params.voice;
      let volume;
      let profileId = '';
      if (params.profile && VOICE_PROFILE_IDS.includes(String(params.profile))) {
        profileId = String(params.profile);
        const snapshot = voiceProfilesSnapshot().profiles[profileId];
        if (!snapshot || snapshot.enabled === false) {
          return { ok: false, error: `${VOICE_PROFILE_META[profileId].label} is disabled` };
        }
        voice = snapshot.resolvedVoice || voice;
        language = snapshot.language;
        speed = snapshot.speed;
        volume = snapshot.volume;
      }
      const res = await piperTts.synthesize(params.text, { voice, language, speed });
      if (res.ok && params.broadcast !== false) {
        broadcastNotification('tts.play', {
          text: params.text,
          voice: res.voice,
          language: res.language,
          speed: res.speed,
          volume,
          profile: profileId,
          url: res.url
        });
      }
      return res;
    }

    case 'voice.getProfiles':
    case 'shop.voiceProfiles':
      return voiceProfilesSnapshot();

    case 'voice.updateProfile':
      return Actions.updateVoiceProfile(params);

    case 'voice.resetProfiles':
      return Actions.resetVoiceProfiles();

    case 'voice.test':
      return Actions.testVoiceProfile(params);

    case 'temple.ttsStatus':
    case 'shop.ttsStatus':
      return piperTts.getStatus();

    case 'tts.refreshVoices':
    case 'temple.refreshVoices':
    case 'shop.refreshVoices':
      return piperTts.refreshVoices('rpc');

    case 'tts.voices':
    case 'shop.ttsVoices':
      return piperTts.getCatalog();

    case 'shop.giftMap':
      return coinMenuEntries();

    case 'shop.join':
    case 'live.join':
      return Actions.viewerJoin(params);

    case 'shop.leave':
    case 'live.leave':
      return Actions.viewerLeave(params);

    case 'shop.viewerServed':
    case 'live.viewerServed':
      return Actions.viewerServed(params);

    case 'shop.viewers':
    case 'live.viewers':
      return Actions.viewerRoster();

    case 'shop.testVip':
    case 'live.testVip':
      return Actions.testVip(params);

    case 'shop.testCelebration':
    case 'live.testCelebration':
      return Actions.testVip({ ...params, kind: 'celebration' });

    case 'live.connect':
      return await connectTikTokLive(params.username);

    case 'live.disconnect':
      return disconnectTikTokLive();

    case 'live.status':
      return tiktokSnapshot();

    case 'live.setAutoSim':
      configureAutoSim(Boolean(params.enabled));
      saveState();
      broadcastNotification('temple.state', getPublicState());
      return getPublicState();

    default:
      throw new Error(`Unknown JSON-RPC method: ${method}`);
  }
}

// ============================================================================
// 9. EXPRESS + WEBSOCKET SERVER
// ============================================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/tts-cache', express.static(TTS_CACHE_DIR, { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/rpc', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  if (!method) {
    return res.status(400).json({
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code: -32600, message: 'Invalid JSON-RPC request: method is required' }
    });
  }
  try {
    const result = await handleRpcCall(method, params || {});
    res.json({ jsonrpc: jsonrpc || '2.0', id: id ?? null, result });
  } catch (err) {
    res.status(200).json({
      jsonrpc: jsonrpc || '2.0',
      id: id ?? null,
      error: { code: -32000, message: err.message || 'Server error' }
    });
  }
});

app.get('/api/tts/voices', (req, res) => {
  const fresh = String(req.query?.refresh || '') === '1';
  res.json(fresh ? piperTts.refreshVoices('http') : piperTts.getCatalog());
});

app.all('/api/tts', async (req, res) => {
  const body = req.body || {};
  const text = String(body.text || req.query?.text || '').trim();
  if (!text) {
    return res.status(400).json({ ok: false, error: 'Text is required' });
  }
  const result = await piperTts.synthesize(text, {
    voice: body.voice || req.query?.voice,
    language: body.language || req.query?.language,
    speed: body.speed ?? req.query?.speed
  });
  res.json(result);
});

app.get('/api/state', (_req, res) => {
  res.json(getPublicState());
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcastNotification(method, params) {
  const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'temple.state', params: getPublicState() }));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch (_) {
      return;
    }
    if (!msg || !msg.method) return;
    try {
      const result = await handleRpcCall(msg.method, msg.params || {});
      if (msg.id !== undefined) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      }
    } catch (err) {
      if (msg.id !== undefined) {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: err.message || 'RPC error' }
          })
        );
      }
    }
  });
});

const piperTts = new PiperTTSManager();
if (!piperTts.listVoices().some((voice) => voice.id === state.settings.ttsVoice)) {
  state.settings.ttsVoice = piperTts.defaultVoice(state.settings.ttsLanguage) || state.settings.ttsVoice;
}

server.listen(PORT, () => {
  console.log('============================================================');
  console.log(`🥤 ${SHOP_NAME} — TikTok Live Drink Shop is running`);
  console.log(`📺 Live screen (9:16 OBS) : http://localhost:${PORT}`);
  console.log(`🎛️ Admin control panel    : http://localhost:${PORT}/admin`);
  console.log(`🔌 JSON-RPC 2.0           : http://localhost:${PORT}/rpc`);
  console.log(`🔌 WebSocket              : ws://localhost:${PORT}/ws`);
  console.log('============================================================');

  const defaultChannel = process.env.TIKTOK_USER || '';
  if (defaultChannel) {
    connectTikTokLive(defaultChannel, { auto: true }).catch((err) => {
      console.warn(`[Auto-Connect @${defaultChannel}] Not connected yet:`, err.message);
    });
  }
});
