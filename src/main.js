import './ui/hud.css';
import Game from './game/Game.js';

const container = document.getElementById('app');

try {
  const game = new Game(container);
  game.run();
  // Handy for tuning from the console: FF.config, FF.game.score, etc.
  window.FF = { game, config: game.constructor };
} catch (err) {
  console.error(err);
  container.innerHTML = `
    <div style="position:fixed;inset:0;display:grid;place-items:center;padding:24px;
                font:14px/1.6 system-ui,sans-serif;color:#f2f5fa;background:#05070c;text-align:center">
      <div>
        <h1 style="font-size:20px;margin:0 0 10px">This browser could not start the game</h1>
        <p style="opacity:.7;margin:0 0 14px">Finger Flip needs WebGL 2.</p>
        <pre style="opacity:.5;font-size:11px;white-space:pre-wrap;max-width:60ch">${String(err && err.message)}</pre>
      </div>
    </div>`;
}
