'use strict';
const assert = require('assert');
const { Game, attackValue, defenseValue } = require('./game');
const { botMove } = require('./bot');

// --- Parties complètes bot contre bot, avec invariants ---
function total(g) {
  return (
    g.deck.length +
    g.discard.length +
    g.players.reduce((s, p) => s + p.hand.length + p.defense.length, 0)
  );
}

let turns = 0, maxTurns = 0, wins = [0, 0];
const N = 1500;
for (let n = 0; n < N; n++) {
  const g = new Game(['A', 'B']);
  let guard = 0;
  while (g.phase !== 'over') {
    assert(guard++ < 5000, 'partie trop longue');
    const seats = g.phase === 'play' ? [g.turn] : [0, 1];
    for (const s of seats) {
      const p = g.players[s];
      if ((g.phase === 'setup' && p.setupDone) || (g.phase === 'reveal' && p.revealDone)) continue;
      const mv = botMove(g.view(s));
      const r = g.act(s, mv);
      assert(!r.error, `${r.error} ${JSON.stringify(mv)}`);
      assert.strictEqual(total(g), 52);
      for (const pl of g.players) {
        assert(pl.defense.length <= 4);
        if (g.phase === 'play') assert.strictEqual(pl.hand.length + 0 >= 0, true);
      }
    }
  }
  wins[g.winner]++;
  turns += g.attackNo;
  maxTurns = Math.max(maxTurns, g.attackNo);
}
console.log(`OK ${N} parties. Attaques moyennes/partie: ${(turns / N).toFixed(1)}, max: ${maxTurns}, victoires J1/J2: ${wins}`);

// --- Règles d'invalidité ---
{
  const g = new Game(['A', 'B']);
  assert(g.act(0, { type: 'attack', cards: [0], targets: [1] }).error);
  assert(g.act(0, { type: 'setup', ids: g.players[0].hand.slice(0, 3).map((c) => c.id) }).error);
  const ids = g.players[0].hand.slice(0, 4).map((c) => c.id);
  assert(!g.act(0, { type: 'setup', ids }).error);
  assert(g.act(0, { type: 'setup', ids }).error); // déjà posé
  // vue adverse : cartes cachées sans identité
  const v = g.view(1);
  assert(v.opp.defense.every((d) => d.card === null));
  assert(g.view(0).me.defense.every((d) => d.card));
}
console.log('Tests de validation OK');
