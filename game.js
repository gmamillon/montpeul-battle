'use strict';
// Moteur de règles (côté serveur, autoritaire).

const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

const isRed = (c) => c.suit === 'H' || c.suit === 'D';
const baseValue = (c) => (c.rank === 'A' ? 11 : 'JQK'.includes(c.rank) ? 10 : parseInt(c.rank, 10));
// Noires : x2 en attaque. Rouges : x2 en défense.
const attackValue = (c) => (isRed(c) ? baseValue(c) : baseValue(c) * 2);
const defenseValue = (c) => (isRed(c) ? baseValue(c) * 2 : baseValue(c));
const cardStr = (c) => c.rank + SUIT_SYM[c.suit];
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const newPlayer = () => ({ hand: [], defense: [], setupDone: false, revealDone: false });
const err = (error) => ({ error });
const ok = () => ({ ok: true });

function validIds(ids, min, max) {
  return (
    Array.isArray(ids) &&
    ids.length >= min &&
    ids.length <= max &&
    ids.every(Number.isInteger) &&
    new Set(ids).size === ids.length
  );
}

class Game {
  constructor(names = ['Joueur 1', 'Joueur 2'], rng = Math.random) {
    this.names = names;
    this.rng = rng;
    this.seq = 0;
    this.logs = [];
    const cards = [];
    for (const suit of SUITS) for (const rank of RANKS) cards.push({ rank, suit });
    shuffle(cards, rng);
    // L'id est la position dans le paquet mélangé : il ne révèle rien sur la carte.
    cards.forEach((c, i) => (c.id = i));
    this.deck = cards;
    this.discard = [];
    this.players = [newPlayer(), newPlayer()];
    for (let i = 0; i < 6; i++) for (const p of this.players) p.hand.push(this.draw());
    this.phase = 'setup'; // setup -> reveal -> play -> over
    this.turn = null;
    this.winner = null;
    this.added = 0; // cartes ajoutées en défense pendant le tour courant
    this.attackNo = 0;
    this.lastAttack = null;
    this.startDraws = [];
    this.log(null, 'Les cartes sont distribuées : chacun pose 4 cartes face cachée en défense.');
  }

  log(seat, msg) {
    this.logs.push({ seat, msg });
    if (this.logs.length > 80) this.logs.shift();
  }

  draw() {
    if (!this.deck.length && this.discard.length) {
      this.deck = shuffle(this.discard, this.rng);
      this.discard = [];
      this.log(null, 'La défausse est mélangée pour reformer la pioche.');
    }
    return this.deck.pop() || null;
  }

  takeFromHand(p, ids) {
    const cards = ids.map((id) => p.hand.find((c) => c.id === id));
    if (cards.some((c) => !c)) return null;
    p.hand = p.hand.filter((c) => !ids.includes(c.id));
    return cards;
  }

  act(seat, a) {
    if (!a || typeof a !== 'object') return err('Action invalide.');
    if (this.phase === 'over') return err('La partie est terminée.');
    const res = this._act(seat, a);
    if (res.ok) this.seq++;
    return res;
  }

  _act(seat, a) {
    const p = this.players[seat];
    const opp = this.players[1 - seat];
    const name = this.names[seat];

    switch (a.type) {
      case 'setup': {
        if (this.phase !== 'setup' || p.setupDone) return err('Action impossible maintenant.');
        if (!validIds(a.ids, 4, 4)) return err('Choisissez exactement 4 cartes.');
        const cards = this.takeFromHand(p, a.ids);
        if (!cards) return err('Carte inconnue.');
        p.defense = cards.map((card) => ({ card, up: false }));
        p.setupDone = true;
        this.log(seat, 'a posé 4 cartes face cachée.');
        if (opp.setupDone) {
          this.phase = 'reveal';
          this.log(null, 'Chacun retourne 2 de ses 4 cartes de défense.');
        }
        return ok();
      }

      case 'reveal': {
        if (this.phase !== 'reveal' || p.revealDone) return err('Action impossible maintenant.');
        if (!validIds(a.ids, 2, 2)) return err('Choisissez exactement 2 cartes.');
        const entries = a.ids.map((id) => p.defense.find((d) => d.card.id === id));
        if (entries.some((d) => !d)) return err('Carte inconnue.');
        entries.forEach((d) => (d.up = true));
        p.revealDone = true;
        this.log(seat, 'a retourné 2 cartes de sa défense : ' + entries.map((d) => cardStr(d.card)).join(' '));
        if (opp.revealDone) this.startDrawPhase();
        return ok();
      }

      case 'add': {
        if (this.phase !== 'play' || this.turn !== seat) return err("Ce n'est pas votre tour.");
        const free = 4 - p.defense.length;
        if (free <= 0) return err('Votre défense est pleine (4 cartes maximum).');
        if (!validIds(a.ids, 1, free)) return err(`Vous pouvez ajouter entre 1 et ${free} carte(s).`);
        const cards = this.takeFromHand(p, a.ids);
        if (!cards) return err('Carte inconnue.');
        cards.forEach((card) => p.defense.push({ card, up: false }));
        this.added += cards.length;
        this.log(seat, `ajoute ${cards.length} carte${cards.length > 1 ? 's' : ''} face cachée à sa défense.`);
        if (p.hand.length === 0) this.endTurn(); // toute la main a été jouée : le tour se termine
        return ok();
      }

      case 'attack': {
        if (this.phase !== 'play' || this.turn !== seat) return err("Ce n'est pas votre tour.");
        if (!validIds(a.cards, 1, 2)) return err("Attaquez avec 1 ou 2 cartes de votre main.");
        if (!validIds(a.targets, 1, opp.defense.length)) return err('Choisissez les cartes adverses visées.');
        // Chaque carte d'attaque peut viser 2 cartes au maximum.
        if (a.targets.length > 2 * a.cards.length) {
          return err('Une carte d\'attaque ne peut viser que 2 cartes : utilisez vos deux cartes pour en viser 3 ou 4.');
        }
        const targetEntries = a.targets.map((id) => opp.defense.find((d) => d.card.id === id));
        if (targetEntries.some((d) => !d)) return err('Cible inconnue.');
        const atkCards = this.takeFromHand(p, a.cards);
        if (!atkCards) return err('Carte inconnue.');

        targetEntries.forEach((d) => (d.up = true));
        const targets = targetEntries.map((d) => d.card);
        const atk = sum(atkCards, attackValue);
        const def = sum(targets, defenseValue);
        const success = atk >= def;
        this.lastAttack = { n: ++this.attackNo, attacker: seat, cards: atkCards, targets, atk, def, success };
        this.discard.push(...atkCards);
        if (success) {
          const ids = new Set(targets.map((c) => c.id));
          opp.defense = opp.defense.filter((d) => !ids.has(d.card.id));
          this.discard.push(...targets);
        }
        this.log(
          seat,
          `attaque avec ${atkCards.map(cardStr).join(' ')} (${atk} pts) contre ${targets.map(cardStr).join(' ')} (${def} pts) : ` +
            (success ? 'réussi !' : 'échec.')
        );
        if (opp.defense.length === 0) {
          this.phase = 'over';
          this.winner = seat;
          this.turn = null;
          this.log(seat, 'a détruit toute la défense adverse et remporte la partie !');
        } else {
          this.endTurn();
        }
        return ok();
      }

      case 'end': {
        if (this.phase !== 'play' || this.turn !== seat) return err("Ce n'est pas votre tour.");
        if (this.added < 1) return err('Vous devez jouer au moins une carte (ajout en défense ou attaque).');
        this.endTurn();
        return ok();
      }

      default:
        return err('Action inconnue.');
    }
  }

  startDrawPhase() {
    this.startDraws = [];
    let a, b;
    do {
      a = this.draw();
      b = this.draw();
      this.startDraws.push([a, b]);
      this.log(0, `pioche ${cardStr(a)}`);
      this.log(1, `pioche ${cardStr(b)}`);
      this.discard.push(a, b);
      if (RANKS.indexOf(a.rank) === RANKS.indexOf(b.rank)) this.log(null, 'Égalité : on pioche à nouveau.');
    } while (RANKS.indexOf(a.rank) === RANKS.indexOf(b.rank));
    this.turn = RANKS.indexOf(a.rank) > RANKS.indexOf(b.rank) ? 0 : 1;
    this.phase = 'play';
    this.added = 0;
    this.log(this.turn, 'commence la partie.');
  }

  endTurn() {
    const p = this.players[this.turn];
    while (p.hand.length < 2) {
      const c = this.draw();
      if (!c) break;
      p.hand.push(c);
    }
    this.turn = 1 - this.turn;
    this.added = 0;
  }

  view(seat) {
    const me = this.players[seat];
    const op = this.players[1 - seat];
    return {
      seq: this.seq,
      phase: this.phase,
      turn: this.turn,
      you: seat,
      winner: this.winner,
      added: this.added,
      deckCount: this.deck.length,
      discardCount: this.discard.length,
      discard: this.discard, // public : toutes ces cartes ont été révélées
      me: {
        hand: me.hand,
        defense: me.defense.map((d) => ({ id: d.card.id, up: d.up, card: d.card })),
        setupDone: me.setupDone,
        revealDone: me.revealDone,
      },
      opp: {
        handCount: op.hand.length,
        defense: op.defense.map((d) => ({ id: d.card.id, up: d.up, card: d.up ? d.card : null })),
        setupDone: op.setupDone,
        revealDone: op.revealDone,
      },
      lastAttack: this.lastAttack,
      startDraws: this.startDraws,
      log: this.logs.slice(-40),
    };
  }
}

module.exports = { Game, attackValue, defenseValue, baseValue, isRed, cardStr, shuffle, RANKS, SUITS };
