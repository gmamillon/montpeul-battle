'use strict';
// Adversaire ordinateur. Il ne regarde que sa propre vue (pas de triche), mais il
// compte les cartes : tout ce qu'il ne voit pas (cartes cachées adverses, main
// adverse, pioche) est tiré au hasard parmi les cartes restantes (Monte-Carlo).
// Il compare ensuite tous les plans de jeu possibles (renforcer / attaquer / les deux)
// avec une évaluation de la position.
const { attackValue, defenseValue, RANKS, SUITS } = require('./game');

const N_SAMPLES = 220;
const WIN = 1000; // détruire toute la défense adverse
const LOSS = 30; // risque de perdre toute sa défense au tour suivant
const THREAT_CONFIDENCE = 0.75; // l'adversaire ne voit pas nos cartes cachées

const ALL_CARDS = SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
const key = (c) => c.rank + c.suit;
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

function botNeedsToAct(g, seat) {
  const p = g.players[seat];
  return (
    (g.phase === 'setup' && !p.setupDone) ||
    (g.phase === 'reveal' && !p.revealDone) ||
    (g.phase === 'play' && g.turn === seat)
  );
}

// Tous les sous-ensembles (indices) d'un tableau, taille entre min et max.
function subsets(arr, min, max) {
  const out = [];
  for (let m = 0; m < 1 << arr.length; m++) {
    const s = arr.filter((_, i) => m & (1 << i));
    if (s.length >= min && s.length <= max) out.push(s);
  }
  return out;
}

// ---------- Mise en place ----------
function chooseSetup(v) {
  // 4 cartes en défense (somme de défense max), les 2 autres en main pour attaquer.
  let best = null;
  for (const def of subsets(v.me.hand, 4, 4)) {
    const hand = v.me.hand.filter((c) => !def.includes(c));
    const score = sum(def, defenseValue) + 0.6 * sum(hand, attackValue) + Math.random() * 0.5;
    if (!best || score > best.score) best = { score, def };
  }
  return { type: 'setup', ids: best.def.map((c) => c.id) };
}

function chooseReveal(v) {
  // On montre les 2 cartes les plus solides : pas d'élimination sûre pour l'adversaire,
  // et les faibles restent cachées.
  const sorted = [...v.me.defense].sort((a, b) => defenseValue(b.card) - defenseValue(a.card));
  return { type: 'reveal', ids: sorted.slice(0, 2).map((d) => d.id) };
}

// ---------- Tour de jeu ----------
// Tire N mondes possibles : valeur des cartes adverses cachées + main adverse.
function sampleWorlds(v, hiddenCount) {
  const { me, opp } = v;
  const seen = new Set(
    [
      ...me.hand,
      ...me.defense.map((d) => d.card),
      ...opp.defense.filter((d) => d.card).map((d) => d.card),
      ...(v.discard || []),
    ].map(key)
  );
  const pool = ALL_CARDS.filter((c) => !seen.has(key(c)));
  const need = hiddenCount + 2;
  const worlds = [];
  for (let n = 0; n < N_SAMPLES; n++) {
    const picked = [];
    const idx = pool.map((_, i) => i);
    for (let i = 0; i < need; i++) {
      if (idx.length) {
        const j = i + Math.floor(Math.random() * (idx.length - i));
        [idx[i], idx[j]] = [idx[j], idx[i]];
        picked.push(pool[idx[i]]);
      } else picked.push(ALL_CARDS[Math.floor(Math.random() * 52)]); // sécurité
    }
    worlds.push({ hidden: picked.slice(0, hiddenCount), oppHand: picked.slice(hiddenCount) });
  }
  return worlds;
}

// Nombre maximum de cartes de `defense` que `hand` (2 cartes) peut détruire en une attaque.
function maxKills(hand, defenseCards) {
  const defs = defenseCards.map(defenseValue);
  const masks = [];
  for (let m = 1; m < 1 << defs.length; m++) {
    let s = 0, n = 0;
    for (let i = 0; i < defs.length; i++) if (m & (1 << i)) { s += defs[i]; n++; }
    masks.push([n, s]);
  }
  let best = 0;
  const atks = hand.map(attackValue);
  const options = [[atks[0], 1], [atks[1], 1], [atks[0] + atks[1], 2]];
  for (const [atk, nCards] of options) {
    if (atk === undefined || Number.isNaN(atk)) continue;
    for (const [n, s] of masks) if (n <= 2 * nCards && s <= atk && n > best) best = n;
  }
  return best;
}

const strength = (cards) => sum(cards, (c) => 1 + defenseValue(c) / 10);

function choosePlay(v) {
  const { me, opp } = v;
  const hand = me.hand;
  const free = 4 - me.defense.length;
  const oppDef = opp.defense;
  const hiddenPos = []; // position dans oppDef -> index dans la liste des cachées
  let hiddenCount = 0;
  oppDef.forEach((d, i) => { hiddenPos[i] = d.card ? -1 : hiddenCount++; });
  const worlds = sampleWorlds(v, hiddenCount);

  // Risque couru par notre défense selon les cartes ajoutées (ne dépend pas de l'attaque).
  const threatCache = new Map();
  const threat = (A) => {
    const k = A.map((c) => c.id).sort().join(',');
    if (!threatCache.has(k)) {
      const D = [...me.defense.map((d) => d.card), ...A];
      let kills = 0, losses = 0;
      for (const w of worlds) {
        const K = maxKills(w.oppHand, D);
        kills += K;
        if (K >= D.length) losses++;
      }
      threatCache.set(k, {
        expKills: (kills / worlds.length) * THREAT_CONFIDENCE,
        pLoss: (losses / worlds.length) * THREAT_CONFIDENCE,
        myStrength: strength(D),
      });
    }
    return threatCache.get(k);
  };

  const targetSets = subsets(oppDef.map((_, i) => i), 1, 4);
  let best = null;

  for (const A of subsets(hand, 0, Math.min(free, hand.length))) {
    const rest = hand.filter((c) => !A.includes(c));
    for (const S of subsets(rest, 0, 2)) {
      if (A.length === 0 && S.length === 0 && v.added === 0) continue; // il faut jouer une carte
      const th = threat(A);
      const kept = rest.filter((c) => !S.includes(c));
      const keptValue = 0.4 * sum(kept, attackValue) / 10;
      const attackSets = S.length ? targetSets.filter((T) => T.length <= 2 * S.length) : [null];

      for (const T of attackSets) {
        let total = 0;
        const atk = S.length ? sum(S, attackValue) : 0;
        for (const w of worlds) {
          const cardOf = (i) => oppDef[i].card || w.hidden[hiddenPos[i]];
          let remaining = oppDef.map((_, i) => i);
          let info = 0;
          if (T) {
            const dsum = sum(T, (i) => defenseValue(cardOf(i)));
            if (atk >= dsum) remaining = remaining.filter((i) => !T.includes(i));
            info = 0.6 * T.filter((i) => !oppDef[i].card).length; // cartes révélées
          }
          if (remaining.length === 0) { total += WIN; continue; }
          const oppStrength = strength(remaining.map(cardOf));
          total += 0.6 * th.myStrength - oppStrength - 1.5 * th.expKills - LOSS * th.pLoss + info + keptValue;
        }
        const score = total / worlds.length + Math.random() * 0.3;
        if (!best || score > best.score) best = { score, A, S, T };
      }
    }
  }

  if (best.A.length) return { type: 'add', ids: best.A.map((c) => c.id) };
  if (best.S.length) {
    return { type: 'attack', cards: best.S.map((c) => c.id), targets: best.T.map((i) => oppDef[i].id) };
  }
  return { type: 'end' };
}

function botMove(v) {
  if (v.phase === 'setup') return chooseSetup(v);
  if (v.phase === 'reveal') return chooseReveal(v);
  return choosePlay(v);
}

module.exports = { botMove, botNeedsToAct };
