(() => {
  'use strict';
  const $app = document.getElementById('app');
  const SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const isRed = (c) => c.suit === 'H' || c.suit === 'D';
  const base = (c) => (c.rank === 'A' ? 11 : 'JQK'.includes(c.rank) ? 10 : parseInt(c.rank, 10));
  const atkVal = (c) => (isRed(c) ? base(c) : base(c) * 2);
  const defVal = (c) => (isRed(c) ? base(c) * 2 : base(c));
  const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    del: (k) => { try { localStorage.removeItem(k); } catch {} },
  };

  let ws = null;
  let online = false;
  let msg = null; // dernier état reçu {room, game}
  let sel = { hand: new Set(), tgt: new Set(), def: new Set() };
  let selKey = '';
  let toast = '';
  let toastTimer = null;
  let form = { name: store.get('name') || '', code: '' };

  // ---------- Réseau ----------
  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    ws.onopen = () => {
      online = true;
      const s = JSON.parse(store.get('session') || 'null');
      if (s) send({ t: 'resume', code: s.code, token: s.token });
      render();
    };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
    ws.onclose = () => {
      online = false;
      render();
      setTimeout(connect, 1500);
    };
  }
  const send = (o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
  const act = (a) => send({ t: 'act', a });

  function showToast(text) {
    toast = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = ''; render(); }, 3500);
  }

  function handle(m) {
    switch (m.t) {
      case 'joined':
        store.set('session', JSON.stringify({ code: m.code, token: m.token }));
        break;
      case 'state':
        msg = m;
        sanitizeSel();
        render();
        break;
      case 'error':
        showToast(m.msg);
        render();
        break;
      case 'resume_failed':
        store.del('session');
        msg = null;
        render();
        break;
      case 'closed':
        store.del('session');
        msg = null;
        resetSel();
        if (m.msg) showToast(m.msg);
        render();
        break;
    }
  }

  // ---------- Sélection ----------
  function resetSel() { sel = { hand: new Set(), tgt: new Set(), def: new Set() }; }
  function sanitizeSel() {
    const g = msg && msg.game;
    if (!g) return resetSel();
    const key = g.phase + ':' + g.turn;
    if (key !== selKey) { selKey = key; resetSel(); return; }
    const has = (set, ids) => { for (const id of [...set]) if (!ids.includes(id)) set.delete(id); };
    has(sel.hand, g.me.hand.map((c) => c.id));
    has(sel.tgt, g.opp.defense.map((d) => d.id));
    has(sel.def, g.me.defense.map((d) => d.id));
  }
  function toggle(set, id, max) {
    if (set.has(id)) set.delete(id);
    else if (set.size < max) set.add(id);
    else if (max === 1 || max === 2) { set.delete([...set][0]); set.add(id); }
    render();
  }

  // ---------- Rendu des cartes ----------
  function cardHtml(c, o = {}) {
    const cls = ['card'];
    if (!c) cls.push('back');
    else cls.push(isRed(c) ? 'red' : 'black');
    if (o.click) cls.push('click');
    if (o.sel) cls.push('sel');
    if (o.mineHidden) cls.push('mine-hidden');
    if (o.revealed) cls.push('revealed');
    const data = o.data ? ` data-a="${o.data[0]}" data-id="${o.data[1]}"` : '';
    if (!c) return `<div class="${cls.join(' ')}"${data}></div>`;
    const sym = SYM[c.suit];
    const red = isRed(c);
    return `<div class="${cls.join(' ')}"${data} title="${c.rank}${sym} — attaque ${atkVal(c)}, défense ${defVal(c)}">
      <div class="corner">${c.rank}<br>${sym}</div>
      <div class="pip">${sym}</div>
      <div class="vals"><span class="${red ? '' : 'x2 atk'}">⚔${atkVal(c)}</span><span class="${red ? 'x2' : ''}">🛡${defVal(c)}</span></div>
    </div>`;
  }
  const miniCards = (cards) => `<div class="mini">${cards.map((c) => cardHtml(c)).join('')}</div>`;

  function defenseRow(entries, kind, g) {
    // kind: 'me' | 'opp'
    const myTurn = g.phase === 'play' && g.turn === g.you;
    let html = '';
    for (let i = 0; i < 4; i++) {
      const d = entries[i];
      if (!d) { html += '<div class="slot"></div>'; continue; }
      if (kind === 'opp') {
        html += cardHtml(d.card, { data: ['tgt', d.id], click: myTurn, sel: sel.tgt.has(d.id), revealed: d.up });
      } else {
        const revealPhase = g.phase === 'reveal' && !g.me.revealDone;
        html += cardHtml(d.card, {
          data: ['def', d.id], click: revealPhase, sel: sel.def.has(d.id), mineHidden: !d.up, revealed: d.up,
        });
      }
    }
    return `<div class="row">${html}</div>`;
  }

  // ---------- Écrans ----------
  function renderLobby() {
    return `
    ${online ? '' : '<div class="banner">Connexion au serveur…</div>'}
    <div class="lobby">
      <div class="suits"><span class="r">♥</span>♠<span class="r">♦</span>♣</div>
      <h1>BASTION</h1>
      <p class="sub">Brisez la défense de votre adversaire.</p>
      <div class="card-panel">
        <div><label for="name">Votre pseudo</label>
          <input id="name" maxlength="16" placeholder="Joueur" value="${esc(form.name)}"></div>
        <button class="btn primary" data-a="create" ${online ? '' : 'disabled'}>Créer une partie en ligne</button>
        <div class="sep">ou rejoindre un ami</div>
        <div class="row-join">
          <input id="code" class="code" maxlength="4" placeholder="CODE" value="${esc(form.code)}">
          <button class="btn" data-a="join" ${online ? '' : 'disabled'}>Rejoindre</button>
        </div>
        <div class="sep">ou</div>
        <button class="btn" data-a="bot" ${online ? '' : 'disabled'}>S'entraîner contre l'ordinateur</button>
        <button class="btn small" data-a="rules">Lire les règles</button>
      </div>
      <div class="err">${esc(toast)}</div>
    </div>`;
  }

  function renderWaiting() {
    return `
    <div class="waiting">
      <h2>En attente d'un adversaire…</h2>
      <p>Donnez ce code à votre ami :</p>
      <div class="big-code">${esc(msg.room.code)}</div>
      <p><button class="btn" data-a="copy">Copier le lien d'invitation</button></p>
      <p><button class="btn small danger" data-a="leave">Annuler</button></p>
    </div>`;
  }

  function statusHtml(g, room) {
    const myTurn = g.phase === 'play' && g.turn === g.you;
    const names = room.names;
    const oppName = esc(names[1 - g.you]);
    let text = '';
    let controls = '';
    let preview = '';

    if (g.phase === 'setup') {
      if (!g.me.setupDone) {
        text = `Choisissez 4 cartes de votre main à poser face cachée en défense (${sel.hand.size}/4).`;
        controls = `<button class="btn primary" data-a="setup" ${sel.hand.size === 4 ? '' : 'disabled'}>Poser ma défense</button>`;
      } else text = `Défense posée. En attente de ${oppName}…`;
    } else if (g.phase === 'reveal') {
      if (!g.me.revealDone) {
        text = `Retournez 2 de vos 4 cartes de défense (${sel.def.size}/2).`;
        controls = `<button class="btn primary" data-a="reveal" ${sel.def.size === 2 ? '' : 'disabled'}>Retourner ces cartes</button>`;
      } else text = `En attente de ${oppName}…`;
    } else if (g.phase === 'play') {
      if (myTurn) {
        const free = 4 - g.me.defense.length;
        const nh = sel.hand.size, nt = sel.tgt.size;
        text = g.added > 0
          ? `Votre tour : ${g.added} carte(s) ajoutée(s). Vous pouvez attaquer ou terminer le tour.`
          : 'Votre tour : renforcez votre défense et/ou attaquez.';
        controls = `
          <button class="btn" data-a="add" ${nh >= 1 && nh <= free ? '' : 'disabled'} title="${free ? '' : 'Défense pleine'}">Ajouter à ma défense</button>
          <button class="btn primary" data-a="attack" ${nh >= 1 && nh <= 2 && nt >= 1 && nt <= 2 * nh ? '' : 'disabled'}>Attaquer</button>
          <button class="btn" data-a="end" ${g.added >= 1 ? '' : 'disabled'}>Terminer le tour</button>`;
        if (nh && nt > 2 * nh) {
          preview = `<span class="ko">Une carte d'attaque ne peut viser que 2 cartes : ${nt} cibles demandent ${Math.ceil(nt / 2)} cartes d'attaque.</span>`;
        } else if (nh && nt) {
          const hand = g.me.hand.filter((c) => sel.hand.has(c.id));
          const atk = hand.reduce((s, c) => s + atkVal(c), 0);
          const targets = g.opp.defense.filter((d) => sel.tgt.has(d.id));
          const known = targets.filter((d) => d.card).reduce((s, d) => s + defVal(d.card), 0);
          const hidden = targets.filter((d) => !d.card).length;
          let verdict = '';
          if (!hidden) verdict = atk >= known ? '<span class="ok">✔ suffisant</span>' : '<span class="ko">✘ insuffisant</span>';
          preview = `Attaque <b>${atk}</b> pts contre <b>${known}${hidden ? ` + ${hidden} carte(s) cachée(s)` : ''}</b> pts ${verdict}`;
        } else if (nh) preview = 'Sélectionnez maintenant les cartes adverses à viser (ou ajoutez à votre défense).';
        else preview = 'Cliquez sur vos cartes en main, puis sur les cartes adverses visées.';
      } else text = `Tour de ${oppName}…`;
    }
    return `<div class="status"><div class="msg">${text}</div>${controls ? `<div class="controls">${controls}</div>` : ''}${preview ? `<div class="preview">${preview}</div>` : ''}</div>`;
  }

  function lastHtml(g, room) {
    const a = g.lastAttack;
    if (!a) return '';
    const who = a.attacker === g.you ? 'Votre attaque' : `Attaque de ${esc(room.names[a.attacker])}`;
    return `<div class="last" id="last-${a.n}">
      <div class="who">${who}</div>
      ${miniCards(a.cards)} <span class="score">${a.atk}</span>
      <span class="vs">contre</span>
      ${miniCards(a.targets)} <span class="score">${a.def}</span>
      <span class="res ${a.success ? 'win' : 'fail'}">${a.success ? 'Défense brisée' : 'Défense tenue'}</span>
    </div>`;
  }

  function logHtml(g, room) {
    const lines = [...g.log].reverse().map((l) => {
      if (l.seat === null) return `<div class="l sys">${esc(l.msg)}</div>`;
      return `<div class="l"><b class="p${l.seat}">${esc(room.names[l.seat])}</b> ${esc(l.msg)}</div>`;
    });
    return `<aside class="log"><h3>Journal</h3>${lines.join('')}</aside>`;
  }

  function overlayHtml(g, room) {
    if (g.phase !== 'over') return '';
    const won = g.winner === g.you;
    const iWait = room.rematch[g.you];
    return `<div class="overlay"><div class="box">
      <h2>${won ? '🏆 Victoire !' : 'Défaite'}</h2>
      <p>${won ? 'Vous avez détruit toute la défense adverse.' : `${esc(room.names[g.winner])} a détruit toute votre défense.`}</p>
      <div class="btns">
        <button class="btn primary" data-a="rematch" ${iWait ? 'disabled' : ''}>${iWait ? 'En attente de l\'adversaire…' : 'Rejouer'}</button>
        <button class="btn" data-a="leave">Quitter</button>
      </div></div></div>`;
  }

  function renderGame() {
    const { room, game: g } = msg;
    const you = g.you;
    const myTurn = g.phase === 'play' && g.turn === you;
    const oppTurn = g.phase === 'play' && g.turn !== you;
    const oppConnected = room.connected[1 - you];
    const handSel = g.phase === 'setup' ? !g.me.setupDone : myTurn;
    const oppHand = Array.from({ length: g.opp.handCount }, () => cardHtml(null)).join('');
    const handMax = g.phase === 'setup' ? 4 : 2;

    return `
    ${online ? '' : '<div class="banner">Connexion perdue… reconnexion en cours</div>'}
    <div class="game">
      <div class="board">
        <div class="topbar">
          <div class="room">Salon <b>${esc(room.code)}</b>${room.vsBot ? ' · contre l\'ordinateur' : ''}</div>
          <div class="actions">
            <button class="btn small" data-a="rules">Règles</button>
            <button class="btn small danger" data-a="leave">Quitter</button>
          </div>
        </div>

        <section class="zone ${oppTurn ? 'active' : ''}">
          <div class="zone-head">
            <span class="pname"><span class="dot ${oppConnected ? '' : 'off'}"></span>${esc(room.names[1 - you])}
              ${oppTurn ? '<span class="turn-badge">à son tour</span>' : ''}
              ${oppConnected ? '' : '<span class="hint">(déconnecté — il peut revenir)</span>'}</span>
            <span class="opp-hand" title="Cartes en main">${oppHand}</span>
          </div>
          ${defenseRow(g.opp.defense, 'opp', g)}
          <div class="sublabel">Défense adverse</div>
        </section>

        <div class="mid">
          <div class="piles">
            <div class="pile">${g.deckCount ? cardHtml(null) : '<div class="empty"></div>'}Pioche ${g.deckCount}</div>
            <div class="pile"><div class="empty"></div>Défausse ${g.discardCount}</div>
          </div>
          <div style="display:grid;gap:8px">${statusHtml(g, room)}${lastHtml(g, room)}</div>
        </div>

        <section class="zone ${myTurn ? 'active' : ''}">
          <div class="zone-head">
            <span class="pname">${esc(room.names[you])} (vous) ${myTurn ? '<span class="turn-badge">à vous</span>' : ''}</span>
          </div>
          <div class="sublabel">Ma défense</div>
          ${defenseRow(g.me.defense, 'me', g)}
          <div class="sublabel">Ma main</div>
          <div class="row hand-row">
            ${g.me.hand.map((c) => cardHtml(c, { data: ['hand', c.id], click: handSel, sel: sel.hand.has(c.id) })).join('')}
          </div>
        </section>
      </div>
      ${logHtml(g, room)}
    </div>
    ${overlayHtml(g, room)}
    ${toast ? `<div class="toast">${esc(toast)}</div>` : ''}`;
  }

  function render() {
    // Conserver ce qui est tapé dans le lobby.
    const nameEl = document.getElementById('name');
    if (nameEl) form.name = nameEl.value;
    const codeEl = document.getElementById('code');
    if (codeEl) form.code = codeEl.value;

    let html;
    if (!msg) html = renderLobby();
    else if (!msg.game) html = renderWaiting() + (toast ? `<div class="toast">${esc(toast)}</div>` : '');
    else html = renderGame();
    $app.innerHTML = html;
    // Le journal reste calé en haut (le plus récent en premier).
  }

  // ---------- Événements ----------
  $app.addEventListener('input', (e) => {
    if (e.target.id === 'name') form.name = e.target.value;
    if (e.target.id === 'code') { e.target.value = e.target.value.toUpperCase(); form.code = e.target.value; }
  });
  $app.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'code') $app.querySelector('[data-a="join"]').click();
  });

  $app.addEventListener('click', (e) => {
    const t = e.target.closest('[data-a]');
    if (!t || t.disabled) return;
    const a = t.dataset.a;
    const id = t.dataset.id !== undefined ? Number(t.dataset.id) : null;
    const g = msg && msg.game;

    switch (a) {
      case 'create': store.set('name', form.name); send({ t: 'create', name: form.name }); break;
      case 'bot': store.set('name', form.name); send({ t: 'vsbot', name: form.name }); break;
      case 'join':
        if (form.code.trim().length !== 4) return showToast('Entrez le code à 4 lettres.'), render();
        store.set('name', form.name);
        send({ t: 'join', code: form.code, name: form.name });
        break;
      case 'rules': document.getElementById('rules').showModal(); break;
      case 'leave': send({ t: 'leave' }); break;
      case 'copy': {
        const url = `${location.origin}/?code=${msg.room.code}`;
        (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(
          () => { showToast('Lien copié !'); render(); },
          () => { showToast(url); render(); }
        );
        break;
      }
      case 'hand': {
        if (!g) return;
        const max = g.phase === 'setup' ? 4 : 2;
        toggle(sel.hand, id, max);
        break;
      }
      case 'tgt': if (g) toggle(sel.tgt, id, g.opp.defense.length); break;
      case 'def': toggle(sel.def, id, 2); break;
      case 'setup': act({ type: 'setup', ids: [...sel.hand] }); break;
      case 'reveal': act({ type: 'reveal', ids: [...sel.def] }); break;
      case 'add': act({ type: 'add', ids: [...sel.hand] }); break;
      case 'attack': act({ type: 'attack', cards: [...sel.hand], targets: [...sel.tgt] }); break;
      case 'end': act({ type: 'end' }); break;
      case 'rematch': send({ t: 'rematch' }); break;
    }
  });

  // Lien d'invitation ?code=ABCD : pré-remplit le code.
  const qp = new URLSearchParams(location.search).get('code');
  if (qp) form.code = qp.toUpperCase().slice(0, 4);

  connect();
  render();
})();
