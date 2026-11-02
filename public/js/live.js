/**
 * Sunny Side Sips — live UI controller
 * Keeps the original JSON-RPC 2.0 + WebSocket wiring and feeds TikTok Live
 * events into the drink shop simulation.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  document.body.classList.add('obs-mode');

  const isAdminMode = params.get('adminMode') === '1';
  if (isAdminMode) document.body.classList.remove('obs-mode');
  
  // ---------------------------------------------------------------- stage fit
  const stageWrapper = $('stageWrapper');
  const stage9x16 = $('stage9x16');
  function fitStage() {
    if (!stageWrapper || !stage9x16) return;
    const obs = document.body.classList.contains('obs-mode');
    const stacked = !obs && window.innerWidth < 1000;
    document.body.classList.toggle('stacked', stacked);

    const dock = $('quickDock');
    const dockWidth = obs || stacked ? 0 : (dock ? dock.offsetWidth + 22 : 0);
    const availWidth = Math.max(180, window.innerWidth - dockWidth - (stacked ? 16 : 44));
    const availHeight = Math.max(180, window.innerHeight * (obs ? 1 : stacked ? 0.63 : 0.96) - 24);
    const width = Math.min(availWidth, (availHeight * 9) / 16);

    stageWrapper.style.width = `${width}px`;
    stageWrapper.style.height = `${(width * 16) / 9}px`;
    stage9x16.style.transform = `scale(${width / 1080})`;
  }
  window.addEventListener('resize', fitStage);
  fitStage();

  // ------------------------------------------------------------------ engines
  const audio = new window.ShopAudioEngine();
  const fx = new window.DrinkShopFX($('fxCanvas'));
  const game = new window.ShopGame($('gameCanvas'));
  // Debug handle for OBS/console inspection (does not affect gameplay).
  window.shopGame = game;
  window.shopAudio = audio;
  // Start the background playlist right away; if the browser blocks autoplay the
  // player retries on the first pointer/key gesture.
  audio.startMusic();

  // Automatic shop announcer: speaks through the same Piper queue.
  const announcer = window.ShopAnnouncer
    ? new window.ShopAnnouncer({
        audio,
        getContext: () => ({
          stats: {
            customers: game.customers ? game.customers.length : 0,
            waiting: game.queue ? game.queue.length : 0,
            serving: Boolean(game.servingId)
          },
          viewers: game.viewers ? game.viewers.size : 0
        })
      })
    : null;
  window.shopAnnouncer = announcer;
  window.addEventListener('error', (e) => console.error('[ShopError]', e.message));

  let rpcId = 1;
  let ws = null;
  const pendingRpc = new Map();
  let autoSim = false;
  let mysteryTimer = null;
  let partyTimer = null;
  let donation = { totalCoins: 0, drinksServed: 0, giftsReceived: 0, recentGifts: [] };

  game.onSale = () => {
    audio.playRegister();
    updateHud();
  };
  // Tell the server which personal order was just handed over, so the viewer's
  // queue stays accurate across reconnects.
  game.onOrderServed = (info) => {
    if (!info || !info.viewerId) return;
    callRpc('shop.viewerServed', {
      user: info.name,
      uniqueId: info.uniqueId,
      orderId: info.orderId,
      count: 1
    });
  };
  game.load().then(updateHud);

  // --------------------------------------------------------------------- HUD
  const money = (v) => '$' + Number(v || 0).toFixed(2);

  function updateHud() {
    const stats = game.getStats();
    if ($('statServed')) $('statServed').textContent = stats.served.toLocaleString('en-US');
    if ($('statTips')) $('statTips').textContent = money(stats.tips);
    if ($('statCoins')) $('statCoins').textContent = Number(donation.totalCoins || 0).toLocaleString('en-US');
    if ($('statQueue')) $('statQueue').textContent = String(stats.queue);

    const chip = $('shopStateChip');
    if (chip) {
      const paused = stats.paused;
      chip.textContent = paused ? 'PAUSED' : game.settings.running ? 'RUNNING' : 'SLOW DAY';
      chip.classList.toggle('paused', paused);
      chip.classList.toggle('closed', !game.settings.running && !paused);
    }
    if ($('pausedOverlay')) $('pausedOverlay').classList.toggle('visible', stats.paused);
  }
  setInterval(updateHud, 400);

  let liveSnapshot = null;

  function formatLiveDuration(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    if (minutes) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
    return `${seconds}s`;
  }

  function liveStatusLabel(tiktok) {
    if (tiktok.connected) return 'CONNECTED';
    if (tiktok.connecting) return 'CONNECTING...';
    if (tiktok.reconnecting) return 'RECONNECTING...';
    if (tiktok.status === 'error' || tiktok.lastError) return 'CONNECTION ERROR';
    return 'DISCONNECTED';
  }

  function setLiveStatus(st) {
    if (st !== undefined) liveSnapshot = st;
    const tiktok = (liveSnapshot && liveSnapshot.tiktok) || {};
    const label = liveStatusLabel(tiktok);
    const stateEl = $('tiktokState');
    const metaEl = $('tiktokMeta');
    const dot = $('liveDot');
    const header = $('liveStatusText');

    if (stateEl) {
      stateEl.textContent = label;
      stateEl.className =
        'dock-live-state' +
        (label === 'CONNECTED'
          ? ' connected'
          : label === 'DISCONNECTED'
            ? ''
            : label === 'CONNECTION ERROR'
              ? ' error'
              : ' pending');
    }
    if (dot) dot.classList.toggle('connected', Boolean(tiktok.connected));

    let meta;
    if (tiktok.connected) {
      const parts = [`@${tiktok.username}`];
      parts.push(`LIVE ${formatLiveDuration(tiktok.durationMs)}`);
      parts.push(`${tiktok.viewerCount || 0} viewers`);
      const ev = tiktok.lastEvent;
      parts.push(
        ev
          ? `last event: ${ev.type} @${ev.user}${ev.detail ? ' · ' + ev.detail : ''}`
          : 'waiting for the first LIVE event…'
      );
      meta = parts.join(' · ');
    } else if (tiktok.connecting) {
      meta = `Opening the TikTok LIVE stream for @${tiktok.username || '…'}…`;
    } else if (tiktok.reconnecting) {
      meta = tiktok.lastError || 'Reconnecting to TikTok LIVE…';
    } else if (tiktok.status === 'error' || tiktok.lastError) {
      meta = tiktok.lastError || 'Connection failed.';
    } else {
      meta = 'Enter a live TikTok @username and press Connect.';
    }

    if (metaEl) metaEl.textContent = meta;
    if (header) {
      header.textContent = tiktok.connected
        ? `LIVE @${tiktok.username} · ${tiktok.viewerCount || 0} VIEWERS`
        : label === 'DISCONNECTED'
          ? 'DEMO MODE · TIKTOK OFFLINE'
          : `${label}${tiktok.username ? ' @' + tiktok.username : ''}`;
    }
  }

  // Keeps the connection duration ticking between server broadcasts.
  setInterval(() => setLiveStatus(), 1000);

  const TOP_MEDALS = ['🥇', '🥈', '🥉'];
  const VIP_NAMES = ['Regular Customer', 'VIP Customer', 'Super VIP', 'Diamond VIP'];
  let lastLeaderboardKey = '';
  let lastTopName = '';

  function vipNameFor(level) {
    return VIP_NAMES[Math.max(0, Math.min(3, Number(level) || 0))];
  }

  function initialFor(name) {
    const clean = String(name || '?').replace(/^@/, '').trim();
    return clean ? clean.charAt(0).toUpperCase() : '?';
  }

  function renderLeaderboard(list) {
    const el = $('leaderboardList');
    if (!el) return;
    if (!Array.isArray(list) || list.length === 0) {
      el.innerHTML = '<div class="lb-empty">No supporters yet.<br />Likes, follows and gifts show up here.</div>';
      lastLeaderboardKey = '';
      lastTopName = '';
      return;
    }
    const top = list.slice(0, 3);
    const key = top.map((item) => `${item.uniqueId || item.name}:${item.coins}`).join('|');
    const changed = key !== lastLeaderboardKey && lastLeaderboardKey !== '';
    lastLeaderboardKey = key;

    el.innerHTML = top
      .map((item, index) => {
        const level = Number(item.vipLevel) || 0;
        const isNew = changed && index === 0;
        const avatar = item.avatar
          ? `<img class="leader-avatar" src="${escapeHtml(item.avatar)}" alt="" />`
          : `<span class="leader-avatar fallback">${escapeHtml(initialFor(item.name))}</span>`;
        return `
        <div class="leader-item leader-top${isNew ? ' lb-new' : ''}">
          <span class="leader-medal">${TOP_MEDALS[index]}</span>
          ${avatar}
          <span class="leader-main">
            <span class="leader-name">${escapeHtml(shortName(item.name, 14))}</span>
            <span class="leader-vip vip-${level}">${level > 0 ? escapeHtml(vipNameFor(level)) : 'Supporter'}</span>
          </span>
          <span class="leader-coins">💰 ${Number(item.coins || 0).toLocaleString('en-US')}</span>
        </div>`;
      })
      .join('');

    const topName = top[0] && top[0].name;
    if (topName && lastTopName && topName !== lastTopName) {
      showNotice(`@${topName} is our new Top Supporter!`, 'vip');
    }
    lastTopName = topName || '';
  }

  // ------------------------------------------------------------- notifications
  let noticeSeq = 0;
  function showNotice(text, kind = 'thanks', duration = 3600) {
    const stack = $('noticeStack');
    if (!stack || !text) return;
    const id = `notice_${++noticeSeq}`;
    const el = document.createElement('div');
    el.className = `notice ${kind}`;
    el.id = id;
    el.textContent = text;
    stack.appendChild(el);
    while (stack.children.length > 4) stack.removeChild(stack.firstChild);
    setTimeout(() => {
      const node = document.getElementById(id);
      if (node) node.remove();
    }, duration);
  }

  const celebrationSeen = new Set();
  function celebrationOnce(key) {
    if (celebrationSeen.has(key)) return false;
    celebrationSeen.add(key);
    if (celebrationSeen.size > 500) {
      const first = celebrationSeen.values().next().value;
      celebrationSeen.delete(first);
    }
    return true;
  }

  let bannerTimerLocal = null;
  function showCelebrationBanner(title, sub, duration = 4200) {
    if ($('partyTitle')) $('partyTitle').textContent = title;
    if ($('partySub')) $('partySub').textContent = sub;
    const banner = $('partyBanner');
    if (!banner) return;
    banner.classList.add('visible');
    clearTimeout(bannerTimerLocal);
    bannerTimerLocal = setTimeout(() => banner.classList.remove('visible'), duration);
  }

  function runCelebration(ev) {
    const celebration = ev.celebration || {};
    const tier = celebration.tier || 'none';
    if (tier === 'none') return;
    const key = `cel_${ev.orderId || ev.id || ev.user}_${tier}`;
    if (!celebrationOnce(key)) return;

    const coins = Number(ev.coins) || celebration.coins || 0;
    const who = ev.user || 'a viewer';

    if (tier === 'small') {
      fx.confetti(50);
      fx.sparkle(540, 900, 14);
      audio.playCelebration();
      showCelebrationBanner('🎉 THANK YOU!', `@${who} · ${coins} coins`, 3200);
      game.cheerAll(0.8);
    } else if (tier === 'gold') {
      fx.confetti(110);
      fx.sparkle(540, 860, 32);
      audio.playCelebration();
      showCelebrationBanner('✨ GOLDEN CELEBRATION ✨', `@${who} · ${coins} coins`, 4400);
      game.cheerAll(1.3);
    } else if (tier === 'fireworks') {
      fx.fireworks(6);
      fx.confetti(120);
      audio.playFireworks();
      showCelebrationBanner('🎆 VIP CELEBRATION 🎆', `@${who} · ${coins} coins`, 5200);
      showNotice(`@${who} just became a VIP!`, 'vip');
      game.cheerAll(2);
    } else if (tier === 'grand') {
      fx.fireworks(10);
      fx.confetti(200);
      fx.sparkle(540, 800, 60);
      audio.playFireworks();
      showCelebrationBanner('👑 GRAND CELEBRATION 👑', `Wow! Thank you @${who} · ${coins} coins`, 6500);
      showNotice('Wow! Thank you for the amazing gift!', 'grand', 4600);
      game.cheerAll(3);
    }
  }

  function renderGiftTicker() {
    const el = $('giftTickerList');
    if (!el) return;
    const gifts = Array.isArray(donation.recentGifts) ? donation.recentGifts.slice(0, 4) : [];
    if (gifts.length === 0) {
      el.innerHTML = '<div class="gt-empty">Gifts buy drinks here</div>';
      return;
    }
    el.innerHTML = gifts
      .map(
        (gift) => `
        <div class="gt-row">
          <img class="gt-icon" src="${gift.giftIcon || ''}" alt="" />
          <span class="gt-name">${escapeHtml(shortName(gift.user || 'Viewer', 12))}</span>
          <span class="gt-drink">${escapeHtml(gift.drinkName || '')}</span>
        </div>`
      )
      .join('');
  }

  function renderFeed(events) {
    const feed = $('eventFeed');
    if (!feed || !Array.isArray(events)) return;
    feed.innerHTML = events.slice(0, 8).map((ev) => `<div class="event-feed-item">${formatEvent(ev)}</div>`).join('');
  }

  function renderCoinMenu(list) {
    const el = $('coinMenuList');
    if (!el || !Array.isArray(list)) return;
    el.innerHTML = list
      .map(
        (item) => `
        <div class="cm-row">
          <img class="cm-drink" src="${item.drinkImage}" alt="" />
          <span class="cm-name">${escapeHtml(item.drinkName)}</span>
          <span class="cm-coins"><img class="cm-gift" src="${item.giftIcon}" alt="" />${item.coins}</span>
        </div>`
      )
      .join('');
  }

  function formatEvent(ev) {
    switch (ev.type) {
      case 'serveDrink':
        return `🥤 <strong>${escapeHtml(ev.user)}</strong> got ${escapeHtml(ev.drink ? ev.drink.name : 'a drink')} (${money(ev.tip)})`;
      case 'commentOrder':
        return `💬 <strong>${escapeHtml(ev.user)}</strong>: “${escapeHtml(ev.message || ev.drink ? ev.drink.name : '')}”`;
      case 'likeBurst':
        return `❤️ <strong>${escapeHtml(ev.user)}</strong> sent ${ev.count} likes`;
      case 'followGuest':
        return `💛 <strong>${escapeHtml(ev.user)}</strong> followed — free drink!`;
      case 'freeDrink':
        return `🎁 <strong>${escapeHtml(ev.user)}</strong> got a free sample`;
      case 'partyOrder':
        return `🎉 <strong>${escapeHtml(ev.user)}</strong> sent ${escapeHtml(ev.giftName || 'a party tray')} · ${ev.groupSize} drinks`;
      case 'giftOrder':
        return `🎁 <strong>${escapeHtml(ev.user)}</strong> sent ${escapeHtml(ev.giftName || 'a gift')} → ${escapeHtml(ev.drink ? ev.drink.name : 'a drink')} · ${ev.coins} coins`;
      case 'mysteryDrink':
        return `🥤 <strong>${escapeHtml(ev.user)}</strong> rolled ${escapeHtml(ev.card ? ev.card.title : ev.drink.name)}`;
      case 'newGuest':
        return `🚶 <strong>${escapeHtml(ev.user)}</strong> walked in`;
      default:
        return `✨ <strong>${escapeHtml(ev.user || 'Someone')}</strong> interacted`;
    }
  }

  function applyServerState(st) {
    if (!st) return;
    if (st.settings) {
      game.applySettings(st.settings);

      if (typeof st.settings.musicVolume === 'number') {
        audio.setMusicVolume(st.settings.musicVolume);
        const pct = Math.round(st.settings.musicVolume * 100);
        if ($('sliderMusicVol')) $('sliderMusicVol').value = String(pct);
        if ($('valMusicVol')) $('valMusicVol').textContent = `${pct}%`;
      }
      if (typeof st.settings.ttsVolume === 'number') {
        audio.setTtsVolume(st.settings.ttsVolume);
        const pct = Math.round(st.settings.ttsVolume * 100);
        if ($('sliderTtsVol')) $('sliderTtsVol').value = String(pct);
        if ($('valTtsVol')) $('valTtsVol').textContent = `${pct}%`;
      }
      if (typeof st.settings.spawnRate === 'number') {
        const pct = Math.round(st.settings.spawnRate * 100);
        if ($('sliderSpawn')) $('sliderSpawn').value = String(pct);
        if ($('valSpawn')) $('valSpawn').textContent = `${(pct / 100).toFixed(2)}×`;
      }
      autoSim = Boolean(st.settings.autoSim);
      const simBtn = $('btnToggleAutoSim');
      if (simBtn) {
        simBtn.textContent = `🤖 Auto Demo: ${autoSim ? 'ON' : 'OFF'}`;
        simBtn.classList.toggle('active-toggle', autoSim);
      }
      if (typeof st.settings.sfxVolume === 'number') audio.setSfxVolume(st.settings.sfxVolume);
      audio.setMusicEnabled(st.settings.bgMusicEnabled !== false);
      audio.ttsEnabled = st.settings.ttsEnabled !== false;
      if (typeof st.settings.ttsLanguage === 'string') audio.ttsLanguage = st.settings.ttsLanguage;
      if (typeof st.settings.ttsVoice === 'string' && st.settings.ttsVoice) audio.ttsVoice = st.settings.ttsVoice;
      if (typeof st.settings.ttsSpeed === 'number') audio.ttsSpeed = st.settings.ttsSpeed;
      // Announcements stop with the shop, and never talk over a paused game.
      if (announcer) announcer.setPaused(Boolean(st.settings.paused) || st.settings.running === false);
      const ttsBtn = $('btnToggleTts');
      if (ttsBtn) {
        ttsBtn.textContent = `🎙️ Voice: ${audio.ttsEnabled ? 'ON' : 'OFF'}`;
        ttsBtn.classList.toggle('active-toggle', audio.ttsEnabled);
      }
      const musicBtn = $('btnToggleMusic');
      if (musicBtn) {
        musicBtn.textContent = `🎵 Music: ${audio.bgMusicEnabled ? 'ON' : 'OFF'}`;
        musicBtn.classList.toggle('active-toggle', audio.bgMusicEnabled);
      }
    }
    if (st.donation) {
      donation = { ...donation, ...st.donation };
      renderGiftTicker();
    }
    if (st.coinMenu) {
      renderCoinMenu(st.coinMenu);
    }
    if (st.viewers) game.syncViewers(st.viewers);
    renderLeaderboard(st.leaderboard);
    renderFeed(st.recentEvents);
    setLiveStatus(st);
    updateHud();
  }

  // ----------------------------------------------------------- event visuals
  function showMysteryCard(ev) {
    const card = ev.card || {};
    const drink = ev.drink || {};
    if ($('mysteryRank')) $('mysteryRank').textContent = String(card.rank || "TODAY'S PICK").toUpperCase();
    if ($('mysteryTitle')) $('mysteryTitle').textContent = card.title || drink.name || 'Mystery Sip';
    if ($('mysteryPoem')) $('mysteryPoem').textContent = card.poem || '';
    if ($('mysteryNote')) {
      $('mysteryNote').textContent = card.meaning || `${drink.name || 'Fresh drink'} · ${money(drink.price || 0)}`;
    }
    if ($('mysteryDrinkImg') && drink.image) $('mysteryDrinkImg').src = drink.image;

    const cardEl = $('mysteryCard');
    if (!cardEl) return;
    cardEl.classList.add('visible');
    clearTimeout(mysteryTimer);
    mysteryTimer = setTimeout(() => cardEl.classList.remove('visible'), 9000);
  }

  function showPartyBanner(ev) {
    if ($('partyTitle')) $('partyTitle').textContent = `🎉 ${String(ev.giftName || 'DRINK PARTY').toUpperCase()} 🎉`;
    if ($('partySub')) {
      $('partySub').textContent = `${ev.user} ordered ${ev.groupSize || 2} drinks · ${money(ev.tip)} tip`;
    }
    const banner = $('partyBanner');
    if (!banner) return;
    banner.classList.add('visible');
    clearTimeout(partyTimer);
    partyTimer = setTimeout(() => banner.classList.remove('visible'), 6500);
  }

  function showGiftBanner(ev) {
    const gift = ev.gift || {};
    if ($('giftBannerIcon')) $('giftBannerIcon').src = ev.giftIcon || gift.icon || '';
    if ($('giftBannerDrink')) $('giftBannerDrink').src = ev.drink && ev.drink.image ? ev.drink.image : '';
    if ($('partyTitle')) {
      $('partyTitle').textContent = `${String(ev.giftName || gift.name || 'GIFT').toUpperCase()} → ${String(
        ev.drink ? ev.drink.name : 'DRINK'
      ).toUpperCase()}`;
    }
    if ($('partySub')) {
      $('partySub').textContent = `${ev.user} · ${Number(ev.coins || 0)} coin${Number(ev.coins) === 1 ? '' : 's'} · ${
        ev.units > 1 ? ev.units + ' drinks' : '1 drink'
      }`;
    }
    const banner = $('partyBanner');
    if (!banner) return;
    banner.classList.add('visible');
    clearTimeout(partyTimer);
    partyTimer = setTimeout(() => banner.classList.remove('visible'), 7000);
  }

  function handleTestEvent(ev) {
    if (!ev) return;
    if (ev.type === 'vipUpgrade' || ev.vipLevel) {
      audio.playVipUpgrade();
      showNotice(`@${ev.user} just became a ${vipNameFor(ev.vipLevel)}!`, 'vip');
      fx.sparkle(540, 900, 28);
    }
    if (ev.celebration && ev.celebration.tier !== 'none') {
      runCelebration({ ...ev, orderId: `test_${ev.id}` });
    }
    game.cheerAll(1.2);
  }

  function handleServerEvent(ev) {
    if (!ev) return;
    if (ev.test) {
      handleTestEvent(ev);
      return;
    }
    game.handleEvent(ev);
    if (
      announcer &&
      ['giftOrder', 'partyOrder', 'followGuest', 'commentOrder', 'likeBurst', 'mysteryDrink'].includes(ev.type)
    ) {
      // Personalized replies take the stage first — no generic line right after.
      announcer.notifyPersonalized();
    }

    switch (ev.type) {
      case 'serveDrink':
      case 'commentOrder':
        audio.playServiceBell();
        fx.sparkle(742, 1060, 8);
        break;
      case 'mysteryDrink':
        audio.playServiceBell();
        fx.sparkle(742, 1060, 14);
        showMysteryCard(ev);
        break;
      case 'followGuest':
      case 'freeDrink':
        audio.playParty();
        fx.hearts(760, 1040, 14);
        fx.sparkle(760, 1000, 12);
        showNotice(`@${ev.user} sent some love — VIP sparkle!`, 'vip');
        break;
      case 'likeBurst':
        audio.playHeartPop();
        fx.hearts(560 + Math.random() * 200, 1500, Math.min(18, 4 + (Number(ev.count) || 1)));
        break;
      case 'partyOrder':
        audio.playParty();
        fx.confetti(90);
        showPartyBanner(ev);
        break;
      case 'giftOrder': {
        audio.playCoin();
        showGiftBanner(ev);
        if (celebrationOnce(`thanks_${ev.orderId || ev.id}`)) {
          showNotice(`Thank you @${ev.user} for the support!`, 'thanks');
        }
        if (ev.vipUpgraded) {
          audio.playVipUpgrade();
          showNotice(`@${ev.user} just became a ${vipNameFor(ev.vipLevel)}!`, `vip vip-${Number(ev.vipLevel) || 1}`);
          fx.sparkle(540, 940, 22);
        }
        if (ev.celebration) runCelebration(ev);
        break;
      }
      case 'newGuest':
      case 'viewerJoin':
      case 'viewerReconnect':
        audio.playCupClink();
        if (ev.type === 'viewerJoin') {
          showNotice(`@${ev.user} joined the shop!`, 'join', 2800);
          if (announcer) announcer.greetViewer(ev.user);
        }
        break;
      case 'viewerLeave':
        audio.playServiceBell();
        if (celebrationOnce(`leave_${ev.viewerId}_${ev.id}`)) {
          showNotice(`@${ev.user} left — thanks for stopping by!`, 'join', 2800);
        }
        break;
      default:
        break;
    }

    if (ev.ttsText) {
      audio.enqueueTts(ev.ttsText, {
        voice: ev.ttsVoice,
        language: ev.ttsLanguage,
        speed: ev.ttsSpeed,
        priority: ev.type === 'giftOrder' || ev.type === 'partyOrder' ? 0 : 1
      });
    }
    updateHud();
  }

  // ------------------------------------------------------------------- socket
  function connectWebSocket() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${window.location.host}/ws`);

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      // JSON-RPC responses (success or error) for calls sent over the socket.
      if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
        const pending = pendingRpc.get(msg.id);
        if (pending) {
          pendingRpc.delete(msg.id);
          pending.resolve(msg);
          if (msg.error) {
            setDockStatus(`Error: ${msg.error.message}`);
            if (pending.method === 'live.connect') {
              liveSnapshot = liveSnapshot || {};
              liveSnapshot.tiktok = {
                ...(liveSnapshot.tiktok || {}),
                connected: false,
                connecting: false,
                reconnecting: false,
                status: 'error',
                lastError: msg.error.message
              };
              setLiveStatus();
            }
          }
        }
        return;
      }
      if (msg.method === 'temple.state') {
        applyServerState(msg.params);
      } else if (msg.method === 'temple.event') {
        if (msg.params && msg.params.state) applyServerState(msg.params.state);
        handleServerEvent(msg.params && msg.params.event);
      } else if (msg.method === 'shop.reset') {
        if (msg.params && msg.params.soft === false) {
          game.reset();
          updateHud();
        }
      } else if (msg.method === 'shop.spawn') {
        handleServerEvent({ type: 'newGuest', user: 'Walk-in guest' });
      } else if (msg.method === 'tts.play') {
        if (msg.params && msg.params.url) {
          audio.enqueueTts(msg.params.text || 'Welcome to Sunny Side Sips!', {
            voice: msg.params.voice,
            language: msg.params.language,
            speed: msg.params.speed,
            url: msg.params.url,
            priority: 0
          });
        }
      }
    };

    ws.onclose = () => {
      for (const pending of pendingRpc.values()) {
        pending.resolve({ error: { message: 'WebSocket closed before the server replied.' } });
      }
      pendingRpc.clear();
      setTimeout(connectWebSocket, 2200);
    };
    ws.onerror = () => {};
  }
  connectWebSocket();

  async function callRpc(method, rpcParams = {}) {
    audio.ensureContext();
    const id = rpcId++;
    const payload = { jsonrpc: '2.0', id, method, params: rpcParams };
    if (ws && ws.readyState === WebSocket.OPEN) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingRpc.delete(id);
          resolve({ error: { message: 'No response from the server (timeout).' } });
        }, 20000);
        pendingRpc.set(id, {
          method,
          resolve: (data) => {
            clearTimeout(timer);
            resolve(data);
          }
        });
        ws.send(JSON.stringify(payload));
      });
    }
    try {
      const res = await fetch('/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.error) setDockStatus(`Error: ${data.error.message}`);
      else if (data.result && data.result.event) handleServerEvent(data.result.event);
      else if (data.result && data.result.settings) applyServerState(data.result);
      return data;
    } catch (err) {
      setDockStatus(`Offline: ${err.message}`);
      return null;
    }
  }

  function setDockStatus(text) {
    if ($('dockStatus')) $('dockStatus').textContent = text;
  }

  // ------------------------------------------------------------------ helpers
  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function shortName(name, max) {
    const str = String(name || '');
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
  }
  function viewerName() {
    const value = ($('inputViewerName') && $('inputViewerName').value.trim()) || '';
    return value || 'Mia Carter';
  }
  function orderText() {
    const value = ($('inputOrderNote') && $('inputOrderNote').value.trim()) || '';
    return value || 'One fresh lemonade, extra ice please!';
  }

  // ------------------------------------------------------------------ actions
  function triggerFollow() {
    callRpc('shop.follow', { user: viewerName() });
    setDockStatus('Follow sent — free drink customer incoming.');
  }
  function triggerLike() {
    callRpc('shop.like', { user: viewerName(), count: 6 });
    setDockStatus('Like rush sent.');
  }
  function triggerComment() {
    callRpc('shop.comment', { user: viewerName(), comment: orderText() });
    setDockStatus('Comment order sent.');
  }
  function triggerGift() {
    callRpc('shop.giftOrder', { user: viewerName(), giftId: 'rose', units: 1 });
    setDockStatus('Rose gift sent — a drink order is queued.');
  }
  function viewerIdFor(name) {
    const slug = String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '');
    return slug || 'guest';
  }
  function triggerJoin() {
    callRpc('shop.join', { user: viewerName(), uniqueId: viewerIdFor(viewerName()) });
    setDockStatus('Viewer character joined the shop.');
  }
  function triggerLeave() {
    callRpc('shop.leave', { user: viewerName(), uniqueId: viewerIdFor(viewerName()) });
    setDockStatus('Viewer is leaving the shop.');
  }
  function triggerMystery() {
    callRpc('shop.mysteryDrink', { user: viewerName() });
    setDockStatus('Mystery sip drawn.');
  }

  $('btnRpcFollow')?.addEventListener('click', triggerFollow);
  $('btnRpcLike')?.addEventListener('click', triggerLike);
  $('btnRpcComment')?.addEventListener('click', triggerComment);
  $('btnRpcGift')?.addEventListener('click', triggerGift);
  $('btnRpcMystery')?.addEventListener('click', triggerMystery);
  $('btnRpcJoin')?.addEventListener('click', triggerJoin);
  $('btnRpcLeave')?.addEventListener('click', triggerLeave);

  $('cardFollow')?.addEventListener('click', triggerFollow);
  $('cardLike')?.addEventListener('click', triggerLike);
  $('cardComment')?.addEventListener('click', triggerComment);
  $('cardGift')?.addEventListener('click', triggerGift);

  // ------------------------------------------------------------ game controls
  $('btnStart')?.addEventListener('click', () => {
    game.setPaused(false);
    game.setRunning(true);
    callRpc('game.start');
    setDockStatus('Shop is running.');
    updateHud();
  });

  $('btnPause')?.addEventListener('click', () => {
    const next = !game.settings.paused;
    game.setPaused(next);
    callRpc('game.pause', { paused: next });
    setDockStatus(next ? 'Shop paused.' : 'Shop resumed.');
    updateHud();
  });

  $('btnReset')?.addEventListener('click', () => {
    game.reset();
    game.setPaused(false);
    callRpc('game.reset');
    setDockStatus('Shop reset. Counters cleared.');
    updateHud();
  });

  $('btnSpawn')?.addEventListener('click', () => {
    // When the socket is down the server event cannot arrive, so spawn locally.
    if (!ws || ws.readyState !== WebSocket.OPEN) game.spawn({ name: 'Walk-in guest' });
    callRpc('game.spawnCustomer');
    setDockStatus('A customer walked in.');
  });

  const spawnSlider = $('sliderSpawn');
  if (spawnSlider) {
    spawnSlider.addEventListener('input', (e) => {
      const rate = Number(e.target.value) / 100;
      game.setSpawnRate(rate);
      if ($('valSpawn')) $('valSpawn').textContent = `${rate.toFixed(2)}×`;
    });
    spawnSlider.addEventListener('change', (e) => {
      callRpc('game.setSpawnRate', { rate: Number(e.target.value) / 100 });
    });
  }

  // ------------------------------------------------------------------ tiktok
  $('btnConnectTikTok')?.addEventListener('click', async () => {
    const username = ($('inputTikTokUser') && $('inputTikTokUser').value.trim()) || '';
    if (!username) {
      setDockStatus('Enter a TikTok @username first.');
      return;
    }
    const btn = $('btnConnectTikTok');
    if (btn) btn.disabled = true;
    setDockStatus(`Connecting to ${username}…`);
    const data = await callRpc('live.connect', { username });
    if (btn) btn.disabled = false;
    if (!data || data.error) {
      setDockStatus(`Connection error: ${data && data.error ? data.error.message : 'no response from server'}`);
      return;
    }
    setDockStatus(`TikTok LIVE connected to @${(data.result && data.result.username) || username.replace(/^@/, '')}.`);
  });

  $('btnDisconnectTikTok')?.addEventListener('click', async () => {
    const btn = $('btnDisconnectTikTok');
    if (btn) btn.disabled = true;
    await callRpc('live.disconnect');
    if (btn) btn.disabled = false;
    setDockStatus('TikTok disconnected.');
  });

  $('btnToggleAutoSim')?.addEventListener('click', () => {
    autoSim = !autoSim;
    callRpc('live.setAutoSim', { enabled: autoSim });
    setDockStatus(`Auto demo ${autoSim ? 'enabled' : 'disabled'}.`);
  });

  // ------------------------------------------------------------------- audio
  $('btnUnlockAudio')?.addEventListener('click', () => {
    audio.ensureContext();
    audio.startMusic();
    const btn = $('btnUnlockAudio');
    if (btn) {
      btn.textContent = '🔊 Shop Sound On';
      btn.classList.add('active-toggle');
    }
  });

  $('btnToggleTts')?.addEventListener('click', (e) => {
    audio.ttsEnabled = !audio.ttsEnabled;
    e.currentTarget.textContent = `🎙️ Voice: ${audio.ttsEnabled ? 'ON' : 'OFF'}`;
    e.currentTarget.classList.toggle('active-toggle', audio.ttsEnabled);
    callRpc('temple.updateSettings', { ttsEnabled: audio.ttsEnabled });
  });

  $('btnToggleMusic')?.addEventListener('click', (e) => {
    audio.setMusicEnabled(!audio.bgMusicEnabled);
    e.currentTarget.textContent = `🎵 Music: ${audio.bgMusicEnabled ? 'ON' : 'OFF'}`;
    e.currentTarget.classList.toggle('active-toggle', audio.bgMusicEnabled);
    callRpc('temple.updateSettings', { bgMusicEnabled: audio.bgMusicEnabled });
  });

  const sliderMusicVol = $('sliderMusicVol');
  if (sliderMusicVol) {
    sliderMusicVol.addEventListener('input', (e) => {
      const pct = Number(e.target.value);
      if ($('valMusicVol')) $('valMusicVol').textContent = `${pct}%`;
      audio.ensureContext();
      audio.setMusicVolume(pct / 100);
    });
    sliderMusicVol.addEventListener('change', (e) => {
      callRpc('temple.updateSettings', { musicVolume: Number(e.target.value) / 100 });
    });
  }

  const sliderTtsVol = $('sliderTtsVol');
  if (sliderTtsVol) {
    sliderTtsVol.addEventListener('input', (e) => {
      const pct = Number(e.target.value);
      if ($('valTtsVol')) $('valTtsVol').textContent = `${pct}%`;
      audio.setTtsVolume(pct / 100);
    });
    sliderTtsVol.addEventListener('change', (e) => {
      callRpc('temple.updateSettings', { ttsVolume: Number(e.target.value) / 100 });
    });
  }

  document.addEventListener('pointerdown', () => audio.ensureContext(), { once: true });
})();
