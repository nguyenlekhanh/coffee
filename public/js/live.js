/**
 * Sunny Side Sips — live UI controller
 * Keeps the original JSON-RPC 2.0 + WebSocket wiring and feeds TikTok Live
 * events into the drink shop simulation.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  if (params.get('obs') === '1') document.body.classList.add('obs-mode');

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
  window.addEventListener('error', (e) => console.error('[ShopError]', e.message));

  let rpcId = 1;
  let ws = null;
  let autoSim = false;
  let mysteryTimer = null;
  let partyTimer = null;
  let donation = { totalCoins: 0, drinksServed: 0, giftsReceived: 0, recentGifts: [] };

  game.onSale = () => {
    audio.playRegister();
    updateHud();
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

  function setLiveStatus(st) {
    const dot = $('liveDot');
    const text = $('liveStatusText');
    if (!dot || !text) return;
    const tiktok = st && st.tiktok ? st.tiktok : {};
    if (tiktok.connected) {
      dot.classList.add('connected');
      text.textContent = `LIVE @${tiktok.username || 'shop'} · ${tiktok.viewerCount || 0} VIEWERS`;
    } else if (tiktok.connecting) {
      dot.classList.remove('connected');
      text.textContent = `CONNECTING @${tiktok.username || ''}…`;
    } else {
      dot.classList.remove('connected');
      text.textContent = 'DEMO MODE · TIKTOK OFFLINE';
    }
  }

  function renderLeaderboard(list) {
    const el = $('leaderboardList');
    if (!el) return;
    if (!Array.isArray(list) || list.length === 0) {
      el.innerHTML = '<div class="lb-empty">No supporters yet.<br />Likes, follows and gifts show up here.</div>';
      return;
    }
    el.innerHTML = list
      .slice(0, 4)
      .map(
        (item) => `
        <div class="leader-item">
          <span class="leader-rank">${item.rank}</span>
          <span class="leader-name">${escapeHtml(shortName(item.name, 15))}</span>
          <span class="leader-tip">💰 ${Number(item.coins || 0).toLocaleString('en-US')}</span>
        </div>`
      )
      .join('');
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
      audio.setMusicEnabled(st.settings.bgMusicEnabled !== false);
      audio.ttsEnabled = st.settings.ttsEnabled !== false;
      if (typeof st.settings.ttsLanguage === 'string') audio.ttsLanguage = st.settings.ttsLanguage;
      if (typeof st.settings.ttsVoice === 'string' && st.settings.ttsVoice) audio.ttsVoice = st.settings.ttsVoice;
      if (typeof st.settings.ttsSpeed === 'number') audio.ttsSpeed = st.settings.ttsSpeed;
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

  function handleServerEvent(ev) {
    if (!ev) return;
    game.handleEvent(ev);

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
      case 'giftOrder':
        audio.playParty();
        fx.confetti(70);
        showGiftBanner(ev);
        break;
      case 'newGuest':
        audio.playCupClink();
        break;
      default:
        break;
    }

    if (ev.ttsText) {
      audio.enqueueTts(ev.ttsText, {
        voice: ev.ttsVoice,
        language: ev.ttsLanguage,
        speed: ev.ttsSpeed
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
            url: msg.params.url
          });
        }
      }
    };

    ws.onclose = () => setTimeout(connectWebSocket, 2200);
    ws.onerror = () => {};
  }
  connectWebSocket();

  async function callRpc(method, rpcParams = {}) {
    audio.ensureContext();
    const payload = { jsonrpc: '2.0', id: rpcId++, method, params: rpcParams };
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return null;
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
  function triggerMystery() {
    callRpc('shop.mysteryDrink', { user: viewerName() });
    setDockStatus('Mystery sip drawn.');
  }

  $('btnRpcFollow')?.addEventListener('click', triggerFollow);
  $('btnRpcLike')?.addEventListener('click', triggerLike);
  $('btnRpcComment')?.addEventListener('click', triggerComment);
  $('btnRpcGift')?.addEventListener('click', triggerGift);
  $('btnRpcMystery')?.addEventListener('click', triggerMystery);

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
  $('btnConnectTikTok')?.addEventListener('click', () => {
    const username = ($('inputTikTokUser') && $('inputTikTokUser').value.trim()) || '';
    if (!username) {
      setDockStatus('Enter a TikTok @username first.');
      return;
    }
    setDockStatus(`Connecting to ${username}…`);
    callRpc('live.connect', { username });
  });

  $('btnDisconnectTikTok')?.addEventListener('click', () => {
    callRpc('live.disconnect');
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
