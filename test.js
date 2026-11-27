'use strict';
const assert = require('assert');
const { Game, defenseValue } = require('./game');
const { botMove, botNeedsToAct } = require('./bot');

const names = (n) => ['A', 'B', 'C', 'D', 'E'].slice(0, n);
const total = (g) =>
  g.deck.length + g.discard.length + g.players.reduce((s, p) => s + p.hand.length + p.defense.length, 0);

// --- Parties complètes entre ordinateurs, avec invariants ---
function simulate(mode, nPlayers, count) {
  const ends = {};
  for (let n = 0; n < count; n++) {
    const g = new Game(names(nPlayers), { mode });
    let guard = 0;
    while (g.phase !== 'over') {
      assert(guard++ < 5000, 'partie trop longue');
      const seat = g.players.findIndex((_, i) => botNeedsToAct(g, i));
      assert(seat >= 0, 'personne ne peut jouer');
      const mv = botMove(g.view(seat));
      const r = g.act(seat, mv);
      assert(!r.error, `${r.error} ${JSON.stringify(mv)}`);
      assert.strictEqual(total(g), 52 * g.decks);
      for (const p of g.players) assert(p.defense.length <= g.rules.bench);
    }
    assert(g.winners.length >= 1);
    ends[g.result.reason] = (ends[g.result.reason] || 0) + 1;
  }
  console.log(`OK ${mode} à ${nPlayers} : ${count} parties`, ends);
}

simulate('duel', 2, 300);
for (let n = 2; n <= 5; n++) simulate('melee', n, 40);

// --- Règles d'invalidité ---
{
  const g = new Game(names(2));
  assert(g.act(0, { type: 'attack', cards: [0], targets: [1] }).error);
  assert(g.act(0, { type: 'setup', ids: g.players[0].hand.slice(0, 3).map((c) => c.id) }).error);
  const ids = g.players[0].hand.slice(0, 4).map((c) => c.id);
  assert(!g.act(0, { type: 'setup', ids }).error);
  assert(g.act(0, { type: 'setup', ids }).error); // déjà posé
  // vue adverse : cartes cachées sans identité
  const v = g.view(1);
  assert(v.opponents[0].defense.every((d) => d.card === null));
  assert(g.view(0).me.defense.every((d) => d.card));
}

// --- Mêlée : mise en place, premier joueur, abandon, fin de pioche ---
{
  const g = new Game(names(3), { mode: 'melee' });
  assert.strictEqual(g.deck.length, 3 * 52 - 3 * 7);
  g.players.forEach((p, s) => assert(!g.act(s, { type: 'setup', ids: p.hand.slice(0, 5).map((c) => c.id) }).error));
  g.players.forEach((p, s) => assert(!g.act(s, { type: 'reveal', ids: p.defense.slice(0, 2).map((d) => d.card.id) }).error));
  const shown = g.players.map((p) => p.defense.filter((d) => d.up).reduce((s, d) => s + defenseValue(d.card), 0));
  assert.strictEqual(shown[g.turn], Math.min(...shown));
  // avec 3 joueurs il faut préciser qui l'on attaque
  const me = g.turn;
  const foe = g.nextSeat(me);
  const attack = { type: 'attack', cards: [g.players[me].hand[0].id], targets: [g.players[foe].defense[0].card.id] };
  assert(g.act(me, attack).error);
  // abandon du joueur courant : le tour passe au suivant
  g.forfeit(me);
  assert.strictEqual(g.turn, foe);
  // la dernière carte piochée termine la partie, sans remélanger la défausse
  g.discard.push(...g.deck.splice(1));
  g.players[foe].defense.pop();
  assert(!g.act(foe, { type: 'add', ids: [g.players[foe].hand[0].id] }).error);
  assert(!g.act(foe, { type: 'end' }).error);
  assert.strictEqual(g.phase, 'over');
  assert.strictEqual(g.result.reason, 'deck');
  assert.strictEqual(g.result.scores[me], null);
}
console.log('Tests de règles OK');
