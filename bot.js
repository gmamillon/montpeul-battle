'use strict';
// Adversaire ordinateur. Il ne regarde que sa propre vue (pas de triche), mais il
// compte les cartes : tout ce qu'il ne voit pas (cartes cachées adverses, mains
// adverses, pioche) est tiré au hasard parmi les cartes restantes (Monte-Carlo).
// Il compare ensuite tous les plans de jeu possibles (renforcer / attaquer / les deux)
// avec une évaluation de la position.
const { attackValue, defenseValue, RANKS, SUITS } = require('./game');

const N_SAMPLES = 220;
const WIN = 1000; // gagner la partie
const LOSS = 30; // risque de perdre toute sa défense avant son prochain tour
const ELIMINATION = 8; // sortir un adversaire (mêlée)
const THREAT_CONFIDENCE = 0.75; // l'adversaire ne voit pas nos cartes cachées

const ALL_CARDS = SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
const key = (c) => c.rank + c.suit;
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

function botNeedsToAct(g, seat) {
  const p = g.players[seat];
  if (p.out) return false;
  return (
    (g.phase === 'setup' && !p.setupDone) ||
    (g.phase === 'reveal' && !p.revealDone) ||
    (g.phase === 'play' && g.turn === seat)
  );
}

// Tous les sous-ensembles d'un tableau, de taille entre min et max.
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
  // Défense la plus solide possible, les 2 autres cartes en main pour attaquer.
  const { bench } = v.rules;
  let best = null;
  for (const def of subsets(v.me.hand, bench, bench)) {
    const hand = v.me.hand.filter((c) => !def.includes(c));
    const score = sum(def, defenseValue) + 0.6 * sum(hand, attackValue) + Math.random() * 0.5;
    if (!best || score > best.score) best = { score, def };
  }
  return { type: 'setup', ids: best.def.map((c) => c.id) };
}

function chooseReveal(v) {
  // On montre les cartes les plus solides : pas d'élimination sûre pour l'adversaire,
  // et les faibles restent cachées.
  const sorted = [...v.me.defense].sort((a, b) => defenseValue(b.card) - defenseValue(a.card));
  return { type: 'reveal', ids: sorted.slice(0, v.rules.flip).map((d) => d.id) };
}

// ---------- Tour de jeu ----------
// Tire N mondes possibles : cartes adverses cachées + main de chaque adversaire.
function sampleWorlds(v, foes, hiddenCount) {
  const { me } = v;
  const seen = {};
  for (const c of [
    ...me.hand,
    ...me.defense.map((d) => d.card),
    ...foes.flatMap((o) => o.defense.filter((d) => d.card).map((d) => d.card)),
    ...v.discard,
  ]) seen[key(c)] = (seen[key(c)] || 0) + 1;
  // En mêlée chaque carte existe en autant d'exemplaires qu'il y a de jeux.
  const pool = ALL_CARDS.flatMap((c) => Array(Math.max(0, v.decks - (seen[key(c)] || 0))).fill(c));

  const need = hiddenCount + 2 * foes.length;
  const idx = pool.map((_, i) => i);
  const worlds = [];
  for (let n = 0; n < N_SAMPLES; n++) {
    const picked = [];
    for (let i = 0; i < need; i++) {
      if (i < idx.length) {
        const j = i + Math.floor(Math.random() * (idx.length - i));
        [idx[i], idx[j]] = [idx[j], idx[i]];
        picked.push(pool[idx[i]]);
      } else picked.push(ALL_CARDS[Math.floor(Math.random() * 52)]); // sécurité
    }
    worlds.push({
      hidden: picked.slice(0, hiddenCount),
      hands: foes.map((_, f) => picked.slice(hiddenCount + 2 * f, hiddenCount + 2 * f + 2)),
    });
  }
  return worlds;
}

// Pour chaque combinaison de cartes d'un banc : [nombre de cartes, somme de défense].
function targetSums(defenseCards) {
  const defs = defenseCards.map(defenseValue);
  const masks = [];
  for (let m = 1; m < 1 << defs.length; m++) {
    let s = 0, n = 0;
    for (let i = 0; i < defs.length; i++) if (m & (1 << i)) { s += defs[i]; n++; }
    masks.push([n, s]);
  }
  return masks;
}

// Nombre maximum de cartes qu'une main de 2 cartes peut détruire en une attaque.
function maxKills(hand, masks) {
  const a = attackValue(hand[0]);
  const b = attackValue(hand[1]);
  const single = Math.max(a, b);
  let best = 0;
  for (const [n, s] of masks) if (n > best && n <= 4 && ((n <= 2 && s <= single) || s <= a + b)) best = n;
  return best;
}

const strength = (cards) => sum(cards, (c) => 1 + defenseValue(c) / 10);

function choosePlay(v) {
  const { me, rules } = v;
  const hand = me.hand;
  const free = rules.bench - me.defense.length;
  const foes = v.opponents.filter((o) => !o.out);

  // Index de chaque carte cachée adverse dans la liste tirée au hasard.
  let hiddenCount = 0;
  const hiddenPos = foes.map((o) => o.defense.map((d) => (d.card ? -1 : hiddenCount++)));
  const worlds = sampleWorlds(v, foes, hiddenCount);
  const cardOf = (w, f, i) => foes[f].defense[i].card || w.hidden[hiddenPos[f][i]];

  // En mêlée, affaiblir un adversaire profite aussi aux autres : on dose, en visant plutôt le leader.
  const sizes = foes.map((o) => o.defense.length);
  const share = 1 / (1 + 0.25 * (foes.length - 1));
  const weight = sizes.map((n) => share * (foes.length > 1 ? 0.7 + 0.5 * (n / Math.max(1, ...sizes)) : 1));
  // La pioche s'épuise : en mêlée, la solidité de sa défense devient décisive.
  const endNear = !rules.reshuffle && v.deckCount <= 4 * (foes.length + 1);
  const myWeight = endNear ? 1.2 : 0.6;
  const targetProbability = 1 / foes.length; // chance qu'un adversaire s'en prenne à nous

  // Risque couru par notre défense selon les cartes ajoutées (ne dépend pas de l'attaque).
  const threatCache = new Map();
  const threat = (A) => {
    const k = A.map((c) => c.id).sort().join(',');
    if (!threatCache.has(k)) {
      const D = [...me.defense.map((d) => d.card), ...A];
      const masks = targetSums(D);
      let kills = 0, losses = 0;
      for (const w of worlds) {
        for (const h of w.hands) {
          const K = maxKills(h, masks);
          kills += K;
          if (K >= D.length) losses++;
        }
      }
      const factor = (targetProbability * THREAT_CONFIDENCE) / worlds.length;
      threatCache.set(k, {
        expKills: kills * factor,
        pLoss: Math.min(1, losses * factor),
        myStrength: strength(D),
        myTotal: sum(D, defenseValue),
      });
    }
    return threatCache.get(k);
  };

  // Attaques possibles : un adversaire et jusqu'à 4 de ses cartes.
  const attacks = foes.flatMap((o, f) => subsets(o.defense.map((_, i) => i), 1, 4).map((T) => ({ f, T })));
  let best = null;

  for (const A of subsets(hand, 0, Math.min(free, hand.length))) {
    const rest = hand.filter((c) => !A.includes(c));
    for (const S of subsets(rest, 0, 2)) {
      if (A.length === 0 && S.length === 0 && v.added === 0) continue; // il faut jouer une carte
      const th = threat(A);
      const kept = rest.filter((c) => !S.includes(c));
      const keptValue = (0.4 * sum(kept, attackValue)) / 10;
      // Ce plan fait-il piocher la dernière carte (fin de partie en mêlée) ?
      const endsGame = !rules.reshuffle && 2 - kept.length >= v.deckCount;
      const options = S.length ? attacks.filter((a) => a.T.length <= 2 * S.length) : [null];
      const atk = sum(S, attackValue);

      for (const attack of options) {
        let total = 0;
        for (const w of worlds) {
          let removed = null; // cartes détruites chez foes[attack.f]
          let info = 0;
          if (attack) {
            const { f, T } = attack;
            let dsum = 0;
            for (const i of T) {
              dsum += defenseValue(cardOf(w, f, i));
              if (!foes[f].defense[i].card) info += 0.6; // carte révélée
            }
            if (atk >= dsum) removed = T;
          }
          let oppScore = 0;
          let oppBest = 0;
          let survivors = 0;
          let eliminated = 0;
          for (let f = 0; f < foes.length; f++) {
            let s = 0, t = 0, n = 0;
            for (let i = 0; i < foes[f].defense.length; i++) {
              if (removed && attack.f === f && removed.includes(i)) continue;
              const d = defenseValue(cardOf(w, f, i));
              s += 1 + d / 10;
              t += d;
              n++;
            }
            if (n) survivors++;
            else eliminated++;
            oppScore += weight[f] * s;
            if (t > oppBest) oppBest = t;
          }
          if (survivors === 0) total += WIN;
          else if (endsGame) {
            const margin = th.myTotal - oppBest;
            total += Math.sign(margin) * WIN + margin;
          } else {
            total += myWeight * th.myStrength - oppScore - 1.5 * th.expKills - LOSS * th.pLoss +
              ELIMINATION * eliminated + info + keptValue;
          }
        }
        const score = total / worlds.length + Math.random() * 0.3;
        if (!best || score > best.score) best = { score, A, S, attack };
      }
    }
  }

  if (best.A.length) return { type: 'add', ids: best.A.map((c) => c.id) };
  if (best.S.length) {
    const { f, T } = best.attack;
    return {
      type: 'attack',
      cards: best.S.map((c) => c.id),
      opponent: foes[f].seat,
      targets: T.map((i) => foes[f].defense[i].id),
    };
  }
  return { type: 'end' };
}

function botMove(v) {
  if (v.phase === 'setup') return chooseSetup(v);
  if (v.phase === 'reveal') return chooseReveal(v);
  return choosePlay(v);
}

module.exports = { botMove, botNeedsToAct };
