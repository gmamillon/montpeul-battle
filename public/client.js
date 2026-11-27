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
  let sel; // cartes sélectionnées ; sel.opp = adversaire visé par sel.tgt
  let selKey = '';
  let toast = '';
  let toastTimer = null;
  const form = { name: store.get('name') || '', code: '', mode: store.get('mode') === 'melee' ? 'melee' : 'duel' };
  resetSel();

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
  function resetSel() { sel = { hand: new Set(), tgt: new Set(), def: new Set(), opp: null }; }
  function sanitizeSel() {
    const g = msg && msg.game;
    if (!g) return resetSel();
    const key = g.phase + ':' + g.turn;
    if (key !== selKey) { selKey = key; resetSel(); return; }
    const has = (set, ids) => { for (const id of [...set]) if (!ids.includes(id)) set.delete(id); };
    has(sel.hand, g.me.hand.map((c) => c.id));
    has(sel.def, g.me.defense.map((d) => d.id));
    const target = g.opponents.find((o) => o.seat === sel.opp);
    has(sel.tgt, target ? target.defense.map((d) => d.id) : []);
  }
  function toggle(set, id, max) {
    if (set.has(id)) set.delete(id);
    else if (set.size < max) set.add(id);
    else if (max === 1 || max === 2) { set.delete([...set][0]); set.add(id); }
    render();
  }
  // Une attaque ne vise qu'un adversaire : changer d'adversaire efface les cibles.
  function toggleTarget(seat, id) {
    if (sel.opp !== seat) { sel.opp = seat; sel.tgt.clear(); }
    toggle(sel.tgt, id, msg.game.rules.bench);
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
    const data = o.data ? ` data-a="${o.data[0]}" data-id="${o.data[1]}"${o.data[2] !== undefined ? ` data-seat="${o.data[2]}"` : ''}` : '';
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

  function slotsHtml(entries, size, render1) {
    let html = '';
    for (let i = 0; i < size; i++) html += entries[i] ? render1(entries[i]) : '<div class="slot"></div>';
    return `<div class="row">${html}</div>`;
  }

  // Somme des points de défense visibles sur un banc.
  function defenseTotal(entries) {
    const known = entries.filter((d) => d.card).reduce((s, d) => s + defVal(d.card), 0);
    const hidden = entries.filter((d) => !d.card).length;
    return `🛡 ${known}${hidden ? ` + ${hidden} cachée${hidden > 1 ? 's' : ''}` : ''}`;
  }

  // ---------- Écrans ----------
  function renderLobby() {
    const modeBtn = (value, label, sub) =>
      `<button class="btn mode ${form.mode === value ? 'on' : ''}" data-a="mode" data-mode="${value}" aria-pressed="${form.mode === value}"><b>${label}</b><span>${sub}</span></button>`;
    return `
    ${online ? '' : '<div class="banner">Connexion au serveur…</div>'}
    <div class="lobby">
      <div class="suits"><span class="r">♥</span>♠<span class="r">♦</span>♣</div>
      <h1>BASTION</h1>
      <p class="sub">Brisez la défense de vos adversaires.</p>
      <div class="card-panel">
        <div><label for="name">Votre pseudo</label>
          <input id="name" maxlength="16" placeholder="Joueur" value="${esc(form.name)}"></div>
        <div class="modes">
          ${modeBtn('duel', 'Duel', '2 joueurs')}
          ${modeBtn('melee', 'Mêlée', '2 à 5 joueurs')}
        </div>
        <button class="btn primary" data-a="create" ${online ? '' : 'disabled'}>Créer une partie en ligne</button>
        <button class="btn" data-a="bot" ${online ? '' : 'disabled'}>S'entraîner contre l'ordinateur</button>
        <div class="sep">ou rejoindre un ami</div>
        <div class="row-join">
          <input id="code" class="code" maxlength="4" placeholder="CODE" value="${esc(form.code)}">
          <button class="btn" data-a="join" ${online ? '' : 'disabled'}>Rejoindre</button>
        </div>
        <button class="btn small" data-a="rules">Lire les règles</button>
      </div>
      <div class="err">${esc(toast)}</div>
    </div>`;
  }

  function renderWaiting() {
    const { room } = msg;
    const melee = room.mode === 'melee';
    const count = room.names.length;
    const list = melee
      ? `<ol class="players">${room.names.map((n, i) => `<li>
          <span><span class="dot ${room.connected[i] ? '' : 'off'}"></span> ${esc(n)}${i === room.seat ? ' (vous)' : ''}</span>
          ${room.isHost && room.bots[i] ? `<button class="btn small danger" data-a="removebot" data-seat="${i}" aria-label="Retirer ${esc(n)}">Retirer</button>` : ''}
        </li>`).join('')}</ol>
        <p class="hint">L'ordre de la liste est l'ordre du tour de table (sens des aiguilles d'une montre).</p>
        ${room.isHost
          ? `<div class="controls center">
              <button class="btn" data-a="addbot" ${count < room.maxPlayers ? '' : 'disabled'}>Ajouter un ordinateur</button>
              <button class="btn primary" data-a="start" ${count >= room.minPlayers ? '' : 'disabled'}>Lancer la partie (${count} joueurs)</button>
            </div>`
          : "<p>En attente que l'hôte lance la partie…</p>"}`
      : '';
    return `
    <div class="waiting">
      <h2>${melee ? `Salon Mêlée — ${count}/${room.maxPlayers} joueurs` : "En attente d'un adversaire…"}</h2>
      <p>Donnez ce code à ${melee ? 'vos amis' : 'votre ami'} :</p>
      <div class="big-code">${esc(room.code)}</div>
      <p><button class="btn" data-a="copy">Copier le lien d'invitation</button></p>
      ${list}
      <p><button class="btn small danger" data-a="leave">${melee && !room.isHost ? 'Quitter le salon' : 'Annuler'}</button></p>
    </div>`;
  }

  function statusHtml(g, room) {
    const myTurn = g.phase === 'play' && g.turn === g.you;
    const { bench, flip } = g.rules;
    const waitingFor = (flag) => {
      const names = g.opponents.filter((o) => !o.out && !o[flag]).map((o) => esc(room.names[o.seat]));
      return `En attente de ${names.join(', ')}…`;
    };
    let text = '';
    let controls = '';
    let preview = '';

    if (g.me.out) {
      text = g.phase === 'over' ? 'Partie terminée.' : 'Vous êtes éliminé : vous pouvez suivre la fin de la partie.';
    } else if (g.phase === 'setup') {
      if (!g.me.setupDone) {
        text = `Choisissez ${bench} cartes de votre main à poser face cachée en défense (${sel.hand.size}/${bench}).`;
        controls = `<button class="btn primary" data-a="setup" ${sel.hand.size === bench ? '' : 'disabled'}>Poser ma défense</button>`;
      } else text = `Défense posée. ${waitingFor('setupDone')}`;
    } else if (g.phase === 'reveal') {
      if (!g.me.revealDone) {
        text = `Retournez ${flip} de vos ${bench} cartes de défense (${sel.def.size}/${flip}).`;
        if (g.mode === 'melee') preview = 'La plus petite somme de défense révélée commence.';
        controls = `<button class="btn primary" data-a="reveal" ${sel.def.size === flip ? '' : 'disabled'}>Retourner ces cartes</button>`;
      } else text = waitingFor('revealDone');
    } else if (g.phase === 'play') {
      if (myTurn) {
        const free = bench - g.me.defense.length;
        const nh = sel.hand.size, nt = sel.tgt.size;
        const target = g.opponents.find((o) => o.seat === sel.opp);
        text = g.added > 0
          ? `Votre tour : ${g.added} carte(s) ajoutée(s). Vous pouvez attaquer ou terminer le tour.`
          : 'Votre tour : renforcez votre défense et/ou attaquez.';
        controls = `
          <button class="btn" data-a="add" ${nh >= 1 && nh <= free ? '' : 'disabled'} title="${free ? '' : 'Défense pleine'}">Ajouter à ma défense</button>
          <button class="btn primary" data-a="attack" ${nh >= 1 && nh <= 2 && nt >= 1 && nt <= 2 * nh ? '' : 'disabled'}>Attaquer</button>
          <button class="btn" data-a="end" ${g.added >= 1 ? '' : 'disabled'}>Terminer le tour</button>`;
        if (nh && nt > 2 * nh) {
          preview = nt > 4
            ? `<span class="ko">Une attaque peut viser 4 cartes au maximum.</span>`
            : `<span class="ko">Une carte d'attaque ne peut viser que 2 cartes : ${nt} cibles demandent 2 cartes d'attaque.</span>`;
        } else if (nh && nt && target) {
          const hand = g.me.hand.filter((c) => sel.hand.has(c.id));
          const atk = hand.reduce((s, c) => s + atkVal(c), 0);
          const targets = target.defense.filter((d) => sel.tgt.has(d.id));
          const known = targets.filter((d) => d.card).reduce((s, d) => s + defVal(d.card), 0);
          const hidden = targets.filter((d) => !d.card).length;
          let verdict = '';
          if (!hidden) verdict = atk >= known ? '<span class="ok">✔ suffisant</span>' : '<span class="ko">✘ insuffisant</span>';
          const whom = g.opponents.length > 1 ? ` (${esc(room.names[target.seat])})` : '';
          preview = `Attaque <b>${atk}</b> pts contre <b>${known}${hidden ? ` + ${hidden} carte(s) cachée(s)` : ''}</b> pts${whom} ${verdict}`;
        } else if (nh) preview = 'Sélectionnez maintenant les cartes adverses à viser (ou ajoutez à votre défense).';
        else preview = 'Cliquez sur vos cartes en main, puis sur les cartes adverses visées.';
      } else text = `Tour de ${esc(room.names[g.turn])}…`;
    }
    return `<div class="status"><div class="msg">${text}</div>${controls ? `<div class="controls">${controls}</div>` : ''}${preview ? `<div class="preview">${preview}</div>` : ''}</div>`;
  }

  function lastHtml(g, room) {
    const a = g.lastAttack;
    if (!a) return '';
    const name = (s) => esc(room.names[s]);
    const who = a.attacker === g.you
      ? `Votre attaque contre ${name(a.target)}`
      : `Attaque de ${name(a.attacker)} contre ${a.target === g.you ? 'vous' : name(a.target)}`;
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
    const won = g.winners.includes(g.you);
    const shared = g.winners.length > 1;
    const winnerNames = g.winners.map((s) => esc(room.names[s])).join(' et ');
    const iWait = room.rematch[g.you];
    let title = won ? (shared ? '🤝 Victoire partagée' : '🏆 Victoire !') : 'Défaite';
    let detail;
    let table = '';
    if (g.result.reason === 'deck') {
      detail = `La pioche est épuisée. ${shared ? `${winnerNames} sont à égalité.` : `${winnerNames} a la défense la plus solide.`}`;
      const rows = g.result.scores
        .map((score, seat) => ({ score, seat }))
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
        .map(({ score, seat }) => `<tr class="${g.winners.includes(seat) ? 'top' : ''}"><td>${esc(room.names[seat])}</td><td>${score === null ? 'éliminé' : `🛡 ${score}`}</td></tr>`);
      table = `<table class="scores">${rows.join('')}</table>`;
    } else if (g.mode === 'duel') {
      detail = won ? 'Vous avez détruit toute la défense adverse.' : `${winnerNames} a détruit toute votre défense.`;
    } else {
      detail = won ? 'Vous êtes le dernier joueur en défense.' : `${winnerNames} est le dernier joueur en défense.`;
    }
    return `<div class="overlay"><div class="box">
      <h2>${title}</h2>
      <p>${detail}</p>
      ${table}
      <div class="btns">
        <button class="btn primary" data-a="rematch" ${iWait ? 'disabled' : ''}>${iWait ? 'En attente des autres joueurs…' : 'Rejouer'}</button>
        <button class="btn" data-a="leave">Quitter</button>
      </div></div></div>`;
  }

  function opponentHtml(g, room, o) {
    const myTurn = g.phase === 'play' && g.turn === g.you;
    const theirTurn = g.phase === 'play' && g.turn === o.seat;
    const connected = room.connected[o.seat];
    const multi = g.opponents.length > 1;
    const hand = Array.from({ length: o.handCount }, () => cardHtml(null)).join('');
    let state = '';
    if (room.left[o.seat]) state = '<span class="hint">(a quitté)</span>';
    else if (o.out) state = '<span class="hint">(éliminé)</span>';
    else if (!connected) state = '<span class="hint">(déconnecté — il peut revenir)</span>';
    return `<section class="zone opp ${theirTurn ? 'active' : ''} ${o.out ? 'out' : ''}">
      <div class="zone-head">
        <span class="pname"><span class="dot ${connected && !o.out ? '' : 'off'}"></span>${esc(room.names[o.seat])}
          ${theirTurn ? '<span class="turn-badge">à son tour</span>' : ''} ${state}</span>
        <span class="opp-hand" title="Cartes en main">${hand}</span>
      </div>
      ${slotsHtml(o.defense, g.rules.bench, (d) => cardHtml(d.card, {
        data: ['tgt', d.id, o.seat], click: myTurn, sel: sel.opp === o.seat && sel.tgt.has(d.id), revealed: d.up,
      }))}
      <div class="sublabel">${multi ? defenseTotal(o.defense) : 'Défense adverse'}</div>
    </section>`;
  }

  function renderGame() {
    const { room, game: g } = msg;
    const you = g.you;
    const myTurn = g.phase === 'play' && g.turn === you;
    const handSel = g.phase === 'setup' ? !g.me.setupDone : myTurn;
    const multi = g.opponents.length > 1;
    const melee = g.mode === 'melee';
    // En mêlée, la partie s'arrête avec la pioche : on prévient quand la fin approche.
    const alive = 1 + g.opponents.filter((o) => !o.out).length - (g.me.out ? 1 : 0);
    const lowDeck = melee && g.deckCount <= alive * 4;
    const vsBotOnly = room.bots.every((bot, i) => bot || i === you);

    return `
    ${online ? '' : '<div class="banner">Connexion perdue… reconnexion en cours</div>'}
    <div class="game">
      <div class="board">
        <div class="topbar">
          <div class="room">Salon <b>${esc(room.code)}</b> · ${melee ? 'Mêlée' : 'Duel'}${vsBotOnly ? " · contre l'ordinateur" : ''}</div>
          <div class="actions">
            <button class="btn small" data-a="rules">Règles</button>
            <button class="btn small danger" data-a="leave">Quitter</button>
          </div>
        </div>

        <div class="opps ${multi ? 'multi' : ''}">${g.opponents.map((o) => opponentHtml(g, room, o)).join('')}</div>

        <div class="mid">
          <div class="piles">
            <div class="pile ${lowDeck ? 'low' : ''}" ${melee ? 'title="La partie se termine quand la pioche est vide"' : ''}>${g.deckCount ? cardHtml(null) : '<div class="empty"></div>'}Pioche ${g.deckCount}</div>
            <div class="pile"><div class="empty"></div>Défausse ${g.discardCount}</div>
          </div>
          <div class="mid-info">${statusHtml(g, room)}${lastHtml(g, room)}</div>
        </div>

        <section class="zone ${myTurn ? 'active' : ''} ${g.me.out ? 'out' : ''}">
          <div class="zone-head">
            <span class="pname">${esc(room.names[you])} (vous) ${myTurn ? '<span class="turn-badge">à vous</span>' : ''}</span>
            <span class="hint">${melee ? defenseTotal(g.me.defense) : ''}</span>
          </div>
          <div class="sublabel">Ma défense</div>
          ${slotsHtml(g.me.defense, g.rules.bench, (d) => cardHtml(d.card, {
            data: ['def', d.id], click: g.phase === 'reveal' && !g.me.revealDone, sel: sel.def.has(d.id), mineHidden: !d.up, revealed: d.up,
          }))}
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
    const seat = t.dataset.seat !== undefined ? Number(t.dataset.seat) : null;
    const g = msg && msg.game;

    switch (a) {
      case 'mode': form.mode = t.dataset.mode; store.set('mode', form.mode); render(); break;
      case 'create': store.set('name', form.name); send({ t: 'create', name: form.name, mode: form.mode }); break;
      case 'bot': store.set('name', form.name); send({ t: 'vsbot', name: form.name, mode: form.mode }); break;
      case 'join':
        if (form.code.trim().length !== 4) return showToast('Entrez le code à 4 lettres.'), render();
        store.set('name', form.name);
        send({ t: 'join', code: form.code, name: form.name });
        break;
      case 'addbot': send({ t: 'addbot' }); break;
      case 'removebot': send({ t: 'removebot', seat }); break;
      case 'start': send({ t: 'start' }); break;
      case 'rules': document.getElementById('rules').showModal(); break;
      case 'leave':
        // Quitter une mêlée en cours équivaut à abandonner : on demande confirmation.
        if (g && g.mode === 'melee' && g.phase !== 'over' && !g.me.out && !confirm('Quitter la partie ? Vous serez éliminé.')) return;
        send({ t: 'leave' });
        break;
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
        const max = g.phase === 'setup' ? g.rules.bench : 2;
        toggle(sel.hand, id, max);
        break;
      }
      case 'tgt': if (g) toggleTarget(seat, id); break;
      case 'def': if (g) toggle(sel.def, id, g.rules.flip); break;
      case 'setup': act({ type: 'setup', ids: [...sel.hand] }); break;
      case 'reveal': act({ type: 'reveal', ids: [...sel.def] }); break;
      case 'add': act({ type: 'add', ids: [...sel.hand] }); break;
      case 'attack': act({ type: 'attack', cards: [...sel.hand], opponent: sel.opp, targets: [...sel.tgt] }); break;
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
