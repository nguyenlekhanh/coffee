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
  const MAX_CUSTOMERS = 20;
  const MAX_QUEUE = 6;
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
      if (!this.ready || this.customers.length >= MAX_CUSTOMERS) return null;
      if (!this.sprites.customers.length || !this.sprites.drinks.length) return null;
      // Keep the line readable: ambient walk-ins wait for room, viewer events
      // (priority) may still join so a gift/combo is never silently ignored.
      if (!opts.priority && this.queue.length >= MAX_QUEUE) return null;

      const record = opts.record || this.findCustomerSprite(opts.gender);
      const drink = opts.drinkRecord || this.findDrinkSprite(opts.drink);
      const fromLeft = opts.fromLeft != null ? opts.fromLeft : Math.random() < 0.5;
      const entry = fromLeft ? LAYOUT.entries.left : LAYOUT.entries.right;

      const customer = {
        id: ++this.seq,
        record,
        drink,
        name: opts.name || '',
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

    /** Map a server event (TikTok interaction) onto the simulation. */
    handleEvent(ev) {
      if (!ev || this.settings.paused) return;
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
      customer.bubble = {
        text: customer.gift
          ? `${customer.gift.name} gift · one ${customer.drink.name}!`
          : customer.vip
            ? 'New follower treat!'
            : `One ${customer.drink.name}, please!`,
        drink: customer.drink,
        timer: 1700
      };
    }

    completeOrder(customer) {
      this.queue = this.queue.filter((id) => id !== customer.id);
      this.servingId = null;
      this.serveFlash = 1;
      customer.cupInHand = true;

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

      if (this.onSale) {
        this.onSale({
          tip: totalTip,
          drink: customer.drink ? customer.drink.name : '',
          name: customer.name || 'Walk-in guest'
        });
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

      // delayed spawns (rush / party trays)
      if (this.pending.length) {
        const due = this.pending.filter((p) => p.at <= this.time);
        this.pending = this.pending.filter((p) => p.at > this.time);
        due.forEach((p) => this.spawn(p.opts));
      }

      if (this.settings.running) {
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
            if (index < LAYOUT.queueSlots.length) {
              slot = LAYOUT.queueSlots[index];
            } else {
              slot = LAYOUT.overflow[Math.min(index - LAYOUT.queueSlots.length, LAYOUT.overflow.length - 1)];
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

      this.drawTipPops(ctx);
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
      const feetY = customer.y - walkBob + idleBob;
      const seated = customer.state === 'seated';

      // shadow
      ellipse(ctx, customer.x, customer.y + 4, 46 * scale, 13 * scale, 'rgba(43, 32, 26, 0.2)');

      ctx.save();
      ctx.translate(customer.x, feetY);
      if (walking) {
        ctx.rotate(Math.sin(customer.walkPhase) * 0.018);
      }
      ctx.scale(customer.facing < 0 ? -1 : 1, seated ? 0.95 : 1);
      ctx.drawImage(sprite.canvas, -width / 2, -height, width, height);
      ctx.restore();

      if (customer.cupInHand && customer.drink && this.sprites.drinks.length) {
        const s = customer.drink.sprite;
        const cupH = 50 * scale;
        const cupW = cupH * (s.w / s.h);
        const cupX = customer.x + customer.facing * 30 * scale;
        const cupY = feetY - 132 * scale;
        ctx.drawImage(s.canvas, cupX - cupW / 2, cupY - cupH / 2, cupW, cupH);
      }

      if (customer.vip) this.drawCrown(ctx, customer.x, feetY - height - 10, scale);
      if (customer.name) this.drawNameTag(ctx, customer, feetY - height - (customer.vip ? 34 : 12), scale);
      if (customer.bubble) this.drawBubble(ctx, customer.x, feetY - height - 6, customer.bubble, scale);
    }

    drawCrown(ctx, x, y, scale) {
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
      ctx.fillStyle = COLORS.sun;
      ctx.fill();
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }

    drawNameTag(ctx, customer, y, scale) {
      ctx.save();
      ctx.font = `800 ${Math.round(19 * clamp(scale, 0.8, 1.1))}px "Nunito", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = customer.gift ? `${customer.name} · ${customer.gift.name}` : customer.name;
      const text = ellipsize(ctx, label, 210);
      const tagH = 32;
      const tagW = Math.max(64, ctx.measureText(text).width + 26);
      const tagX = clamp(customer.x - tagW / 2, 10, W - tagW - 10);
      roundedRect(ctx, tagX, y - tagH, tagW, tagH, 12);
      ctx.fillStyle = customer.vip ? 'rgba(255, 223, 130, 0.97)' : 'rgba(255, 251, 240, 0.95)';
      ctx.fill();
      ctx.strokeStyle = COLORS.ink;
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
      const text = ellipsize(ctx, bubble.text, 330);
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
