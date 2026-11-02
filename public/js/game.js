/**
 * Sunny Side Sips — 2D cartoon drink shop simulation (1080 x 1920)
 *
 * - Uses only the supplied JPG art in /assets (background, customers, drinks, seller)
 * - White studio backgrounds are flood-filled away from the image border, so enclosed
 *   white clothing (t-shirts, sneakers) stays opaque
 * - Queue slots + table seats + path lanes keep characters from stacking up
 * - Depth sorted rendering, single canvas, no per-frame filters
 */
(function () {
  const ASSETS = window.SHOP_ASSETS;
  if (!ASSETS) {
    console.error('[ShopGame] asset-manifest.js did not load');
    return;
  }

  const W = 1080;
  const H = 1920;
  // Hard caps from the viewer character spec.
  const MAX_CUSTOMERS = 12;
  const MAX_QUEUE = 5;
  const VIEWER_LIMITS = { active: 12, visibleWaiting: 5 };
  const HOLDING_SLOTS = [
    { x: -150, y: 1470 },
    { x: W + 150, y: 1470 }
  ];
  const HOLDING_SLOT_INDEX = 4; // visible waiting slots are queue slots 0-4
  const DRINK_PRICES = {
    lemonade: 5,
    'iced-coffee': 6,
    'orange-soda': 4,
    smoothie: 7,
    slushie: 5,
    cola: 3
  };

  const COLORS = {
    ink: '#3b2a20',
    inkSoft: '#6b5140',
    cream: '#fff7e4',
    cream2: '#ffeccb',
    coral: '#ef5a4b',
    coralDark: '#c93a2c',
    sun: '#ffc94d',
    wood: '#d99b5c',
    woodDark: '#8a5a2b',
    woodLight: '#f2cb93',
    mint: '#45b980'
  };

  const LAYOUT = {
    counter: { x: 452, y: 1004, w: 558, h: 100 },
    sellers: [
      { key: 'female', x: 606, y: 1102 },
      { key: 'male', x: 786, y: 1106 }
    ],
    queueSlots: [
      { x: 592, y: 1246 },
      { x: 706, y: 1274 },
      { x: 820, y: 1302 },
      { x: 934, y: 1330 }
    ],
    overflow: [
      { x: 486, y: 1348 },
      { x: 386, y: 1368 },
      { x: 900, y: 1386 },
      { x: 1010, y: 1408 }
    ],
    tables: [
      { x: 226, y: 1456, umbrella: true },
      { x: 512, y: 1490, umbrella: false },
      { x: 800, y: 1512, umbrella: false },
      { x: 344, y: 1624, umbrella: true },
      { x: 700, y: 1650, umbrella: true }
    ],
    seatSpread: 96,
    seatDrop: 36,
    entries: {
      left: { x: -150, y: 1442 },
      right: { x: W + 150, y: 1418 }
    }
  };

  // --------------------------------------------------------------------------
  // helpers
  // --------------------------------------------------------------------------
  const rand = (min, max) => min + Math.random() * (max - min);
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const round2 = (v) => Math.round(v * 100) / 100;
  const pickOne = (list) => list[Math.floor(Math.random() * list.length)];

  function depthScale(y) {
    return clamp(0.72 + (y - 1150) * 0.00042, 0.7, 1.08);
  }

  function roundedRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  function ellipse(ctx, x, y, rx, ry, fill, stroke, lineWidth) {
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth || 3;
      ctx.stroke();
    }
  }

  function ellipsize(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let out = String(text);
    while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) {
      out = out.slice(0, -1);
    }
    return out + '…';
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Could not load ${src}`));
      img.src = src;
    });
  }

  /**
   * Remove the flat studio background by flood filling inward from the borders.
   * Interior white areas (t-shirt, shoes) are never reached, so they survive.
   * Returns a trimmed offscreen canvas so every character has the same anchor.
   */
  function cutOutBackground(img) {
    const sw = img.naturalWidth || img.width;
    const sh = img.naturalHeight || img.height;
    const full = document.createElement('canvas');
    full.width = sw;
    full.height = sh;
    const ctx = full.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);

    let data;
    try {
      data = ctx.getImageData(0, 0, sw, sh);
    } catch (err) {
      return { canvas: full, w: sw, h: sh };
    }

    const px = data.data;
    const total = sw * sh;
    const visited = new Uint8Array(total);
    const stack = new Int32Array(total);
    let sp = 0;

    const isBackground = (i) => {
      const o = i * 4;
      const r = px[o];
      const g = px[o + 1];
      const b = px[o + 2];
      const mn = Math.min(r, g, b);
      const mx = Math.max(r, g, b);
      return mn >= 229 && mx - mn <= 20;
    };
    const push = (i) => {
      if (i >= 0 && i < total && !visited[i] && isBackground(i)) {
        visited[i] = 1;
        stack[sp++] = i;
      }
    };

    for (let x = 0; x < sw; x++) {
      push(x);
      push((sh - 1) * sw + x);
    }
    for (let y = 0; y < sh; y++) {
      push(y * sw);
      push(y * sw + sw - 1);
    }

    while (sp > 0) {
      const i = stack[--sp];
      px[i * 4 + 3] = 0;
      const x = i % sw;
      const y = (i - x) / sw;
      if (x > 0) push(i - 1);
      if (x < sw - 1) push(i + 1);
      if (y > 0) push(i - sw);
      if (y < sh - 1) push(i + sw);
    }

    let minX = sw;
    let minY = sh;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < sh; y++) {
      const row = y * sw;
      for (let x = 0; x < sw; x++) {
        if (px[(row + x) * 4 + 3] > 12) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0 || maxY < 0) return { canvas: full, w: sw, h: sh };

    const pad = 2;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(sw - 1, maxX + pad);
    maxY = Math.min(sh - 1, maxY + pad);
    const tw = maxX - minX + 1;
    const th = maxY - minY + 1;

    ctx.putImageData(data, 0, 0);
    const trimmed = document.createElement('canvas');
    trimmed.width = tw;
    trimmed.height = th;
    trimmed.getContext('2d').drawImage(full, minX, minY, tw, th, 0, 0, tw, th);
    return { canvas: trimmed, w: tw, h: th };
  }

  // --------------------------------------------------------------------------
  // Game
  // --------------------------------------------------------------------------
  class ShopGame {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.sprites = { customers: [], drinks: [], sellers: {} };
      this.customers = [];
      this.queue = [];
      this.pending = [];
      this.tables = LAYOUT.tables.map((t) => ({
        x: t.x,
        y: t.y,
        umbrella: t.umbrella,
        occupants: [null, null],
        seats: [
          { x: t.x - LAYOUT.seatSpread, y: t.y + LAYOUT.seatDrop },
          { x: t.x + LAYOUT.seatSpread, y: t.y + LAYOUT.seatDrop }
        ]
      }));
      this.session = { served: 0, drinks: 0, tips: 0 };
      this.settings = { running: true, paused: false, spawnRate: 1 };
      this.seq = 0;
      this.spawnTimer = 2400;
      this.time = 0;
      this.lastTs = 0;
      this.tipPops = [];
      this.viewers = new Map();
      this.effects = [];
      this.orderSeq = 0;
      this.onOrderServed = null;
      this.pendingEvents = [];
      this.pendingViewerSync = null;
      this.viewerRoster = null;
      this.viewerSyncTimer = 0;
      this.servingId = null;
      this.serveFlash = 0;
      this.ready = false;
      this.onSale = null;
      this.loop = this.loop.bind(this);
      this.raf = null;
    }

    async load() {
      const customerJobs = ASSETS.customers.map((meta) =>
        loadImage(meta.src)
          .then((img) => ({ meta, sprite: cutOutBackground(img) }))
          .catch((err) => {
            console.warn('[ShopGame]', err.message);
            return null;
          })
      );
      const drinkJobs = ASSETS.drinks.map((meta) =>
        loadImage(meta.src)
          .then((img) => ({ id: meta.id, name: meta.name, sprite: cutOutBackground(img) }))
          .catch((err) => {
            console.warn('[ShopGame]', err.message);
            return null;
          })
      );
      const sellerJobs = Object.keys(ASSETS.sellers).map((key) =>
        loadImage(ASSETS.sellers[key])
          .then((img) => ({ key, sprite: cutOutBackground(img) }))
          .catch((err) => {
            console.warn('[ShopGame]', err.message);
            return null;
          })
      );

      const [customers, drinks, sellers] = await Promise.all([
        Promise.all(customerJobs),
        Promise.all(drinkJobs),
        Promise.all(sellerJobs)
      ]);

      this.sprites.customers = customers.filter(Boolean);
      this.sprites.drinks = drinks.filter(Boolean);
      sellers.filter(Boolean).forEach((s) => {
        this.sprites.sellers[s.key] = s.sprite;
      });

      if (!this.sprites.customers.length || !this.sprites.drinks.length) {
        console.error('[ShopGame] Customer or drink art failed to load');
      }

      this.ready = true;
      this.lastTs = 0;
      if (this.pendingViewerSync) {
        const list = this.pendingViewerSync;
        this.pendingViewerSync = null;
        this.syncViewers(list);
      }
      if (this.pendingEvents.length) {
        const queued = this.pendingEvents;
        this.pendingEvents = [];
        queued.forEach((ev) => this.handleEvent(ev));
      }
      if (!this.raf) this.raf = requestAnimationFrame(this.loop);
      return this;
    }

    // ---------------------------------------------------------------- controls
    setPaused(paused) {
      this.settings.paused = Boolean(paused);
    }

    setRunning(running) {
      this.settings.running = Boolean(running);
    }

    setSpawnRate(rate) {
      this.settings.spawnRate = clamp(Number(rate) || 1, 0.25, 3);
    }

    applySettings(settings = {}) {
      if (typeof settings.paused === 'boolean') this.settings.paused = settings.paused;
      if (typeof settings.running === 'boolean') this.settings.running = settings.running;
      if (typeof settings.spawnRate === 'number') this.setSpawnRate(settings.spawnRate);
    }

    reset() {
      this.customers = [];
      this.queue = [];
      this.pending = [];
      this.tipPops = [];
      this.viewers.clear();
      this.effects = [];
      this.orderSeq = 0;
      this.servingId = null;
      this.serveFlash = 0;
      this.session = { served: 0, drinks: 0, tips: 0 };
      this.spawnTimer = 1800;
      this.tables.forEach((t) => {
        t.occupants = [null, null];
      });
    }

    getStats() {
      return {
        served: this.session.served,
        drinks: this.session.drinks,
        tips: round2(this.session.tips),
        queue: this.queue.length,
        tables: this.tables.reduce((sum, t) => sum + t.occupants.filter(Boolean).length, 0),
        seats: this.tables.length * 2,
        paused: this.settings.paused
      };
    }

    // ------------------------------------------------------------------- spawn
    findDrinkSprite(drink) {
      const id = typeof drink === 'string' ? drink : drink && drink.id;
      const found = this.sprites.drinks.find((d) => d.id === id);
      if (found) return found;
      return this.sprites.drinks.length ? pickOne(this.sprites.drinks) : null;
    }

    findCustomerSprite(gender) {
      const pool =
        gender && this.sprites.customers.some((c) => c.meta.gender === gender)
          ? this.sprites.customers.filter((c) => c.meta.gender === gender)
          : this.sprites.customers;
      return pickOne(pool);
    }

    spawn(opts = {}) {
      if (!this.ready) return null;
      // A viewer can only ever own one character.
      if (opts.viewerId) {
        const existing = this.viewers.get(opts.viewerId);
        if (existing && !existing.gone) return existing;
      }
      if (this.customers.length >= MAX_CUSTOMERS) return null;
      if (!this.sprites.customers.length || !this.sprites.drinks.length) return null;
      // Ambient walk-ins wait for room; viewers always get their character
      // (extra ones wait off stage in the virtual queue).
      if (!opts.priority && !opts.viewerId && this.queue.length >= MAX_QUEUE) return null;

      const record = opts.record || this.findCustomerSprite(opts.gender);
      const drink = opts.drinkRecord || this.findDrinkSprite(opts.drink);
      const fromLeft = opts.fromLeft != null ? opts.fromLeft : Math.random() < 0.5;
      const entry = fromLeft ? LAYOUT.entries.left : LAYOUT.entries.right;

      const customer = {
        id: ++this.seq,
        record,
        drink,
        name: opts.name || '',
        viewerId: opts.viewerId || null,
        uniqueId: opts.uniqueId || '',
        spriteIndex: Number.isInteger(opts.spriteIndex) ? opts.spriteIndex : null,
        orders: [],
        orderIds: new Set(),
        wave: 0,
        celebrate: 0,
        excited: 0,
        reaction: null,
        sparkleTimer: 0,
        vipLevel: Number(opts.vipLevel) || 0,
        leaving: false,
        leaveAfterServe: false,
        vip: Boolean(opts.vip),
        gift: opts.gift || null,
        gender: record.meta.gender,
        heightFactor: record.meta.height || 1,
        x: entry.x + (fromLeft ? -rand(0, 70) : rand(0, 70)),
        y: entry.y + rand(-16, 16),
        speed: rand(150, 196),
        facing: fromLeft ? 1 : -1,
        state: 'enter',
        waypoints: [{ x: fromLeft ? rand(340, 470) : rand(700, 830), y: rand(1400, 1440) }],
        bubble: null,
        cupInHand: false,
        orderTimer: 0,
        seatedTimer: 0,
        table: null,
        seat: null,
        walkPhase: Math.random() * Math.PI * 2,
        gone: false
      };

      this.customers.push(customer);
      if (opts.priority) this.queue.unshift(customer.id);
      else this.queue.push(customer.id);
      if (customer.viewerId) this.viewers.set(customer.viewerId, customer);
      return customer;
    }

    spawnRush(count) {
      for (let i = 0; i < count; i++) {
        this.pending.push({ at: this.time + i * 0.45, opts: { fromLeft: i % 2 === 0 } });
      }
    }

    spawnParty(ev) {
      const size = Math.round(clamp(Number(ev.groupSize) || 3, 2, 6));
      for (let i = 0; i < size; i++) {
        this.pending.push({
          at: this.time + i * 0.4,
          opts: {
            name: i === 0 ? ev.user : '',
            drink: ev.drink,
            fromLeft: i % 2 === 0,
            priority: i === 0
          }
        });
      }
    }

    /** One gift = one drink order at the counter; combo units queue up behind it. */
    spawnGiftOrders(ev) {
      const units = Math.round(clamp(Number(ev.units || ev.count) || 1, 1, 20));
      const gift = ev.gift || {
        id: ev.giftId,
        name: ev.giftName || 'Gift',
        icon: ev.giftIcon,
        coins: ev.coins
      };
      for (let i = 0; i < units; i++) {
        this.pending.push({
          at: this.time + i * 1.15,
          opts: {
            name: ev.user || 'Guest',
            drink: ev.drink,
            priority: true,
            gift
          }
        });
      }
    }

    // ------------------------------------------------------- viewer characters
    spriteForIndex(index) {
      const list = this.sprites.customers;
      if (!list.length) return null;
      if (!Number.isInteger(index)) return pickOne(list);
      return list[((index % list.length) + list.length) % list.length];
    }

    findViewerCharacter(viewerId) {
      const found = viewerId ? this.viewers.get(viewerId) : null;
      return found && !found.gone ? found : null;
    }

    /** Reuse the viewer's character; create it only the first time they appear. */
    ensureViewerCharacter(ev) {
      const viewerId = ev.viewerId;
      if (!viewerId) return null;
      const existing = this.findViewerCharacter(viewerId);
      if (existing) {
        if (existing.leaving) this.cancelViewerLeave(existing);
        if (ev.user) existing.name = ev.user;
        if (ev.uniqueId) existing.uniqueId = ev.uniqueId;
        if (Number.isInteger(ev.sprite)) existing.spriteIndex = ev.sprite;
        if (Number.isFinite(ev.vipLevel)) existing.vipLevel = Number(ev.vipLevel);
        return existing;
      }
      if (this.customers.length >= MAX_CUSTOMERS) return null;
      const record = this.spriteForIndex(Number.isInteger(ev.sprite) ? ev.sprite : null);
      if (!record) return null;
      const character = this.spawn({
        name: ev.user || 'Viewer',
        uniqueId: ev.uniqueId || '',
        viewerId,
        spriteIndex: Number.isInteger(ev.sprite) ? ev.sprite : null,
        record,
        vipLevel: Number(ev.vipLevel) || 0,
        priority: Boolean(ev.vip || ev.priority)
      });
      return character;
    }

    /** Gift senders move ahead of passive viewers in the waiting line. */
    prioritise(character) {
      if (!character) return;
      this.queue = this.queue.filter((id) => id !== character.id);
      this.queue.unshift(character.id);
    }

    enqueueViewerOrders(character, base, opts = {}) {
      if (!character) return;
      const units = Math.round(clamp(Number(opts.units) || 1, 1, 20));
      const order = base && base[0] ? base[0] : {};
      if (!order.drink && !order.giftName) return;
      let added = 0;
      for (let i = 0; i < units; i++) {
        const id = order.id
          ? i === 0
            ? String(order.id)
            : `${order.id}_${i}`
          : `local_${character.id}_${++this.orderSeq}`;
        if (character.orderIds.has(id)) continue; // combo replay never doubles an order
        character.orderIds.add(id);
        character.orders.push({
          id,
          drink: order.drink || null,
          coins: i === 0 ? Number(order.coins) || 0 : 0,
          giftName: order.giftName || ''
        });
        added += 1;
      }
      if (added && order.drink) character.drink = order.drink;
      if (added && opts.front) this.prioritise(character);
      // A big tray should never push the personal queue past the cap.
      if (character.orders.length > 20) character.orders.splice(0, character.orders.length - 20);
    }

    startViewerLeave(character) {
      if (!character) return;
      character.leaving = true;
      character.leaveAfterServe = character.state === 'order';
      if (character.leaveAfterServe) return; // finish the serving animation first
      this.finishViewerLeave(character);
    }

    finishViewerLeave(character) {
      character.leaving = true;
      character.leaveAfterServe = false;
      this.queue = this.queue.filter((id) => id !== character.id);
      if (character.table && character.seat) {
        character.table.occupants[character.seat.index] = null;
      }
      character.table = null;
      character.seat = null;
      character.bubble = { text: 'Thanks! See you next live! 👋', timer: 2600 };
      character.wave = Math.max(character.wave || 0, 2.4);
      character.waypoints = [
        { x: character.x < W / 2 ? 430 : 700, y: 1730 },
        this.exitFor(character)
      ];
      character.state = 'leave';
      character.cupInHand = false;
      this.heartsAround(character, 4);
    }

    cancelViewerLeave(character) {
      character.leaving = false;
      character.leaveAfterServe = false;
      character.bubble = { text: 'Back again!', timer: 1600 };
      if (character.table) {
        character.state = 'seated';
        character.waypoints = [];
        return;
      }
      if (!this.queue.includes(character.id)) this.queue.push(character.id);
      character.state = 'queue';
      character.waypoints = [];
    }

    celebrate(character) {
      if (!character) return;
      character.celebrate = Math.max(character.celebrate, 2.6);
      this.effects.push({
        kind: 'burst',
        x: character.x,
        y: character.y - 300 * this.customerScale(character),
        t: 0,
        life: 1.6
      });
    }

    heartsAround(character, count = 4) {
      if (!character) return;
      const scale = this.customerScale(character);
      for (let i = 0; i < count; i++) {
        this.effects.push({
          kind: 'heart',
          x: character.x + rand(-46, 46),
          y: character.y - rand(210, 330) * scale,
          vy: rand(48, 92),
          drift: rand(-22, 22),
          size: rand(12, 22),
          t: 0,
          life: rand(1.1, 2)
        });
      }
    }

    react(character, emoji, seconds = 1.4) {
      if (!character) return;
      character.reaction = { emoji, timer: seconds };
    }

    goldSparkles(character, count = 12) {
      if (!character) return;
      const scale = this.customerScale(character);
      const diamond = (character.vipLevel || 0) >= 3;
      for (let i = 0; i < count; i++) {
        if (this.effects.length > 90) break;
        this.effects.push({
          kind: 'sparkle',
          x: character.x + rand(-54, 54),
          y: character.y - rand(110, 360) * scale,
          vy: rand(30, 72),
          drift: rand(-18, 18),
          size: rand(6, 13),
          color: diamond && i % 3 === 0 ? '#7fe0ff' : '#ffd76a',
          t: 0,
          life: rand(0.8, 1.5)
        });
      }
    }

    vipCelebrate(character) {
      if (!character) return;
      character.celebrate = Math.max(character.celebrate || 0, 2.6);
      this.goldSparkles(character, (character.vipLevel || 0) >= 3 ? 24 : 14);
      this.effects.push({
        kind: 'burst',
        x: character.x,
        y: character.y - 300 * this.customerScale(character),
        t: 0,
        life: 1.7
      });
      this.react(character, '👑', 2);
    }

    /** Big donations make the whole shop cheer and wave. */
    cheerAll(intensity = 1) {
      for (const character of this.customers) {
        character.wave = Math.max(character.wave || 0, 1.4 + intensity * 0.5);
        character.celebrate = Math.max(character.celebrate || 0, 1.2 + intensity * 0.5);
        if (character.viewerId) this.heartsAround(character, 2);
      }
    }

    handleViewerEvent(ev) {
      const character = this.ensureViewerCharacter(ev);
      if (!character) {
        console.warn('[ShopGame] Character cap reached for', ev.user);
        return;
      }
      if (ev.vip) character.vip = true;
      if (Number.isFinite(ev.vipLevel) && Number(ev.vipLevel) > (character.vipLevel || 0)) {
        character.vipLevel = Number(ev.vipLevel);
        this.vipCelebrate(character);
      } else if (Number.isFinite(ev.vipLevel)) {
        character.vipLevel = Number(ev.vipLevel);
      }
      if (ev.vipUpgraded) this.vipCelebrate(character);

      if (ev.type === 'viewerJoin' || ev.type === 'viewerReconnect') {
        character.leaving = false;
        character.leaveAfterServe = false;
        character.bubble = { text: ev.type === 'viewerReconnect' ? 'Back again!' : 'Hi everyone!', timer: 1800 };
        this.react(character, '😊', 1.6);
        return;
      }
      if (ev.type === 'viewerLeave') {
        this.startViewerLeave(character);
        return;
      }
      if (this.settings.paused) return;

      switch (ev.type) {
        case 'followGuest':
        case 'freeDrink':
          character.vip = true;
          this.celebrate(character);
          this.goldSparkles(character, 10);
          this.heartsAround(character, 6);
          this.react(character, '🥳', 1.8);
          break;
        case 'likeBurst':
          character.wave = 2.4;
          this.heartsAround(character, Math.min(10, 3 + Math.round((Number(ev.count) || 1) / 2)));
          this.react(character, '😄', 1.4);
          break;
        case 'commentOrder': {
          const text = String(ev.bubbleText || ev.message || (ev.drink ? `One ${ev.drink.name}, please!` : 'Hello!')).slice(0, 110);
          character.bubble = { text, drink: ev.drink, timer: 3200 };
          this.react(character, '💬', 1.4);
          this.enqueueViewerOrders(character, [{ id: ev.orderId, drink: ev.drink, coins: 0 }], {
            units: Number(ev.count) || 1
          });
          break;
        }
        case 'giftOrder':
        case 'partyOrder': {
          const units = Math.max(1, Number(ev.units || ev.count || ev.groupSize) || 1);
          character.bubble = {
            text:
              ev.type === 'partyOrder'
                ? `${ev.giftName || 'Party tray'} · ${units} drinks`
                : `${ev.giftName || 'Gift'} → ${ev.drink ? ev.drink.name : 'drink'}`,
            drink: ev.drink,
            timer: 3200
          };
          this.enqueueViewerOrders(
            character,
            [{ id: ev.orderId, drink: ev.drink, coins: Number(ev.coins) || 0, giftName: ev.giftName }],
            { units, front: true }
          );
          this.celebrate(character);
          character.excited = 2;
          this.react(character, '🤩', 1.8);
          this.goldSparkles(character, 8);
          break;
        }
        case 'mysteryDrink':
        case 'serveDrink':
          character.bubble = { text: ev.message || 'One fresh drink!', drink: ev.drink, timer: 2800 };
          this.enqueueViewerOrders(character, [{ id: ev.orderId, drink: ev.drink, coins: 0 }], {
            units: Number(ev.count) || 1
          });
          break;
        default:
          break;
      }
    }

    /** Rebuild characters for viewers that joined before this page loaded. */
    syncViewers(list) {
      if (!Array.isArray(list)) return;
      this.viewerRoster = list;
      if (!this.ready) {
        this.pendingViewerSync = list;
        return;
      }
      for (const viewer of list) {
        if (!viewer || viewer.id == null || viewer.leftAt) continue;
        let character = this.findViewerCharacter(viewer.id);
        if (!character) {
          character = this.ensureViewerCharacter({
            viewerId: viewer.id,
            user: viewer.name,
            uniqueId: viewer.uniqueId,
            sprite: viewer.sprite,
            vip: viewer.vip
          });
        }
        if (!character) continue;
        character.vip = Boolean(character.vip || viewer.vip);
        character.vipLevel = Math.max(character.vipLevel || 0, Number(viewer.vipLevel) || 0);
        for (const order of viewer.orders || []) {
          this.enqueueViewerOrders(
            character,
            [
              {
                id: order.id,
                drink: this.findDrinkSprite(order.drinkId),
                coins: Number(order.coins) || 0,
                giftName: order.giftName || ''
              }
            ],
            { units: 1 }
          );
        }
        // Viewers with paid orders waiting are served before passive guests.
        if (character.orders.length) this.prioritise(character);
      }
    }

    /** Map a server event (TikTok interaction) onto the simulation. */
    handleEvent(ev) {
      if (!ev) return;
      // Art is still decoding: replay the interaction once sprites exist.
      if (!this.ready) {
        this.pendingEvents.push(ev);
        if (this.pendingEvents.length > 40) this.pendingEvents.shift();
        return;
      }
      if (ev.viewerId) {
        this.handleViewerEvent(ev);
        return;
      }
      if (this.settings.paused) return;
      switch (ev.type) {
        case 'serveDrink':
        case 'commentOrder':
        case 'mysteryDrink':
          this.spawn({ name: ev.user, drink: ev.drink });
          break;
        case 'followGuest':
        case 'freeDrink':
          this.spawn({ name: ev.user, drink: ev.drink, vip: true, priority: true });
          break;
        case 'likeBurst':
          this.spawnRush(2 + Math.min(3, Math.floor((Number(ev.count) || 1) / 5)));
          break;
        case 'partyOrder':
          this.spawnParty(ev);
          break;
        case 'giftOrder':
          this.spawnGiftOrders(ev);
          break;
        case 'newGuest':
          this.spawn({ name: ev.user, drink: ev.drink });
          break;
        default:
          break;
      }
    }

    // ------------------------------------------------------------------ update
    spawnInterval() {
      const rate = clamp(this.settings.spawnRate || 1, 0.25, 3);
      return clamp(6200 / rate, 1400, 20000) * rand(0.75, 1.25);
    }

    findSeat() {
      for (const table of this.tables) {
        for (let i = 0; i < table.occupants.length; i++) {
          if (!table.occupants[i]) {
            return { table, index: i, x: table.seats[i].x, y: table.seats[i].y };
          }
        }
      }
      return null;
    }

    exitFor(customer) {
      return customer.x < W / 2
        ? { x: -170, y: 1760 }
        : { x: W + 170, y: 1740 };
    }

    moveToward(customer, target, step) {
      const dx = target.x - customer.x;
      const dy = target.y - customer.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.6) return true;
      if (dist <= step) {
        customer.x = target.x;
        customer.y = target.y;
        return true;
      }
      customer.x += (dx / dist) * step;
      customer.y += (dy / dist) * step;
      if (Math.abs(dx) > 2) customer.facing = dx > 0 ? 1 : -1;
      return false;
    }

    advancePath(customer, dt) {
      const wp = customer.waypoints[0];
      if (!wp) return true;
      const arrived = this.moveToward(customer, wp, customer.speed * dt);
      if (arrived) {
        customer.waypoints.shift();
        return customer.waypoints.length === 0;
      }
      return false;
    }

    beginOrder(customer) {
      customer.state = 'order';
      customer.orderTimer = rand(900, 1250);
      this.servingId = customer.id;
      const order = customer.orders && customer.orders[0];
      if (order && order.drink) customer.drink = order.drink;
      const drink = customer.drink;
      const coins = order ? Number(order.coins) || 0 : 0;
      customer.bubble = {
        text: coins > 0
          ? `${order.giftName || 'Gift'} · ${drink.name} · ${coins} coins`
          : customer.gift
            ? `${customer.gift.name} gift · one ${drink.name}!`
            : customer.vip
              ? 'New follower treat!'
              : `One ${drink.name}, please!`,
        drink,
        timer: 2200
      };
    }

    completeOrder(customer) {
      this.queue = this.queue.filter((id) => id !== customer.id);
      this.servingId = null;
      this.serveFlash = 1;
      customer.cupInHand = true;

      const servedOrder = customer.orders && customer.orders.length ? customer.orders.shift() : null;
      if (servedOrder && servedOrder.drink) customer.drink = servedOrder.drink;

      const price = DRINK_PRICES[customer.drink.id] != null ? DRINK_PRICES[customer.drink.id] : 4;
      const bonus = customer.vip ? 6 : 1;
      const totalTip = round2(price + bonus);
      this.session.served += 1;
      this.session.drinks += 1;
      this.session.tips = round2(this.session.tips + totalTip);

      this.tipPops.push({
        text: `+$${totalTip.toFixed(2)}`,
        x: customer.x,
        y: customer.y - 250 * this.customerScale(customer),
        life: 1
      });

      if (servedOrder && servedOrder.coins > 0) {
        this.tipPops.push({
          text: `+${servedOrder.coins} 💰`,
          x: customer.x + 46,
          y: customer.y - 268 * this.customerScale(customer),
          life: 1
        });
      }

      if (this.onSale) {
        this.onSale({
          tip: totalTip,
          drink: customer.drink ? customer.drink.name : '',
          name: customer.name || 'Walk-in guest'
        });
      }

      if (servedOrder && customer.viewerId && this.onOrderServed) {
        this.onOrderServed({
          viewerId: customer.viewerId,
          uniqueId: customer.uniqueId,
          name: customer.name,
          orderId: servedOrder.id,
          coins: servedOrder.coins
        });
      }

      if (customer.viewerId) {
        customer.bubble = { text: `Thank you, ${customer.name}! 😊`, timer: 2000 };
        customer.wave = Math.max(customer.wave || 0, 1.2);
        this.react(customer, '😊', 1.5);
      }

      // Viewer left mid-service: finish this drink, then wave goodbye.
      if (customer.leaveAfterServe) {
        customer.cupInHand = false;
        this.finishViewerLeave(customer);
        return;
      }

      // More drinks in this viewer's personal queue → stay at the counter.
      if (customer.orders.length) {
        customer.cupInHand = false;
        this.queue.unshift(customer.id);
        customer.state = 'queue';
        customer.bubble = { text: `${customer.orders.length} more coming up!`, timer: 1600 };
        return;
      }

      const seat = this.findSeat();
      if (seat) {
        customer.table = seat.table;
        customer.seat = seat;
        seat.table.occupants[seat.index] = customer.id;
        customer.waypoints = [
          { x: seat.x + (seat.index === 0 ? -30 : 30), y: seat.y - 96 },
          { x: seat.x, y: seat.y }
        ];
        customer.state = 'toSeat';
        customer.bubble = { text: 'Thanks!', timer: 1200 };
      } else {
        customer.waypoints = [
          { x: customer.x < W / 2 ? 420 : 700, y: 1720 },
          this.exitFor(customer)
        ];
        customer.state = 'toGo';
        customer.bubble = { text: 'To go, thanks!', timer: 1500 };
      }
    }

    finishDrink(customer) {
      // A viewer's character stays in the shop until they actually leave.
      if (customer.viewerId) {
        customer.seatedTimer = rand(6000, 9000);
        customer.bubble = { text: 'That hit the spot!', timer: 1400 };
        return;
      }
      if (customer.table && typeof customer.seat.index === 'number') {
        customer.table.occupants[customer.seat.index] = null;
      }
      customer.table = null;
      customer.seat = null;
      customer.cupInHand = false;
      customer.bubble = { text: 'That hit the spot!', timer: 1400 };
      customer.waypoints = [
        { x: customer.x + (customer.x < W / 2 ? -70 : 70), y: customer.y + 40 },
        { x: customer.x < W / 2 ? 460 : 720, y: 1725 },
        this.exitFor(customer)
      ];
      customer.state = 'leave';
    }

    update(dt) {
      if (this.settings.paused) return;

      this.serveFlash = Math.max(0, this.serveFlash - dt * 1.6);

      for (let i = this.effects.length - 1; i >= 0; i--) {
        const fx = this.effects[i];
        fx.t += dt;
        if (fx.kind === 'heart' || fx.kind === 'sparkle') {
          fx.y -= fx.vy * dt;
          fx.x += fx.drift * dt;
        }
        if (fx.t >= fx.life) this.effects.splice(i, 1);
      }

      // delayed spawns (rush / party trays)
      if (this.pending.length) {
        const due = this.pending.filter((p) => p.at <= this.time);
        this.pending = this.pending.filter((p) => p.at > this.time);
        due.forEach((p) => this.spawn(p.opts));
      }

      // Walk-in extras only fill an empty shop; viewers own the floor otherwise.
      if (this.settings.running && this.viewers.size === 0) {
        this.spawnTimer -= dt * 1000;
        if (this.spawnTimer <= 0) {
          this.spawn();
          this.spawnTimer = this.spawnInterval();
        }
      }

      for (const customer of this.customers) {
        if (customer.bubble) {
          customer.bubble.timer -= dt * 1000;
          if (customer.bubble.timer <= 0) customer.bubble = null;
        }
        customer.walkPhase += dt * 8;
        if (customer.wave > 0) customer.wave = Math.max(0, customer.wave - dt);
        if (customer.celebrate > 0) customer.celebrate = Math.max(0, customer.celebrate - dt);
        if (customer.excited > 0) customer.excited = Math.max(0, customer.excited - dt);
        if (customer.reaction && customer.reaction.timer > 0) {
          customer.reaction.timer = Math.max(0, customer.reaction.timer - dt);
          if (customer.reaction.timer === 0) customer.reaction = null;
        }
        const vipLevelNow = customer.vipLevel || 0;
        if (vipLevelNow > 0) {
          customer.sparkleTimer = (customer.sparkleTimer || 0) + dt;
          const sparkleGap = vipLevelNow >= 3 ? 0.34 : vipLevelNow === 2 ? 0.6 : 1.2;
          if (customer.sparkleTimer >= sparkleGap && this.effects.length < 90) {
            customer.sparkleTimer = 0;
            this.goldSparkles(customer, 1);
          }
        }

        switch (customer.state) {
          case 'enter': {
            if (this.advancePath(customer, dt)) customer.state = 'queue';
            break;
          }
          case 'queue': {
            const index = this.queue.indexOf(customer.id);
            if (index === -1) {
              customer.waypoints = [this.exitFor(customer)];
              customer.state = 'leave';
              break;
            }
            let slot;
            if (index < VIEWER_LIMITS.visibleWaiting) {
              slot =
                index < LAYOUT.queueSlots.length
                  ? LAYOUT.queueSlots[index]
                  : LAYOUT.overflow[Math.min(index - LAYOUT.queueSlots.length, LAYOUT.overflow.length - 1)];
            } else {
              // Virtual waiting queue: no room at the counter, wait off stage.
              slot = HOLDING_SLOTS[index % HOLDING_SLOTS.length];
            }
            const arrived = this.moveToward(customer, slot, customer.speed * dt);
            if (index === 0 && arrived && !this.servingId) this.beginOrder(customer);
            break;
          }
          case 'order': {
            customer.orderTimer -= dt * 1000;
            if (customer.orderTimer <= 0) this.completeOrder(customer);
            break;
          }
          case 'toSeat': {
            if (this.advancePath(customer, dt)) {
              customer.state = 'seated';
              customer.seatedTimer = rand(5200, 9000);
              customer.bubble = { text: 'Ahh, perfect!', timer: 1400 };
            }
            break;
          }
          case 'seated': {
            customer.seatedTimer -= dt * 1000;
            if (customer.seatedTimer <= 0) this.finishDrink(customer);
            break;
          }
          case 'toGo':
          case 'leave': {
            if (this.advancePath(customer, dt)) customer.gone = true;
            break;
          }
          default:
            break;
        }
      }

      this.separateWalkers();
      this.customers = this.customers.filter((c) => !c.gone);

      // Someone joined while the floor was full (usually leaving characters):
      // retry once a slot opens so no viewer is lost.
      this.viewerSyncTimer += dt;
      if (this.viewerRoster && this.viewerSyncTimer > 2) {
        this.viewerSyncTimer = 0;
        const waiting = this.viewerRoster.filter((viewer) => viewer && !viewer.leftAt);
        if (this.viewers.size < waiting.length && this.customers.length < MAX_CUSTOMERS) {
          this.syncViewers(this.viewerRoster);
        }
      }
      for (const [viewerId, character] of this.viewers) {
        if (character.gone) this.viewers.delete(viewerId);
      }
    }

    separateWalkers() {
      const walkers = this.customers.filter(
        (c) => c.state === 'enter' || c.state === 'toSeat' || c.state === 'leave' || c.state === 'toGo'
      );
      for (let i = 0; i < walkers.length; i++) {
        for (let j = i + 1; j < walkers.length; j++) {
          const a = walkers[i];
          const b = walkers[j];
          const minDist = 66 * this.customerScale(a);
          let dx = b.x - a.x;
          let dy = (b.y - a.y) * 1.6;
          let dist = Math.hypot(dx, dy);
          if (dist < 0.001) {
            dx = rand(-1, 1);
            dy = rand(-1, 1);
            dist = 1;
          }
          if (dist < minDist) {
            const push = (minDist - dist) / dist * 0.35;
            a.x -= dx * push;
            a.y -= (dy * push) / 1.6;
            b.x += dx * push;
            b.y += (dy * push) / 1.6;
          }
        }
      }
    }

    customerScale(customer) {
      return depthScale(customer.y) * (customer.heightFactor || 1);
    }

    // ------------------------------------------------------------------ render
    loop(ts) {
      this.raf = requestAnimationFrame(this.loop);
      if (document.hidden) return;
      const dt = this.lastTs ? Math.min(0.05, (ts - this.lastTs) / 1000) : 0.016;
      this.lastTs = ts;
      this.time += dt;
      this.update(dt);
      this.render();
    }

    render() {
      if (!this.ready) return;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, W, H);

      this.drawGround(ctx);
      this.drawUmbrellas(ctx);
      this.drawSellers(ctx);
      this.drawCounter(ctx);

      const drawables = [];
      for (const table of this.tables) {
        drawables.push({ y: table.y, draw: () => this.drawTable(ctx, table) });
      }
      for (const customer of this.customers) {
        const seated = customer.state === 'seated' && customer.table;
        drawables.push({
          y: seated ? customer.table.y - 2 : customer.y,
          draw: () => this.drawCustomer(ctx, customer)
        });
      }
      drawables.sort((a, b) => a.y - b.y).forEach((item) => item.draw());

      this.drawEffects(ctx);
      this.drawTipPops(ctx);
    }

    drawEffects(ctx) {
      for (const fx of this.effects) {
        const alpha = clamp(1 - fx.t / fx.life, 0, 1);
        if (fx.kind === 'heart') {
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.translate(fx.x, fx.y);
          const s = fx.size;
          ctx.beginPath();
          ctx.moveTo(0, s * 0.35);
          ctx.bezierCurveTo(-s, -s * 0.4, -s * 0.5, -s, 0, -s * 0.45);
          ctx.bezierCurveTo(s * 0.5, -s, s, -s * 0.4, 0, s * 0.35);
          ctx.fillStyle = '#ef5a4b';
          ctx.fill();
          ctx.strokeStyle = COLORS.ink;
          ctx.lineWidth = 2.5;
          ctx.stroke();
          ctx.restore();
        } else if (fx.kind === 'sparkle') {
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.translate(fx.x, fx.y);
          ctx.rotate(fx.t * 3);
          ctx.fillStyle = fx.color || '#ffd76a';
          ctx.beginPath();
          for (let i = 0; i < 4; i++) {
            const angle = (Math.PI / 2) * i;
            ctx.lineTo(Math.cos(angle) * fx.size, Math.sin(angle) * fx.size);
            ctx.lineTo(Math.cos(angle + Math.PI / 4) * fx.size * 0.35, Math.sin(angle + Math.PI / 4) * fx.size * 0.35);
          }
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        } else if (fx.kind === 'burst') {
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.translate(fx.x, fx.y);
          const radius = 26 + fx.t * 90;
          ctx.strokeStyle = COLORS.sun;
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.arc(0, 0, radius, 0, Math.PI * 2);
          ctx.stroke();
          for (let i = 0; i < 8; i++) {
            const a = (Math.PI / 4) * i + fx.t * 2;
            ctx.beginPath();
            ctx.arc(Math.cos(a) * radius, Math.sin(a) * radius, 6, 0, Math.PI * 2);
            ctx.fillStyle = i % 2 === 0 ? COLORS.coral : COLORS.sun;
            ctx.fill();
          }
          ctx.restore();
        }
      }
    }

    drawGround(ctx) {
      ctx.save();
      ctx.translate(646, 1222);
      ctx.rotate(-0.03);
      ctx.font = '800 20px "Nunito", sans-serif';
      ctx.textAlign = 'center';
      const label = 'ORDER HERE';
      const w = ctx.measureText(label).width + 34;
      ctx.fillStyle = 'rgba(255, 247, 228, 0.78)';
      roundedRect(ctx, -w / 2, -18, w, 36, 10);
      ctx.fill();
      ctx.strokeStyle = 'rgba(59, 42, 32, 0.5)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = 'rgba(59, 42, 32, 0.72)';
      ctx.fillText(label, 0, 8);
      ctx.restore();
    }

    drawUmbrellas(ctx) {
      for (const table of this.tables) {
        if (!table.umbrella) continue;
        const x = table.x;
        const canopyY = table.y - 344;

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x, table.y - 56);
        ctx.lineTo(x, canopyY);
        ctx.strokeStyle = COLORS.ink;
        ctx.lineWidth = 13;
        ctx.stroke();
        ctx.strokeStyle = '#cfc7b6';
        ctx.lineWidth = 6;
        ctx.stroke();
        ctx.restore();

        const rx = 122;
        const ry = 58;
        const apexY = canopyY - ry * 0.92;
        const segments = 6;
        for (let i = 0; i < segments; i++) {
          const a0 = Math.PI + (Math.PI / segments) * i;
          const a1 = a0 + Math.PI / segments;
          ctx.beginPath();
          ctx.moveTo(x, apexY);
          ctx.ellipse(x, canopyY, rx, ry, 0, a0, a1);
          ctx.closePath();
          ctx.fillStyle = i % 2 === 0 ? COLORS.coral : COLORS.cream;
          ctx.fill();
          ctx.strokeStyle = COLORS.ink;
          ctx.lineWidth = 3;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(x, apexY - 6);
        ctx.lineTo(x, apexY - 26);
        ctx.strokeStyle = COLORS.ink;
        ctx.lineWidth = 6;
        ctx.stroke();
        ellipse(ctx, x, apexY - 30, 7, 7, COLORS.sun, COLORS.ink, 3);
      }
    }

    drawSellers(ctx) {
      const bounce = Math.sin(this.time * 1.9) * 3;
      const serve = Math.sin(this.serveFlash * Math.PI) * 6;
      LAYOUT.sellers.forEach((slot, index) => {
        const sprite = this.sprites.sellers[slot.key];
        if (!sprite) return;
        const height = 336;
        const width = height * (sprite.w / sprite.h);
        const bob = index === 0 ? bounce : -bounce;
        ctx.save();
        ctx.translate(slot.x + (index === 0 ? 0 : 2), slot.y + bob - serve);
        ctx.drawImage(sprite.canvas, -width / 2, -height, width, height);
        ctx.restore();
      });
    }

    drawCounter(ctx) {
      const { x, y, w, h } = LAYOUT.counter;
      const frontY = y + 26;
      const frontH = h - 26;

      // front panel
      ctx.save();
      roundedRect(ctx, x, frontY, w, frontH, 10);
      const grad = ctx.createLinearGradient(0, frontY, 0, frontY + frontH);
      grad.addColorStop(0, COLORS.woodLight);
      grad.addColorStop(1, '#c07c3f');
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 5;
      ctx.stroke();

      // candy stripes
      ctx.save();
      roundedRect(ctx, x, frontY, w, frontH, 10);
      ctx.clip();
      const stripeW = 74;
      for (let i = 0; i * stripeW < w; i++) {
        if (i % 2 !== 0) continue;
        ctx.fillStyle = 'rgba(239, 90, 75, 0.55)';
        ctx.fillRect(x + i * stripeW, frontY, stripeW, frontH);
      }
      ctx.restore();

      // counter sign plaque
      ctx.font = '800 20px "Baloo 2", "Nunito", sans-serif';
      ctx.textAlign = 'center';
      const plaqueLabel = 'FRESH SQUEEZED DAILY';
      const plaqueW = ctx.measureText(plaqueLabel).width + 30;
      roundedRect(ctx, x + w / 2 - plaqueW / 2, frontY + frontH / 2 - 17, plaqueW, 34, 10);
      ctx.fillStyle = COLORS.cream;
      ctx.fill();
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = COLORS.coralDark;
      ctx.fillText(plaqueLabel, x + w / 2, frontY + frontH / 2 + 7);

      // top slab
      roundedRect(ctx, x - 16, y - 14, w + 32, 44, 16);
      ctx.fillStyle = '#ffe3b0';
      ctx.fill();
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 5;
      ctx.stroke();

      // drink display cups on the counter
      const cups = this.sprites.drinks;
      if (cups.length) {
        const display = [
          { record: cups[0], x: x + 86 },
          { record: cups[Math.min(1, cups.length - 1)], x: x + 156 },
          { record: cups[Math.min(2, cups.length - 1)], x: x + w - 96 }
        ];
        for (const cup of display) {
          const s = cup.record.sprite;
          const height = 62;
          const width = height * (s.w / s.h);
          ctx.drawImage(s.canvas, cup.x - width / 2, y - 12 - height, width, height);
        }
      }
      ctx.restore();
    }

    drawTable(ctx, table) {
      const { x, y } = table;
      ctx.save();

      ellipse(ctx, x, y + 46, 104, 24, 'rgba(43, 32, 26, 0.16)');

      // stools (behind the table body)
      [0, 1].forEach((i) => {
        const seatX = table.seats[i].x;
        if (!table.occupants[i]) {
          ellipse(ctx, seatX, y + 38, 32, 12, '#e7d7b7', COLORS.ink, 3);
          ctx.beginPath();
          ctx.moveTo(seatX - 18, y + 42);
          ctx.lineTo(seatX - 24, y + 58);
          ctx.moveTo(seatX + 18, y + 42);
          ctx.lineTo(seatX + 24, y + 58);
          ctx.strokeStyle = COLORS.ink;
          ctx.lineWidth = 4;
          ctx.stroke();
        }
      });

      // base + pole
      ellipse(ctx, x, y + 34, 54, 16, '#b9b5c4', COLORS.ink, 3);
      ctx.beginPath();
      ctx.moveTo(x - 7, y - 34);
      ctx.lineTo(x - 7, y + 34);
      ctx.moveTo(x + 7, y - 34);
      ctx.lineTo(x + 7, y + 34);
      ctx.strokeStyle = '#e4e1ec';
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 2;
      ctx.stroke();

      // table top with a red picnic-cloth pattern
      ellipse(ctx, x, y - 40, 94, 28, '#b98b52', COLORS.ink, 4);
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(x, y - 52, 94, 28, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = '#fff4dd';
      ctx.fillRect(x - 98, y - 86, 196, 68);
      ctx.strokeStyle = 'rgba(216, 60, 45, 0.8)';
      ctx.lineWidth = 18;
      for (let i = -3; i <= 3; i++) {
        ctx.beginPath();
        ctx.moveTo(x - 98 + i * 34, y - 86);
        ctx.lineTo(x - 62 + i * 34, y - 18);
        ctx.stroke();
      }
      ctx.restore();
      ellipse(ctx, x, y - 52, 94, 28, null, COLORS.ink, 5);

      // cup on the table when someone is seated
      const occupied = table.occupants.filter(Boolean).length;
      if (occupied > 0 && this.sprites.drinks.length) {
        const customer = this.customers.find((c) => c.table === table);
        const cup = (customer && customer.drink) || this.sprites.drinks[0];
        const s = cup.sprite;
        const height = 46;
        const width = height * (s.w / s.h);
        ctx.drawImage(s.canvas, x + 26 - width / 2, y - 58 - height, width, height);
      }

      ctx.restore();
    }

    drawCustomer(ctx, customer) {
      const sprite = customer.record.sprite;
      const scale = this.customerScale(customer);
      const height = 336 * scale;
      const width = height * (sprite.w / sprite.h);
      const walking =
        customer.state === 'enter' ||
        customer.state === 'toSeat' ||
        customer.state === 'leave' ||
        customer.state === 'toGo';
      const walkBob = walking ? Math.abs(Math.sin(customer.walkPhase)) * 7 : 0;
      const idleBob = customer.state === 'queue' || customer.state === 'order' ? Math.sin(this.time * 2 + customer.id) * 2 : 0;
      const excitedHop = customer.excited > 0 ? Math.abs(Math.sin(this.time * 18)) * 10 : 0;
      const feetY = customer.y - walkBob + idleBob - excitedHop;
      const seated = customer.state === 'seated';

      // shadow
      ellipse(ctx, customer.x, customer.y + 4, 46 * scale, 13 * scale, 'rgba(43, 32, 26, 0.2)');

      ctx.save();
      ctx.translate(customer.x, feetY);
      if (walking) {
        ctx.rotate(Math.sin(customer.walkPhase) * 0.018);
      } else if (customer.wave > 0) {
        // Waving = a happy little rock instead of a walk cycle.
        ctx.rotate(Math.sin(this.time * 16) * 0.055);
      }
      ctx.scale(customer.facing < 0 ? -1 : 1, seated ? 0.95 : 1);
      ctx.drawImage(sprite.canvas, -width / 2, -height, width, height);
      ctx.restore();

      if (customer.cupInHand && customer.drink && this.sprites.drinks.length) {
        // A drink restored from server state may arrive without a loaded sprite,
        // so fall back to the sprite for its id instead of crashing the render loop.
        const fallback = this.sprites.drinks.find((d) => d.meta && d.meta.id === customer.drink.id);
        const s =
          customer.drink.sprite && customer.drink.sprite.w && customer.drink.sprite.h
            ? customer.drink.sprite
            : fallback && fallback.sprite;
        if (s && s.w && s.h && s.canvas) {
          const cupH = 50 * scale;
          const cupW = cupH * (s.w / s.h);
          const cupX = customer.x + customer.facing * 30 * scale;
          const cupY = feetY - 132 * scale;
          ctx.drawImage(s.canvas, cupX - cupW / 2, cupY - cupH / 2, cupW, cupH);
        }
      }

      const vipLevel = customer.vipLevel || 0;
      if (vipLevel === 1) this.drawVipBadge(ctx, customer.x, feetY - height + 30 * scale, scale);
      if (vipLevel >= 2) this.drawCrown(ctx, customer.x, feetY - height - 10, scale, vipLevel >= 3 ? 'diamond' : 'gold');
      if (customer.reaction) {
        ctx.save();
        ctx.globalAlpha = clamp(customer.reaction.timer / 0.4, 0, 1);
        ctx.font = `${Math.round(32 * clamp(scale, 0.8, 1.1))}px "Nunito", sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(customer.reaction.emoji, customer.x - 38 * scale, feetY - height - 34 * scale);
        ctx.restore();
      }
      if (customer.wave > 0) {
        ctx.save();
        ctx.font = `${Math.round(34 * clamp(scale, 0.8, 1.1))}px "Nunito", sans-serif`;
        ctx.textAlign = 'center';
        ctx.globalAlpha = clamp(customer.wave, 0, 1);
        ctx.fillText('👋', customer.x + 34 * scale, feetY - height - 58 * scale);
        ctx.restore();
      }
      if (customer.name) {
        this.drawNameTag(ctx, customer, feetY - height - (vipLevel >= 2 ? 38 : customer.vip ? 34 : 12), scale);
      }
      if (customer.bubble) this.drawBubble(ctx, customer.x, feetY - height - 6, customer.bubble, scale);
    }

    drawCrown(ctx, x, y, scale, style = 'gold') {
      const diamond = style === 'diamond';
      const w = 34 * scale;
      const h = 22 * scale;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x - w / 2, y);
      ctx.lineTo(x - w / 2, y - h);
      ctx.lineTo(x - w / 6, y - h * 0.45);
      ctx.lineTo(x, y - h * 1.05);
      ctx.lineTo(x + w / 6, y - h * 0.45);
      ctx.lineTo(x + w / 2, y - h);
      ctx.lineTo(x + w / 2, y);
      ctx.closePath();
      ctx.fillStyle = diamond ? '#a9ecff' : COLORS.sun;
      ctx.fill();
      ctx.strokeStyle = diamond ? '#2b6f9c' : COLORS.ink;
      ctx.lineWidth = 3;
      ctx.stroke();
      if (diamond) {
        ctx.beginPath();
        ctx.arc(x, y - h * 0.55, 4.2 * scale, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      }
      ctx.restore();
    }

    drawVipBadge(ctx, x, y, scale) {
      const r = 15 * scale;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x + 28 * scale, y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd76a';
      ctx.fill();
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.font = `800 ${Math.round(11 * clamp(scale, 0.85, 1.1))}px "Nunito", sans-serif`;
      ctx.fillStyle = '#6b4512';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('VIP', x + 28 * scale, y + 0.5);
      ctx.restore();
    }

    drawNameTag(ctx, customer, y, scale) {
      ctx.save();
      ctx.font = `800 ${Math.round(19 * clamp(scale, 0.8, 1.1))}px "Nunito", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const pending = customer.orders ? customer.orders.length : 0;
      const label = pending > 1
        ? `${customer.name} · ${pending} orders`
        : customer.gift
          ? `${customer.name} · ${customer.gift.name}`
          : customer.name;
      const text = ellipsize(ctx, label, 210);
      const tagH = 32;
      const tagW = Math.max(64, ctx.measureText(text).width + 26);
      const tagX = clamp(customer.x - tagW / 2, 10, W - tagW - 10);
      roundedRect(ctx, tagX, y - tagH, tagW, tagH, 12);
      const level = customer.vipLevel || 0;
      if (level >= 3) {
        ctx.shadowColor = '#69d2ff';
        ctx.shadowBlur = 18;
      } else if (level === 2) {
        ctx.shadowColor = '#ffcf4d';
        ctx.shadowBlur = 12;
      }
      ctx.fillStyle =
        level >= 2
          ? 'rgba(255, 226, 138, 0.98)'
          : customer.vip
            ? 'rgba(255, 223, 130, 0.97)'
            : 'rgba(255, 251, 240, 0.95)';
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = level >= 3 ? '#2b6f9c' : COLORS.ink;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = COLORS.ink;
      ctx.fillText(text, tagX + tagW / 2, y - tagH / 2 + 1);
      ctx.restore();
    }

    drawBubble(ctx, x, y, bubble, scale) {
      if (!bubble) return;
      const alpha = clamp(bubble.timer / 350, 0, 1);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = '800 21px "Nunito", sans-serif';
      const text = ellipsize(ctx, String(bubble.text || '').slice(0, 120), 330);
      const textW = ctx.measureText(text).width;
      const hasDrink = Boolean(bubble.drink && bubble.drink.sprite);
      const iconW = hasDrink ? 42 : 0;
      const boxW = Math.min(W - 40, textW + iconW + 34);
      const boxH = 54;
      const boxX = clamp(x - boxW / 2, 12, W - boxW - 12);
      const boxY = y - boxH;

      // tail first so the body covers its top edge
      ctx.beginPath();
      const tailX = clamp(x, boxX + 26, boxX + boxW - 26);
      ctx.moveTo(tailX - 10, boxY + boxH - 3);
      ctx.lineTo(tailX + 10, boxY + boxH - 3);
      ctx.lineTo(tailX, boxY + boxH + 16);
      ctx.closePath();
      ctx.fillStyle = '#fffdf6';
      ctx.fill();
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 3.5;
      ctx.stroke();

      roundedRect(ctx, boxX, boxY, boxW, boxH, 16);
      ctx.fillStyle = '#fffdf6';
      ctx.fill();
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 3.5;
      ctx.stroke();

      if (hasDrink) {
        const s = bubble.drink.sprite;
        const cupH = 38;
        const cupW = cupH * (s.w / s.h);
        ctx.drawImage(s.canvas, boxX + 12, boxY + boxH / 2 - cupH / 2, cupW, cupH);
      }

      ctx.fillStyle = COLORS.ink;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, boxX + 12 + iconW, boxY + boxH / 2 + 1);
      ctx.restore();
    }

    drawTipPops(ctx) {
      for (let i = this.tipPops.length - 1; i >= 0; i--) {
        const pop = this.tipPops[i];
        pop.life -= 0.016;
        pop.y -= 1.4;
        if (pop.life <= 0) {
          this.tipPops.splice(i, 1);
          continue;
        }
        ctx.save();
        ctx.globalAlpha = clamp(pop.life, 0, 1);
        ctx.font = '800 28px "Baloo 2", "Nunito", sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 6;
        ctx.strokeStyle = '#fffdf6';
        ctx.strokeText(pop.text, pop.x, pop.y);
        ctx.fillStyle = COLORS.mint;
        ctx.fillText(pop.text, pop.x, pop.y);
        ctx.restore();
      }
    }
  }

  window.ShopGame = ShopGame;
})();
