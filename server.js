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
function prettyVoiceName(stem) {
  const cleaned = String(stem || '')
    .replace(/^(en_US|en_GB|vi_VN)-/i, '')
    .replace(/\b(medium|low|high|x_low)\b/gi, '')
    .replace(/[_-]+/g, ' ')
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
    this.cacheVoices = this.scanVoices();
    this.exe = this.resolvePiperExe();
    this.startWorker();
  }

  // Local models only: config/piper/<language>/<name>.onnx + <name>.onnx.json
  scanVoices() {
    const found = [];
    // Vietnamese models live in config/piper/vn and are exposed as language "vi".
    for (const folder of ['en', 'vi', 'vn']) {
      const dir = path.join(this.modelsRoot, folder);
      const language = folder === 'vn' ? 'vi' : folder;
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!/\.onnx$/i.test(file)) continue;
        const modelPath = path.join(dir, file);
        const configPath = `${modelPath}.json`;
        if (!fs.existsSync(configPath)) continue;
        let config = {};
        try {
          config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (_) {
          config = {};
        }
        const id = file.replace(/\.onnx$/i, '');
        found.push({
          id,
          language,
          name: prettyVoiceName(id),
          sampleRate: (config.audio && config.audio.sample_rate) || 22050,
          espeak: (config.espeak && config.espeak.voice) || language,
          path: modelPath
        });
      }
    }
    return found;
  }

  listVoices() {
    return this.workerVoices.length ? this.workerVoices : this.cacheVoices;
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
    const voices = this.listVoices().map((voice) => ({
      id: voice.id,
      language: voice.language,
      name: voice.name,
      sampleRate: voice.sampleRate
    }));
    return {
      ready: this.ready,
      status: this.status,
      engine: 'Piper (local ONNX voices)',
      version: this.version,
      executable: this.exe,
      executableKind: this.exeKind,
      modelsRoot: this.modelsRoot,
      languages: ['en', 'vi'],
      language: state.settings.ttsLanguage,
      voice: state.settings.ttsVoice,
      speed: state.settings.ttsSpeed,
      volume: state.settings.ttsVolume,
      voices,
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
    autoSim: false,
    autoSimIntervalMs: 9000
  },
  tiktok: {
    connected: false,
    connecting: false,
    username: process.env.TIKTOK_USER || 'zenfacts_vn',
    roomId: null,
    viewerCount: 0,
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
      settings: state.settings
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

function getLeaderboard(limit = 6) {
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
    recentEvents: state.recentEvents.slice(0, 12),
    settings: state.settings,
    tiktok: state.tiktok,
    tts: piperTts.getStatus()
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

    const ttsText =
      params.readTts === false
        ? ''
        : speakLine(
            `Order up! ${count > 1 ? count + ' ' + drink.name : drink.name} for ${supporter.name}.`,
            `Đơn hàng đây! ${count > 1 ? count + ' ly ' + drink.name : drink.name} cho ${supporter.name}.`
          );

    const event = pushEventLog({
      type: 'serveDrink',
      user: supporter.name,
      uniqueId: supporter.uniqueId,
      avatar: supporter.avatar,
      drink,
      count,
      tip,
      message: note,
      vip: Boolean(params.vip),
      ttsText,
      ttsVoice: state.settings.ttsVoice,
      ttsLanguage: state.settings.ttsLanguage,
      ttsSpeed: state.settings.ttsSpeed
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

    const event = pushEventLog({
      type: 'likeBurst',
      user: supporter.name,
      uniqueId: supporter.uniqueId,
      avatar: supporter.avatar,
      count,
      tip,
      ttsText: '',
      ttsVoice: state.settings.ttsVoice,
      ttsLanguage: state.settings.ttsLanguage,
      ttsSpeed: state.settings.ttsSpeed
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

    const ttsText =
      params.readTts === false
        ? ''
        : speakLine(
            `${supporter.name} just followed! Free ${drink.name}, on the house.`,
            `${supporter.name} vừa theo dõi tiệm! Tặng bạn một ly ${drink.name} miễn phí.`
          );

    const event = pushEventLog({
      type: 'followGuest',
      user: supporter.name,
      uniqueId: supporter.uniqueId,
      avatar: supporter.avatar,
      drink,
      count: 1,
      tip,
      vip: true,
      message: 'New follower: free drink!',
      ttsText,
      ttsVoice: state.settings.ttsVoice,
      ttsLanguage: state.settings.ttsLanguage,
      ttsSpeed: state.settings.ttsSpeed
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

    const event = pushEventLog({
      type: 'giftOrder',
      orderId: giftEntry.id,
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
      ttsVoice: state.settings.ttsVoice,
      ttsLanguage: state.settings.ttsLanguage,
      ttsSpeed: state.settings.ttsSpeed
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

    const ttsText =
      params.readTts === false
        ? ''
        : speakLine(
            `Big order! ${supporter.name} sent ${giftName}. ${groupSize} drinks coming right up!`,
            `Đơn lớn! ${supporter.name} vừa tặng ${giftName}. ${groupSize} ly nước đang được pha.`
          );

    const event = pushEventLog({
      type: 'partyOrder',
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
      ttsVoice: state.settings.ttsVoice,
      ttsLanguage: state.settings.ttsLanguage,
      ttsSpeed: state.settings.ttsSpeed
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

    const ttsText =
      params.readTts === false
        ? ''
        : speakLine(
            `${card.ttsText} Ordered by ${supporter.name}.`,
            `Bí ẩn hôm nay là ${card.title}. ${supporter.name} đã gọi món này.`
          );

    const event = pushEventLog({
      type: 'mysteryDrink',
      user: supporter.name,
      uniqueId: supporter.uniqueId,
      avatar: supporter.avatar,
      drink,
      card,
      count: 1,
      tip,
      message: card.title,
      ttsText,
      ttsVoice: state.settings.ttsVoice,
      ttsLanguage: state.settings.ttsLanguage,
      ttsSpeed: state.settings.ttsSpeed
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

    const ttsText =
      params.readTts === false
        ? ''
        : speakLine(
            `${supporter.name} says: ${text || `one ${drink.name} please`}. Coming right up!`,
            `${supporter.name} nhắn: ${text || `cho tôi một ly ${drink.name}`}. Có ngay ạ!`
          );

    const event = pushEventLog({
      type: 'commentOrder',
      user: supporter.name,
      uniqueId: supporter.uniqueId,
      avatar: supporter.avatar,
      drink,
      count,
      tip,
      message: text,
      ttsText,
      ttsVoice: state.settings.ttsVoice,
      ttsLanguage: state.settings.ttsLanguage,
      ttsSpeed: state.settings.ttsSpeed
    });

    saveState();
    broadcastNotification('temple.event', { event, state: getPublicState() });
    return { event, state: getPublicState() };
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
    saveState();
    broadcastNotification('shop.reset', { soft: false });
    broadcastNotification('temple.state', getPublicState());
    return getPublicState();
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

async function connectTikTokLive(usernameOrUrl) {
  const cleanUser = await resolveTikTokUsername(usernameOrUrl);
  if (!cleanUser) {
    throw new Error('No valid @username found in that input');
  }

  if (tiktokConn) {
    try {
      await tiktokConn.disconnect();
    } catch (_) {}
    tiktokConn = null;
  }

  state.tiktok = {
    connected: false,
    connecting: true,
    username: cleanUser,
    roomId: null,
    viewerCount: 0,
    lastError: null
  };
  broadcastNotification('temple.state', getPublicState());

  tiktokConn = new TikTokLiveConnection(cleanUser, {
    processInitialData: true,
    fetchRoomInfoOnConnect: false,
    enableExtendedGiftInfo: true
  });

  tiktokConn.on(ControlEvent.CONNECTED, (roomState) => {
    state.tiktok.connected = true;
    state.tiktok.connecting = false;
    state.tiktok.roomId = roomState?.roomId || tiktokConn?.roomId || null;
    state.tiktok.lastError = null;
    console.log(`[TikTok Live] Connected to @${cleanUser} (roomId: ${state.tiktok.roomId})`);
    broadcastNotification('temple.state', getPublicState());
  });

  tiktokConn.on(ControlEvent.DISCONNECTED, () => {
    state.tiktok.connected = false;
    state.tiktok.connecting = false;
    console.log(`[TikTok Live] Disconnected from @${cleanUser}`);
    broadcastNotification('temple.state', getPublicState());
  });

  tiktokConn.on(ControlEvent.ERROR, (err) => {
    state.tiktok.lastError = err?.message || String(err);
    console.warn('[TikTok Live Warning]', state.tiktok.lastError);
    broadcastNotification('temple.state', getPublicState());
  });

  tiktokConn.on(WebcastEvent.ROOM_USER, (data) => {
    const viewerCount = Number(data?.total ?? data?.viewerCount ?? 0);
    if (viewerCount > 0) {
      state.tiktok.viewerCount = viewerCount;
      broadcastNotification('temple.viewerCount', { viewerCount });
    }
  });

  tiktokConn.on(WebcastEvent.MEMBER, (data) => {
    const { user, uniqueId, avatar } = extractUserFromEvent(data);
    Actions.newGuest({ user, uniqueId, avatar });
  });

  tiktokConn.on(WebcastEvent.CHAT, (data) => {
    const { user, uniqueId, avatar } = extractUserFromEvent(data);
    const commentText = data?.content || data?.comment || '';
    console.log(`[TikTok Chat] ${user}: ${commentText}`);
    parseViewerComment(commentText, user, uniqueId, avatar);
  });

  tiktokConn.on(WebcastEvent.LIKE, (data) => {
    const { user, uniqueId, avatar } = extractUserFromEvent(data);
    const likeCount = Math.min(15, Math.max(1, Number(data?.count ?? data?.likeCount ?? 1)));
    Actions.likeBurst({ user, uniqueId, avatar, count: likeCount });
  });

  const handleFollow = (data) => {
    const { user, uniqueId, avatar } = extractUserFromEvent(data);
    Actions.followGuest({ user, uniqueId, avatar, readTts: false });
  };
  tiktokConn.on(WebcastEvent.FOLLOW, handleFollow);
  tiktokConn.on(WebcastEvent.SHARE, handleFollow);
  tiktokConn.on(WebcastEvent.SOCIAL, (data) => {
    const action = String(data?.action || '');
    const disp = String(data?.common?.displayText?.displayType || data?.displayType || '').toLowerCase();
    if (action === '1' || action === '3' || disp.includes('follow') || disp.includes('share')) {
      handleFollow(data);
    }
  });

  tiktokConn.on(WebcastEvent.GIFT, (data) => {
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

  try {
    const roomState = await tiktokConn.connect();
    state.tiktok.connected = true;
    state.tiktok.connecting = false;
    state.tiktok.roomId = roomState?.roomId || tiktokConn?.roomId || null;
    broadcastNotification('temple.state', getPublicState());
    return state.tiktok;
  } catch (err) {
    state.tiktok.connected = false;
    state.tiktok.connecting = false;
    state.tiktok.lastError = err?.message || 'Could not connect (is that account live right now?)';
    broadcastNotification('temple.state', getPublicState());
    throw new Error(state.tiktok.lastError);
  }
}

function disconnectTikTokLive() {
  if (tiktokConn) {
    try {
      tiktokConn.disconnect();
    } catch (_) {}
    tiktokConn = null;
  }
  state.tiktok.connected = false;
  state.tiktok.connecting = false;
  state.tiktok.viewerCount = 0;
  broadcastNotification('temple.state', getPublicState());
  return state.tiktok;
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
      const res = await piperTts.synthesize(params.text, {
        voice: params.voice,
        language: params.language,
        speed: params.speed
      });
      if (res.ok && params.broadcast !== false) {
        broadcastNotification('tts.play', {
          text: params.text,
          voice: res.voice,
          language: res.language,
          speed: res.speed,
          url: res.url
        });
      }
      return res;
    }

    case 'temple.ttsStatus':
    case 'shop.ttsStatus':
      return piperTts.getStatus();

    case 'shop.giftMap':
      return coinMenuEntries();

    case 'live.connect':
      return await connectTikTokLive(params.username);

    case 'live.disconnect':
      return disconnectTikTokLive();

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

  const defaultChannel = process.env.TIKTOK_USER || state.tiktok?.username;
  if (defaultChannel) {
    connectTikTokLive(defaultChannel).catch((err) => {
      console.warn(`[Auto-Connect @${defaultChannel}] Not connected yet:`, err.message);
    });
  }
});
