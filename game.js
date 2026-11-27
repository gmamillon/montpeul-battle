'use strict';
// Moteur de règles (côté serveur, autoritaire).

const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// Les deux modes partagent la même mécanique ; seuls ces réglages changent.
const MODES = {
  duel: { label: 'Duel', minPlayers: 2, maxPlayers: 2, deal: 6, bench: 4, flip: 2, deckPerPlayer: false, reshuffle: true },
  melee: { label: 'Mêlée', minPlayers: 2, maxPlayers: 5, deal: 7, bench: 5, flip: 2, deckPerPlayer: true, reshuffle: false },
};

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

const newPlayer = () => ({ hand: [], defense: [], setupDone: false, revealDone: false, out: false });
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
  // Les sièges sont numérotés dans le sens des aiguilles d'une montre.
  constructor(names = ['Joueur 1', 'Joueur 2'], { mode = 'duel', rng = Math.random } = {}) {
    const rules = MODES[mode];
    if (!rules) throw new Error('Mode inconnu : ' + mode);
    if (names.length < rules.minPlayers || names.length > rules.maxPlayers) throw new Error('Nombre de joueurs invalide.');
    this.mode = mode;
    this.rules = rules;
    this.names = names;
    this.rng = rng;
    this.seq = 0;
    this.logs = [];
    this.decks = rules.deckPerPlayer ? names.length : 1;
    const cards = [];
    for (let d = 0; d < this.decks; d++) for (const suit of SUITS) for (const rank of RANKS) cards.push({ rank, suit });
    shuffle(cards, rng);
    // L'id est la position dans la pioche mélangée : il ne révèle rien sur la carte.
    cards.forEach((c, i) => (c.id = i));
    this.deck = cards;
    this.discard = [];
    this.players = names.map(newPlayer);
    for (let i = 0; i < rules.deal; i++) for (const p of this.players) p.hand.push(this.draw());
    this.phase = 'setup'; // setup -> reveal -> play -> over
    this.turn = null;
    this.winners = [];
    this.result = null;
    this.added = 0; // cartes ajoutées en défense pendant le tour courant
    this.attackNo = 0;
    this.lastAttack = null;
    this.startDraws = [];
    this.log(null, `Les cartes sont distribuées : chacun pose ${rules.bench} cartes face cachée en défense.`);
  }

  log(seat, msg) {
    this.logs.push({ seat, msg });
    if (this.logs.length > 80) this.logs.shift();
  }

  draw() {
    if (!this.deck.length && this.discard.length && this.rules.reshuffle) {
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

  aliveSeats() {
    return this.players.map((_, i) => i).filter((i) => !this.players[i].out);
  }

  // Prochain joueur encore en jeu, dans le sens des aiguilles d'une montre.
  nextSeat(seat) {
    const n = this.players.length;
    for (let k = 1; k <= n; k++) {
      const s = (seat + k) % n;
      if (!this.players[s].out) return s;
    }
    return seat;
  }

  // Adversaire visé par une attaque. Il peut être omis s'il n'en reste qu'un.
  targetSeat(seat, wanted) {
    const foes = this.aliveSeats().filter((s) => s !== seat);
    if (wanted === undefined) return foes.length === 1 ? foes[0] : null;
    return foes.includes(wanted) ? wanted : null;
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
    if (!p || p.out) return err('Vous êtes éliminé.');
    const { bench, flip } = this.rules;

    switch (a.type) {
      case 'setup': {
        if (this.phase !== 'setup' || p.setupDone) return err('Action impossible maintenant.');
        if (!validIds(a.ids, bench, bench)) return err(`Choisissez exactement ${bench} cartes.`);
        const cards = this.takeFromHand(p, a.ids);
        if (!cards) return err('Carte inconnue.');
        p.defense = cards.map((card) => ({ card, up: false }));
        p.setupDone = true;
        this.log(seat, `a posé ${bench} cartes face cachée.`);
        this.advancePhase();
        return ok();
      }

      case 'reveal': {
        if (this.phase !== 'reveal' || p.revealDone) return err('Action impossible maintenant.');
        if (!validIds(a.ids, flip, flip)) return err(`Choisissez exactement ${flip} cartes.`);
        const entries = a.ids.map((id) => p.defense.find((d) => d.card.id === id));
        if (entries.some((d) => !d)) return err('Carte inconnue.');
        entries.forEach((d) => (d.up = true));
        p.revealDone = true;
        this.log(seat, `a retourné ${flip} cartes de sa défense : ` + entries.map((d) => cardStr(d.card)).join(' '));
        this.advancePhase();
        return ok();
      }

      case 'add': {
        if (this.phase !== 'play' || this.turn !== seat) return err("Ce n'est pas votre tour.");
        const free = bench - p.defense.length;
        if (free <= 0) return err(`Votre défense est pleine (${bench} cartes maximum).`);
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
        if (!validIds(a.cards, 1, 2)) return err('Attaquez avec 1 ou 2 cartes de votre main.');
        const target = this.targetSeat(seat, a.opponent);
        if (target === null) return err('Choisissez un adversaire encore en jeu.');
        const opp = this.players[target];
        if (!validIds(a.targets, 1, opp.defense.length)) return err('Choisissez les cartes adverses visées.');
        // Chaque carte d'attaque peut viser 2 cartes au maximum.
        if (a.targets.length > 2 * a.cards.length) {
          return err(`Une carte d'attaque ne peut viser que 2 cartes (${2 * a.cards.length} au maximum ici).`);
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
        this.lastAttack = { n: ++this.attackNo, attacker: seat, target, cards: atkCards, targets, atk, def, success };
        this.discard.push(...atkCards);
        if (success) {
          const ids = new Set(targets.map((c) => c.id));
          opp.defense = opp.defense.filter((d) => !ids.has(d.card.id));
          this.discard.push(...targets);
        }
        const whom = this.players.length > 2 ? ` ${this.names[target]}` : '';
        this.log(
          seat,
          `attaque${whom} avec ${atkCards.map(cardStr).join(' ')} (${atk} pts) contre ${targets.map(cardStr).join(' ')} (${def} pts) : ` +
            (success ? 'réussi !' : 'échec.')
        );
        if (opp.defense.length === 0) {
          this.eliminate(target);
          this.log(target, "n'a plus de défense et sort de la partie.");
          if (this.checkLastStanding()) return ok();
        }
        this.endTurn();
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

  // Passe à la phase suivante quand tous les joueurs en jeu ont fait leur choix.
  advancePhase() {
    const alive = this.aliveSeats().map((s) => this.players[s]);
    if (this.phase === 'setup' && alive.every((p) => p.setupDone)) {
      this.phase = 'reveal';
      this.log(null, `Chacun retourne ${this.rules.flip} de ses ${this.rules.bench} cartes de défense.`);
    } else if (this.phase === 'reveal' && alive.every((p) => p.revealDone)) {
      if (this.mode === 'duel') this.startByDraw();
      else this.startByLowestDefense();
    }
  }

  // Duel : chacun pioche une carte, la plus haute commence.
  startByDraw() {
    this.startDraws = [];
    let a, b;
    do {
      a = this.draw();
      b = this.draw();
      this.startDraws.push([a, b]);
      this.log(0, `pioche ${cardStr(a)}`);
      this.log(1, `pioche ${cardStr(b)}`);
      this.discard.push(a, b);
      if (a.rank === b.rank) this.log(null, 'Égalité : on pioche à nouveau.');
    } while (a.rank === b.rank);
    this.startPlay(RANKS.indexOf(a.rank) > RANKS.indexOf(b.rank) ? 0 : 1);
  }

  // Mêlée : la plus petite somme de défense révélée commence.
  startByLowestDefense() {
    const totals = this.aliveSeats().map((seat) => {
      const total = sum(this.players[seat].defense.filter((d) => d.up), (d) => defenseValue(d.card));
      this.log(seat, `a ${total} points de défense révélés.`);
      return { seat, total };
    });
    const min = Math.min(...totals.map((t) => t.total));
    const lowest = totals.filter((t) => t.total === min);
    if (lowest.length > 1) this.log(null, `Égalité à ${min} : le premier joueur est tiré au sort parmi les ex æquo.`);
    this.startPlay(lowest[Math.floor(this.rng() * lowest.length)].seat);
  }

  startPlay(seat) {
    this.turn = seat;
    this.phase = 'play';
    this.added = 0;
    this.log(seat, 'commence la partie.');
  }

  // La défense et la main d'un joueur sorti vont à la défausse.
  eliminate(seat) {
    const p = this.players[seat];
    this.discard.push(...p.hand, ...p.defense.map((d) => d.card));
    p.hand = [];
    p.defense = [];
    p.out = true;
  }

  // Un joueur abandonne en cours de partie.
  forfeit(seat) {
    const p = this.players[seat];
    if (this.phase === 'over' || !p || p.out) return;
    this.eliminate(seat);
    this.log(seat, 'abandonne la partie.');
    this.seq++;
    if (this.checkLastStanding()) return;
    if (this.phase !== 'play') this.advancePhase();
    else if (this.turn === seat) this.passTurn();
  }

  checkLastStanding() {
    const alive = this.aliveSeats();
    if (alive.length !== 1) return false;
    this.finish(alive, 'elimination');
    this.log(alive[0], 'est le dernier joueur en défense et remporte la partie !');
    return true;
  }

  finish(winners, reason, scores = null) {
    this.phase = 'over';
    this.turn = null;
    this.winners = winners;
    this.result = { reason, scores };
  }

  // Mêlée : pioche épuisée, la plus grosse somme de défense l'emporte.
  finishByDeck() {
    this.log(null, 'La pioche est épuisée : toutes les défenses sont révélées.');
    const scores = this.players.map((p, seat) => {
      if (p.out) return null;
      p.defense.forEach((d) => (d.up = true));
      const total = sum(p.defense, (d) => defenseValue(d.card));
      this.log(seat, `totalise ${total} points de défense.`);
      return total;
    });
    const best = Math.max(...scores.filter((x) => x !== null));
    const winners = this.aliveSeats().filter((s) => scores[s] === best);
    this.finish(winners, 'deck', scores);
    if (winners.length > 1) this.log(null, `Égalité à ${best} points : victoire partagée.`);
    else this.log(winners[0], 'remporte la partie !');
  }

  endTurn() {
    const p = this.players[this.turn];
    while (p.hand.length < 2) {
      const c = this.draw();
      if (!c) break;
      p.hand.push(c);
    }
    if (!this.rules.reshuffle && this.deck.length === 0) this.finishByDeck();
    else this.passTurn();
  }

  passTurn() {
    this.turn = this.nextSeat(this.turn);
    this.added = 0;
  }

  view(seat) {
    const me = this.players[seat];
    const n = this.players.length;
    // Adversaires dans l'ordre du jeu, en partant de mon voisin.
    const opponents = Array.from({ length: n - 1 }, (_, k) => {
      const s = (seat + k + 1) % n;
      const op = this.players[s];
      return {
        seat: s,
        handCount: op.hand.length,
        defense: op.defense.map((d) => ({ id: d.card.id, up: d.up, card: d.up ? d.card : null })),
        setupDone: op.setupDone,
        revealDone: op.revealDone,
        out: op.out,
      };
    });
    return {
      mode: this.mode,
      rules: this.rules,
      decks: this.decks,
      seq: this.seq,
      phase: this.phase,
      turn: this.turn,
      you: seat,
      winners: this.winners,
      result: this.result,
      added: this.added,
      deckCount: this.deck.length,
      discardCount: this.discard.length,
      discard: this.discard, // public : toutes ces cartes ont été révélées
      me: {
        hand: me.hand,
        defense: me.defense.map((d) => ({ id: d.card.id, up: d.up, card: d.card })),
        setupDone: me.setupDone,
        revealDone: me.revealDone,
        out: me.out,
      },
      opponents,
      lastAttack: this.lastAttack,
      startDraws: this.startDraws,
      log: this.logs.slice(-60),
    };
  }
}

module.exports = { Game, MODES, attackValue, defenseValue, baseValue, isRed, cardStr, shuffle, RANKS, SUITS };
