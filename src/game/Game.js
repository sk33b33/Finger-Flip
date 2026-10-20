import { Vector3, Quaternion, MathUtils } from 'three';

import Config from '../core/Config.js';
import GameTime, { nailScale } from '../core/GameTime.js';
import Input from '../core/Input.js';
import Haptics from '../core/Haptics.js';

import Board from '../sim/Board.js';
import Skater from '../sim/Skater.js';
import FingerFlipController from '../sim/Fingers.js';
import { recognise, describeSpin, fullName, quantiseBodySpin } from '../sim/Tricks.js';
import {
  evaluateLanding,
  previewLanding,
  predictTouchdown,
  bailThrow,
  Quality,
} from '../sim/Landing.js';
import { groundHeight, groundNormal, isLip, setLayout, getLayout } from '../sim/Park.js';

import ScoreSystem, { NailMeter } from './Score.js';
import FingerMapper from './FingerMapper.js';
import Profile from './Profile.js';
import { dailyChallenges, scoreEvent } from './Events.js';

import Stage from '../view/Stage.js';
import PostFX from '../view/PostFX.js';
import QualityManager from '../view/Quality.js';
import BoardMesh from '../view/BoardMesh.js';
import RiderMesh from '../view/RiderMesh.js';
import ParkMesh from '../view/ParkMesh.js';
import CameraRig from '../view/CameraRig.js';
import TrickFX, { predictLanding } from '../view/TrickFX.js';

import Hud from '../ui/Hud.js';
import Shell from '../ui/Shell.js';
import SkateGame, { Outcome } from './Skate.js';
import Tutorial from './Tutorial.js';
import Replay from './Replay.js';
import { earnedSet, newlyEarned, titleOf, isUnlocked, riderStates, deckStates } from './Unlocks.js';
import GhostHand from '../view/GhostHand.js';
import Install from '../core/Install.js';
import AudioEngine from '../audio/Audio.js';
import SpotifyMusic from '../audio/Spotify.js';

/**
 * Game — the state machine and the wiring, and nothing else. Every rule lives
 * in the module that owns it; this file only decides when each one runs.
 *
 *   ROLL -> POP -> AIR (NAIL_THE_TRICK) -> LANDING -> ROLL
 *                                       \-> BAIL -> RESET -> ROLL
 */

const UP = new Vector3(0, 1, 0);
// The rider's own lateral axis: what they topple over on a slam.
const FORWARD_TILT = new Vector3(1, 0, 0);
const RIDE_HEIGHT = 0.055; // board origin above the surface when rolling
const RIDER_OFFSET = 0.068; // rider's feet above the surface

const _v = new Vector3();
const _n = new Vector3();
const _travel = new Vector3();
const _bail = { velocity: new Vector3(), angularVelocity: new Vector3() };
const _q = new Quaternion();
const _q2 = new Quaternion();
const _predicted = new Vector3();
// The rider's interpolated render position. Its own vector rather than a shared
// scratch: the camera reads it forty lines after it is written, and it is now
// load-bearing for whether the trick shot is smooth.
const _riderRender = new Vector3();
const _screen = new Vector3();
// Replay playback targets. Written by Replay#sample and read straight into the
// meshes, so no allocation on a frame that is already drawing.
const _rbBoard = { position: new Vector3(), quaternion: new Quaternion() };
const _rbRider = { position: new Vector3(), quaternion: new Quaternion() };
const _rbPose = { crouch: 0, lean: 0, air: 0 };
const _rbOrbit = new Vector3();
const _rbLook = new Vector3();

/**
 * What the player is actually playing.
 *
 * FREE is the endless run the game has always been: pop whatever you like,
 * every trick scores. SKATE calls a trick and asks for that one. They share the
 * entire simulation — the difference is only what happens to a landing once the
 * sim has finished with it.
 */
export const Mode = Object.freeze({
  FREE: 'FREE',
  SKATE: 'SKATE',
  TUTORIAL: 'TUTORIAL',
});

export const State = Object.freeze({
  ROLL: 'ROLL',
  AIR: 'AIR',
  BAIL: 'BAIL',
});

export default class Game {
  constructor(container) {
    this.container = container;

    // --- core -------------------------------------------------------------
    this.time = new GameTime();
    this.stage = new Stage(container);
    this.input = new Input(this.stage.renderer.domElement);
    this.audio = new AudioEngine();
    // Optional, and inert without a client id. resume() below picks up an
    // existing session, or the redirect coming back from a sign-in.
    this.music = new SpotifyMusic({ clientId: import.meta.env?.VITE_SPOTIFY_CLIENT_ID });
    this.music.onChange(() => this.refreshMenu());
    this.haptics = new Haptics();

    // --- simulation -------------------------------------------------------
    this.skater = new Skater();
    this.board = new Board();
    this.fingers = new FingerFlipController();
    this.mapper = new FingerMapper(this.input, this.fingers);
    this.score = new ScoreSystem();
    this.meter = new NailMeter();
    this.profile = new Profile();
    this.today = dailyChallenges();
    this.bankedAirTime = 0;

    // --- presentation -----------------------------------------------------
    this.postFX = new PostFX(this.stage.renderer);
    this.quality = new QualityManager(this.stage, this.postFX);
    this.boardMesh = new BoardMesh();
    this.riderMesh = new RiderMesh();
    this.parkMesh = new ParkMesh();
    this.trickFX = new TrickFX();
    this.ghostHand = new GhostHand();
    this.cameraRig = new CameraRig(this.stage.camera);

    this.stage.scene.add(
      this.parkMesh,
      this.boardMesh,
      this.riderMesh,
      this.trickFX,
      this.ghostHand,
    );

    this.hud = new Hud(container);
    this.hud.onStart(() => this.enterMenu());
    this.hud.onMenu(() => this.enterMenu());
    this.hud.onReplay((close) => (close || this.replaying ? this.stopReplay() : this.startReplay()));

    // Installing changes the size of the deck under the player's finger: the
    // trick shot is fitted to the viewport, and an installed game is handed
    // back the browser's chrome. See core/Install.js.
    this.install = new Install();
    this.install.onChange(() => this.refreshMenu());

    this.shell = new Shell(container, this.profile);
    this.shell
      .on('play', () => this.startRun(Mode.FREE))
      .on('skate', () => this.startRun(Mode.SKATE))
      .on('learn', () => this.startRun(Mode.TUTORIAL))
      .on('close', () => this.leaveMenu())
      .on('tab', (tab) => this.shell.show(tab))
      .on('map', (id) => {
        this.setMap(id);
        this.profile.select({ mapId: id });
        this.refreshMenu();
      })
      .on('character', (id) => {
        // The menu already draws locked riders as locked; this is the second
        // line, so a stale menu or a crafted click cannot pick one.
        if (!isUnlocked('rider', id, this.profile.stats, this.profile.data)) return;
        this.setCharacter(id);
        this.profile.select({ characterId: id });
        this.refreshMenu();
      })
      .on('deck', (id) => {
        if (!isUnlocked('deck', id, this.profile.stats, this.profile.data)) return;
        this.setDeck(id);
        this.profile.select({ deckId: id });
        this.refreshMenu();
      })
      .on('quality', () => {
        this.quality.enabled = false;
        this.quality.setTier((this.quality.tier + 1) % QualityManager.tierCount);
        this.refreshMenu();
      })
      .on('mute', () => {
        this.audio.toggleMute();
        this.refreshMenu();
      })
      .on('install', () => this.install.prompt())
      .on('wipe', () => {
        this.profile.reset();
        this.refreshMenu();
      })
      .on('spotify-in', () => this.music.beginLogin())
      .on('spotify-out', () => this.music.disconnect())
      .on('spotify-toggle', () => this.music.toggle())
      .on('spotify-next', () => this.music.skip(1))
      .on('spotify-prev', () => this.music.skip(-1))
      .on('spotify-play', (uri) => this.music.playPlaylist(uri));

    this.stage.onResize = (w, h) => {
      this.postFX.setSize(w, h, this.stage.renderer.getPixelRatio());
      // The trick framing is fitted to the viewport, so a rotation or a resize
      // has to re-fit or the flick window silently changes size.
      this.cameraRig.fitToViewport();
    };
    this.postFX.setSize(this.stage.width, this.stage.height, this.stage.renderer.getPixelRatio());

    // --- state ------------------------------------------------------------
    this.state = State.ROLL;
    this.mode = Mode.FREE;
    this.skate = null;
    this.tutorial = null;
    this.replay = new Replay();
    this.replaying = null; // { clip, t, speed }
    this.replayOffer = 0;
    this.nailActive = false;
    this.trickBlendTarget = 0;
    this.flightT = 0;
    this.totalAirTime = 1;
    this.bailTimer = 0;
    this.bailRecoverAt = 1.7;
    this.rollTimer = 0;
    this.flash = 0;
    this.charging = false;
    this.chargeAmount = 0;
    this.lastLipPrompt = -1;
    this.taughtFingers = false;
    this.started = false;
    this.inMenu = false;
    this.running = false;
    this.lastTrick = { name: 'Ollie' };
    this.controls = { steer: 0, push: 1, brake: 0, charging: false };

    // Whatever was chosen last time. Applied after everything is built, since
    // both of these swap objects that are already in the scene graph.
    if (this.profile.data.mapId) this.setMap(this.profile.data.mapId);
    if (this.profile.data.characterId) this.setCharacter(this.profile.data.characterId);
    if (this.profile.data.deckId) this.setDeck(this.profile.data.deckId);

    this.resetRun();
    this._frame = this._frame.bind(this);

    // Fire and forget: a sign-in redirect has to be cleaned off the URL early,
    // and nothing else waits on music.
    this.music.resume();
  }

  // ------------------------------------------------------------ lifecycle ---

  /** True whenever the world should be standing still. */
  get paused() {
    return !this.started || this.inMenu || !!this.replaying;
  }

  // ----------------------------------------------------------------- menu ---

  /**
   * Open the hub. The world stops; the camera does not, so the backdrop reads
   * as a held shot rather than a hung frame.
   */
  enterMenu() {
    this.hud.hideStart();
    this.inMenu = true;
    // The audio context can only be unlocked inside a user gesture, and tapping
    // into the menu is the first one there is.
    this.audio.start();
    this.refreshMenu();
    this.shell.open(this.menuState());
  }

  /** Close the menu and pick the run back up where it was. */
  leaveMenu() {
    this.inMenu = false;
    this.shell.close();
  }

  /**
   * Drop in. The ONLY thing that starts the skater skating — closing the menu
   * does not, tapping the title card does not, and neither does any key. So
   * `close` resumes a run you already have and `startRun` begins a new one,
   * which is exactly what those two controls say they do.
   */
  startRun(mode = Mode.FREE) {
    this.started = true;
    this.inMenu = false;
    this.mode = mode;
    // A fresh game every time. Carrying letters across runs would mean the Drop
    // In button could end a game of S.K.A.T.E. you were not playing.
    this.skate = mode === Mode.SKATE ? new SkateGame() : null;
    this.tutorial = mode === Mode.TUTORIAL ? new Tutorial() : null;
    this.shell.close();
    this.resetRun();
    this.refreshCall();
    this.refreshLesson();
    this.hud.setHint(
      mode === Mode.SKATE
        ? 'Land the called trick'
        : mode === Mode.TUTORIAL
          ? 'Follow the line on the deck'
          : 'H for controls',
    );
  }

  /**
   * Has the player done the thing the current lesson asked for?
   *
   * Checked every rendered frame rather than at landing, because most of the
   * lessons are about something happening mid-flight — and because a step that
   * only resolves once the trick is over cannot hold the board in the air
   * waiting for it.
   */
  checkLesson() {
    const r = this.tutorial.update({
      state: this.state,
      charging: this.charging,
      spin: this.board.spin,
      caught: this.fingers.caught,
    });
    if (r.outcome === 'WAITING') return;

    if (r.celebrate) this.hud.showPrompt(r.celebrate.toUpperCase(), 2.4);
    this.audio.reward(r.outcome === 'FINISHED' ? 5 : 2);
    this.haptics.fire('land');

    if (r.outcome === 'FINISHED') {
      this.tutorial = null;
      this.mode = Mode.FREE;
      this.ghostHand.visible = false;
      this.profile.markTaught();
      this.hud.setHint('H for controls');
      this.refreshMenu();
    }
    this.refreshLesson();
  }

  /** Push the current lesson to the HUD, or clear it outside the tutorial. */
  refreshLesson() {
    const lesson = this.tutorial?.current;
    this.hud.setLesson(
      lesson ? { ...lesson, ...this.tutorial.progress } : null,
    );
  }

  /** Push the current call to the HUD, or clear it outside S.K.A.T.E. */
  refreshCall() {
    this.hud.setCall(
      this.skate && !this.skate.done
        ? { name: this.skate.called.name, letters: this.skate.letters }
        : null,
    );
  }

  // ---------------------------------------------------------------- replay ---

  /**
   * Close the clip the pop opened and, if it is worth watching, say so.
   *
   * Only offered, never forced: cutting to a replay on every landing would
   * take the run away from the player several times a minute.
   */
  offerReplay() {
    const clip = this.replay.close(this.time.realElapsed);
    this.lastClip = clip;
    if (!clip) return;
    this.replayOffer = 3.2;
    this.hud.setReplayOffer(true);
  }

  /**
   * Watch it back.
   *
   * The simulation is not touched — `paused` already covers it, because the
   * run is standing still while this is on screen. Playback writes the meshes
   * directly from the recording, so the world the camera is flying through is
   * literally the frames that were drawn.
   */
  startReplay() {
    const clip = this.lastClip;
    if (!clip || this.replaying) return;
    this.replaying = { clip, t: 0, speed: 0.45, orbit: 0 };
    this.replayOffer = 0;
    this.hud.setReplayOffer(false);
    this.hud.setReplaying(true);
    this.audio.setMusicDuck(1);
    this.time.setScale(1);
  }

  stopReplay() {
    if (!this.replaying) return;
    this.replaying = null;
    this.hud.setReplaying(false);
    this.audio.setMusicDuck(this.music.snapshot().connected ? 1 : 0);
    // Put the meshes back where the simulation actually has them, or the first
    // frame after a replay is drawn from wherever the clip finished.
    this.boardMesh.position.copy(this.board.position);
    this.boardMesh.quaternion.copy(this.board.quaternion);
    this.cameraRig.reset(this.skater);
  }

  /**
   * One frame of playback. Returns true while it still has the screen.
   *
   * Slower than it was recorded — 0.45x — because the whole reason for this is
   * that the trick was over too quickly the first time. Replay#sample
   * interpolates between the stored frames, so playing it back at under half
   * speed is smooth rather than a flipbook.
   */
  updateReplay(rd) {
    const r = this.replaying;
    if (!r) return false;

    const running = this.replay.sample(r.clip, r.t, _rbBoard, _rbRider, _rbPose);
    r.t += rd * r.speed;
    // Loops, rather than stopping on a frozen frame or dumping the player out:
    // a trick you are trying to understand usually needs more than one watch.
    if (!running) r.t = 0;

    this.boardMesh.position.copy(_rbBoard.position);
    this.boardMesh.quaternion.copy(_rbBoard.quaternion);
    this.riderMesh.position.copy(_rbRider.position);
    this.riderMesh.quaternion.copy(_rbRider.quaternion);
    this.riderMesh.setPose(_rbPose.crouch, _rbPose.lean, _rbPose.air);
    this.riderMesh.setFade(0);

    // A slow orbit. The point of a replay is the angle you did not have at the
    // time, so it keeps moving rather than sitting on one shot.
    //
    // Framed on a point ABOVE the board, not on the board itself: the rider is
    // 1.78m of the subject and aiming at the deck puts their head out of frame
    // and fills it with shins. The elevation breathes a little over the orbit
    // so the move does not read as a turntable.
    r.orbit += rd * 0.14;
    const a = r.orbit * Math.PI * 2;
    const range = 4.3;
    const look = _rbLook
      .copy(_rbBoard.position)
      .lerp(_rbRider.position, 0.45)
      .setY(_rbBoard.position.y + 0.62);
    _rbOrbit.set(
      look.x + Math.sin(a) * range,
      look.y + 0.85 + 0.35 * Math.sin(a * 2),
      look.z + Math.cos(a) * range,
    );
    this.stage.camera.position.copy(_rbOrbit);
    this.stage.camera.lookAt(look);
    this.stage.camera.fov = 42;
    this.stage.camera.updateProjectionMatrix();

    this.ghostHand.visible = false;
    return true;
  }

  /** Re-render the open menu in place, after something it shows has changed. */
  refreshMenu() {
    if (this.shell.isOpen) this.shell.open(this.menuState());
    else this.shell.state = this.menuState();
  }

  menuState() {
    return {
      mapId: this.map.id,
      characterId: this.character.id,
      quality: this.quality.label,
      muted: this.audio.muted,
      music: this.music.snapshot(),
      install: this.install.snapshot(),
      mode: this.mode,
      skate: this.skate ? this.skate.summary() : null,
      deckId: this.deckId || 'stock',
      riders: riderStates(this.profile.stats, this.profile.data),
      decks: deckStates(this.profile.stats, this.profile.data),
    };
  }

  /**
   * Switch parks. The sim's height function and the visual mesh both come off
   * the same layout, so they have to move together or you land on the park you
   * are no longer looking at.
   */
  setMap(id) {
    const layout = setLayout(id);
    this.parkMesh.rebuild();
    this.resetRun();
    return layout;
  }

  get map() {
    return getLayout();
  }

  /**
   * Swap riders. Every character comes off the same rig with the same API, so
   * the only thing that has to be careful here is not leaking the old one's
   * geometry and materials — a roster you can click through is a roster you can
   * click through fifty times.
   */
  setDeck(id) {
    this.boardMesh.setDeck(id);
    this.deckId = id;
  }

  setCharacter(id) {
    if (this.riderMesh.character?.id === id) return this.riderMesh.character;

    const old = this.riderMesh;
    this.stage.scene.remove(old);
    old.traverse((o) => {
      if (o.isMesh) o.geometry.dispose();
    });
    for (const m of old.allMaterials) m.dispose();

    this.riderMesh = new RiderMesh(id);
    this.riderMesh.position.copy(old.position);
    this.riderMesh.quaternion.copy(old.quaternion);
    this.stage.scene.add(this.riderMesh);
    return this.riderMesh.character;
  }

  get character() {
    return this.riderMesh.character;
  }

  run() {
    if (this.running) return;
    this.running = true;
    requestAnimationFrame(this._frame);
  }

  resetRun() {
    this.skater.reset(4);
    this.snapBoardToSkater();
    this.board.snapshot();
    this.skater.snapshot();
    this.fingers.reset();
    this.mapper.reset();
    this.score.reset();
    this.meter.reset();
    this.time.reset();
    this.cameraRig.reset(this.skater);
    this.replay.reset();
    this.replaying = null;
    this.replayOffer = 0;
    this.state = State.ROLL;
    // NOT the mode or the S.K.A.T.E. game. resetRun puts the rider and the
    // board back; it is also called on a restart mid-game, and clearing the
    // letters there would make R an undo button.
    this.nailActive = false;
    this.trickBlendTarget = 0;
    this.charging = false;
    this.chargeAmount = 0;
    this.rollTimer = 0;
    this.flash = 0;
  }

  // ------------------------------------------------------------ main loop ---

  _frame(now) {
    requestAnimationFrame(this._frame);

    const steps = this.time.beginFrame(now);
    const rd = this.time.realDelta;

    this.input.update(rd);
    this.handleGlobalKeys();

    if (this.started && !this.inMenu) {
      this.handleStateInput(rd);
      this.updateFingers(rd);
    }

    // The world only advances while a run is actually in progress. Rendering,
    // the camera and the UI carry on regardless — they run on real time — but
    // nothing simulates behind the title card or behind an open menu. It used
    // to: the gate above covered INPUT only, so the rider went on rolling,
    // hitting lips and slamming while you were reading the stats screen.
    if (!this.paused) {
      for (let i = 0; i < steps; i++) {
        this.board.snapshot();
        this.skater.snapshot();
        this.stepSim(Config.sim.fixedStep);
      }
    }

    // A replay owns the camera and the meshes while it is on screen, so the
    // normal presentation pass is skipped entirely rather than fought with.
    // The sim is already standing still — `paused` covers it.
    if (this.replaying) {
      this.updateReplay(rd);
      // Through PostFX like every other frame, so the replay is graded the
      // same as the game. A little of the slow-motion look is left in: it is
      // a replay, and it should not be mistaken for live.
      this.postFX.setLook(0.18, { x: 0.5, y: 0.5 }, 0, this.time.realElapsed);
      this.postFX.render(this.stage.scene, this.stage.camera);
    } else {
      this.updatePresentation(rd);
    }
    this.input.endFrame();
  }

  // ---------------------------------------------------------------- input ---

  handleGlobalKeys() {
    const i = this.input;
    if (i.pressed('Escape')) {
      // Before the first Drop In there is no run to go back to, so Escape has
      // nothing to close onto — the shell hides its own ✕ for the same reason.
      if (!this.inMenu) this.enterMenu();
      else if (this.started) this.leaveMenu();
      return;
    }
    // Everything below drives the run, and none of it should fire through an
    // open menu — the shell has the screen and the keyboard.
    if (this.inMenu) return;
    if (i.pressed('KeyV')) {
      if (this.replaying) this.stopReplay();
      else this.startReplay();
    }
    if (this.replaying) {
      // While a replay has the screen, nothing else is listening: any other
      // key or a tap puts the run back.
      if (i.pressed('Space') || i.pressed('KeyR')) this.stopReplay();
      return;
    }
    if (i.pressed('KeyH')) this.hud.toggleHelp();
    if (i.pressed('KeyR')) {
      this.resetRun();
      this.hud.showPrompt('RUN RESET', 1.1);
    }
    if (i.pressed('KeyM')) {
      const muted = this.audio.toggleMute();
      this.hud.showPrompt(muted ? 'MUTED' : 'SOUND ON', 1.0);
    }
    if (i.pressed('KeyP')) {
      // Cycle the quality tier by hand, which also pins it: someone who has
      // chosen a setting does not want it quietly moved back.
      this.quality.enabled = false;
      this.quality.setTier((this.quality.tier + 1) % QualityManager.tierCount);
      this.hud.showPrompt(`QUALITY: ${this.quality.label.toUpperCase()}`, 1.2);
    }
    // Any touch or key past the title card opens the hub, and doubles as the
    // gesture that unlocks audio.
    if (!this.started && (i.touchCount > 0 || i.keysPressed.size > 0)) {
      this.enterMenu();
    }
  }

  handleStateInput(rd) {
    const i = this.input;

    if (this.state === State.ROLL) {
      // Steering: keys, or the horizontal travel of a held touch.
      let steer = 0;
      if (i.down('KeyA') || i.down('ArrowLeft')) steer -= 1;
      if (i.down('KeyD') || i.down('ArrowRight')) steer += 1;
      let touchCharging = false;
      for (const p of i.pointers.values()) {
        if (!p.down) continue;
        touchCharging = true;
        steer += MathUtils.clamp((p.x - p.startX) * 3.4, -1, 1);
      }
      this.controls = {
        steer: MathUtils.clamp(steer, -1, 1),
        push: 1,
        brake: 0,
        charging: this.charging,
      };

      const wantCharge = i.down('Space') || touchCharging;
      if (wantCharge && !this.charging) {
        this.charging = true;
        this.chargeAmount = 0;
      }
      if (this.charging) {
        this.chargeAmount = Math.min(1, this.chargeAmount + rd / Config.pop.chargeTime);
        if (!wantCharge) this.pop(this.chargeAmount);
      }
    } else {
      this.controls = { steer: 0, push: 0, brake: 0, charging: false };
      // Nothing else is bound in the air. The only controls up there are the two
      // fingers, and the landing takes itself the moment the wheels touch.
    }
  }

  /** Sample the two fingers. Only meaningful once the board is free. */
  updateFingers(rd) {
    if (this.state !== State.AIR) {
      for (const f of this.fingers.fingers) f.active = false;
      return;
    }
    this.mapper.updateBasis(this.stage.camera, this.boardMesh.position, this.cameraRig.stanceQuat);
    this.mapper.update(rd);

    const before = this.fingers.totalFlicks;
    const caughtBefore = this.fingers.caught;
    const omegaBefore = this.board.angularVelocity.length();
    this.fingers.update(this.board, this.cameraRig.stanceQuat, rd, this.flightT, this.skater.velocity);

    // Development aid: set FF.trace = [] in the console to record the input
    // path frame by frame. Costs nothing when tracing is off.
    if (this.trace) {
      this.trace.push({
        rd: +rd.toFixed(4),
        f: this.fingers.fingers.map((f) => ({
          on: f.active,
          c: +f.contact.toFixed(2),
          x: +f.pos.x.toFixed(3),
          z: +f.pos.z.toFixed(3),
          px: +f.prevPos.x.toFixed(3),
          v: +f.vel.length().toFixed(2),
        })),
        dw: +(this.board.angularVelocity.length() - omegaBefore).toFixed(3),
        w: +this.board.angularVelocity.length().toFixed(2),
      });
      if (this.trace.length > 400) this.trace.shift();
    }
    if (this.fingers.totalFlicks > before) {
      const f = this.fingers.fingers.reduce((a, b) =>
        b.lastReleaseSpeed > a.lastReleaseSpeed ? b : a,
      );
      this.audio.flick(Math.min(1, 0.4 + f.lastReleaseSpeed * 0.18));
      this.haptics.fire('flick');
    }
    if (this.fingers.caught && !caughtBefore) {
      this.audio.catchSound(this.fingers.catchStrength);
      this.haptics.fire('catch');
    }
  }

  // ----------------------------------------------------------- simulation ---

  stepSim(dt) {
    if (this.state === State.ROLL) {
      this.skater.step(dt, this.controls);
      this.snapBoardToSkater();
      this.rollTimer += dt;
      // Bank the line once the player has just been rolling for a while.
      if (this.rollTimer > 2.2 && this.score.comboPending > 0) this.bankLine();
      this.meter.gainFromRolling(dt, this.skater.speedNormalised);

      // A lip launches you whether or not you popped.
      const { x, z } = this.skater.position;
      if (groundHeight(x, z) - groundHeight(x, z + 0.55) > 0.22) {
        this.pop(this.chargeAmount * 0.6);
      }
      return;
    }

    if (this.state === State.AIR) {
      // A tutorial step that is waiting for a flick HOVERS: the board stops
      // moving but keeps turning, so it can be worked on for as long as the
      // player needs. Slowing time down instead does not do it — at the trick
      // scale, half a minute of reading the instructions is still four world
      // seconds, and the deck is long since on the floor. A lesson you can
      // fail by reading it carefully is not a lesson.
      if (this.tutorial?.hovering) {
        this.board.integrateRotation(dt);
        return;
      }
      this.skater.step(dt, this.controls);
      this.board.step(dt);
      this.flightT = MathUtils.clamp(this.skater.airTime / this.totalAirTime, 0, 1);
      if (this.skater.checkTouchdown()) this.resolveLanding();
      return;
    }

    if (this.state === State.BAIL) {
      // The rider keeps sliding: coming to a dead stop on impact reads as a
      // freeze rather than a slam.
      this.skater.position.addScaledVector(this.skater.velocity, dt);
      this.skater.position.y = groundHeight(this.skater.position.x, this.skater.position.z);
      this.skater.velocity.multiplyScalar(Math.max(0, 1 - 3.4 * dt));

      this.board.step(dt);
      // Let the board bounce and skitter away.
      const h = groundHeight(this.board.position.x, this.board.position.z);
      if (this.board.position.y < h + 0.05 && this.board.velocity.y < 0) {
        this.board.position.y = h + 0.05;
        this.board.velocity.y *= -0.42;
        this.board.velocity.x *= 0.72;
        this.board.velocity.z *= 0.72;
        this.board.angularVelocity.multiplyScalar(0.62);
      }
    }
  }

  /** While rolling the board is rigidly attached under the rider. */
  snapBoardToSkater() {
    const s = this.skater;
    groundNormal(s.position.x, s.position.z, _n);
    _q.setFromAxisAngle(UP, s.yaw + (s.fakie ? Math.PI : 0));
    _q2.setFromUnitVectors(UP, _n);
    this.board.quaternion.copy(_q2).multiply(_q);
    this.board.position.copy(s.position).addScaledVector(_n, RIDE_HEIGHT);
    this.board.velocity.copy(s.velocity);
    this.board.angularVelocity.set(0, 0, 0);
    this.board.airborne = false;
  }

  // --------------------------------------------------------------- events ---

  pop(charge) {
    if (this.state !== State.ROLL) return;
    this.charging = false;
    this.chargeAmount = 0;

    // Whatever the player is steering at this instant becomes body spin.
    this.skater.takeOff(MathUtils.clamp(charge, 0, 1), this.controls.steer);

    // Hand the board over to the fingers, level in the stance frame. Leaving it
    // at the ramp's angle would start every kicker trick with the deck out of
    // the fingers' reach, and it is not what a rider does anyway: you level the
    // board off the lip. The ramp's rotation survives as the pop's pitch kick.
    this.board.quaternion.setFromAxisAngle(
      UP,
      this.skater.yaw + (this.skater.fakie ? Math.PI : 0),
    );
    groundNormal(this.skater.position.x, this.skater.position.z, _n);
    this.board.position.copy(this.skater.position).addScaledVector(_n, RIDE_HEIGHT + 0.02);
    this.board.velocity.copy(this.skater.velocity);
    this.board.velocity.y += 0.35; // the deck leaves the feet a touch faster
    this.board.airborne = true;
    this.board.spin.set(0, 0, 0);
    // The pop itself kicks the nose up. Levelling it back out is the player's
    // first job, and the reason a finger goes on the nose.
    this.board.angularVelocity.set(Config.pop.pitchKick, 0, 0);

    this.fingers.reset();
    this.mapper.reset();
    this.mapper.homeKeyFingers();
    this.cameraRig.beginTrick(this.skater);

    this.totalAirTime = Math.max(0.25, estimateAirTime(this.skater));
    this.flightT = 0;
    this.state = State.AIR;
    this.replay.mark(this.time.realElapsed);
    this.rollTimer = 0;

    this.audio.pop(0.5 + charge * 0.6);
    this.haptics.fire('pop');
    this.cameraRig.addShake(0.1 + charge * 0.16);

    if (this.meter.canActivate) {
      this.enterNail();
      // Not during the tutorial: the lesson panel is already saying this, at
      // greater length and in the right place, and the two overlap on screen.
      if (!this.taughtFingers && !this.tutorial) {
        this.taughtFingers = true;
        this.hud.showPrompt('TWO FINGERS ON THE BOARD', 2.4);
      }
    } else {
      this.hud.showPrompt('NO NAIL METER — RIDE IT OUT', 1.3);
      this.audio.denied();
      this.haptics.fire('denied');
    }
  }

  enterNail() {
    this.nailActive = true;
    this.trickBlendTarget = 1;
    this.time.requestScale(Config.nail.timeScale, Config.nail.enterDuration);
    this.audio.timeWarpIn();
    this.hud.hidePrompt();
  }

  exitNail() {
    if (!this.nailActive) return;
    this.nailActive = false;
    this.trickBlendTarget = 0;
    this.time.requestScale(1, Config.nail.exitDuration);
    this.audio.timeWarpOut();
  }

  resolveLanding() {
    const s = this.skater;
    groundNormal(s.position.x, s.position.z, _n);
    s.travelDir(_travel);

    const landing = evaluateLanding(this.board, _n, _travel, s.position);
    const trick = recognise(this.board.spin);
    const bodyTurns = quantiseBodySpin(s.airYaw);
    const name = fullName(trick, bodyTurns);
    this.lastTrick = { ...trick, name };

    const hands = {
      flicks: this.fingers.totalFlicks,
      caught: this.fingers.caught,
      catchStrength: this.fingers.catchStrength,
      catchAt: this.fingers.lastCatchAtNormalisedTime,
    };
    const flight = {
      airTime: s.airTime,
      peakHeight: s.peakHeight,
      takeoffSpeed: s.takeoffSpeed,
    };

    this.exitNail();
    this.flash = landing.quality === Quality.BAIL ? 0.28 : 0.14 + landing.score * 0.2;

    const result = this.score.award(trick, landing, flight, hands, { bodyTurns, name });
    this.recordProgress({ type: 'trick', breakdown: result, mapId: this.map.id });

    // S.K.A.T.E. judges the same landing a second time, against a different
    // question: not how well you flicked, but whether it was the trick that
    // was asked for. Everything above is untouched by it — the run still
    // scores normally underneath the game.
    if (this.skate && !this.skate.done) this.judgeCall(trick, landing);

    // A slam in the tutorial costs the trick being taught and nothing else.
    if (this.tutorial && landing.quality === Quality.BAIL) {
      this.tutorial.rewind();
      this.refreshLesson();
      this.hud.showPrompt('HAVE ANOTHER GO', 1.8);
    }

    if (landing.quality === Quality.BAIL) {
      this.bail({ ...trick, name }, landing);
      return;
    }

    s.land(landing.fakie);
    this.snapBoardToSkater();
    this.state = State.ROLL;
    this.rollTimer = 0;
    this.meter.gainFromTrick(landing.score);

    // Rough landings scrub speed; perfect ones keep it.
    s.speed *= 0.72 + 0.28 * landing.score;

    this.audio.land(landing.score);
    this.haptics.fire(landing.quality === Quality.PERFECT ? 'perfect' : 'land');
    this.cameraRig.addShake(0.16 + (1 - landing.score) * 0.4);
    this.trickFX.burst(s.position, 0.3 + landing.score * 0.7, landing.score > 0.7 ? 0xa8ffe0 : 0xffd9a0);

    this.hud.showResult({
      trick: name,
      quality: landing.quality,
      points: result.points,
      note: buildNote(result, landing),
    });

    this.offerReplay();
  }

  /**
   * Put an attempt through the game of S.K.A.T.E.
   *
   * Deliberately after the scoring and before the bail handling, so a slam
   * still takes its letter and still looks like a slam.
   */
  judgeCall(trick, landing) {
    const r = this.skate.attempt({ performed: trick, landing });
    this.refreshCall();

    if (r.outcome === Outcome.LANDED) {
      // Nailed exactly, rather than scraped inside the tolerance, is worth
      // saying out loud — it is the difference the mode exists to measure.
      const bang = r.closeness > 0.75;
      this.hud.showPrompt(bang ? 'BOLTS — NEXT' : 'MADE IT — NEXT', 1.5);
      this.audio.reward(bang ? 5 : 3);
      this.haptics.fire(bang ? 'perfect' : 'land');
      this.profile.recordSkate({ landed: 1 });
    } else if (r.done) {
      this.hud.showPrompt(`S.K.A.T.E. — ${this.skate.landedCount} LANDED`, 2.6);
      this.audio.denied();
      const earnedBefore = earnedSet(this.profile.stats, this.profile.data);
      this.profile.recordSkate({ games: 1, best: this.skate.landedCount });
      this.announceUnlocks(earnedBefore);
      // Back to free skating rather than freezing: the run carries on, and the
      // menu is one tap away if they want another game.
      this.mode = Mode.FREE;
      this.skate = null;
      this.refreshCall();
      this.refreshMenu();
    } else {
      this.hud.showPrompt(`${r.letter} — ${r.reason}`, 2.0);
      this.audio.denied();
      this.haptics.fire('denied');
    }
  }

  bail(trick, landing) {
    this.state = State.BAIL;
    this.bailTimer = 0;

    const s = this.skater;
    s.airborne = false;
    s.position.y = groundHeight(s.position.x, s.position.z);
    s.velocity.y = 0;

    // Everything about the slam is derived from the landing that caused it —
    // where the board was going, what it was already doing, and how badly it
    // was missed. See sim/Landing.js#bailThrow for why that matters.
    s.travelDir(_travel);
    const thrown = bailThrow(this.board, landing, _travel, s.position, s.speed, _bail);

    s.velocity.multiplyScalar(thrown.riderKeep);
    s.speed = 0;
    this.bailRecoverAt = thrown.recoverSeconds;

    this.board.velocity.copy(thrown.velocity);
    this.board.angularVelocity.copy(thrown.angularVelocity);
    this.board.airborne = true;

    this.audio.bail();
    this.haptics.fire('bail');
    // A scrape and a proper slam should not shake the camera the same amount.
    this.cameraRig.addShake(0.42 + 0.5 * thrown.severity);
    this.trickFX.burst(s.position, 0.6 + 0.5 * thrown.severity, 0xff8a5a);

    this.hud.showResult({
      trick: trick.name,
      quality: 'BAIL',
      points: 0,
      note: landing.reasons[0] || 'Lost it',
    });

    // Slams are worth watching back too — arguably more than the clean ones.
    this.offerReplay();
  }

  /**
   * Say so the moment something is earned.
   *
   * Unlocks are derived from the stats rather than stored, so there is no
   * event to listen to — the only way to notice one is to look before and
   * after whatever just changed the stats. Cheap: it is a handful of
   * comparisons over a table of seven.
   */
  announceUnlocks(before) {
    const after = earnedSet(this.profile.stats, this.profile.data);
    const fresh = newlyEarned(before, after);
    if (!fresh.length) return;
    this.hud.showPrompt(`UNLOCKED — ${titleOf(fresh[0]).toUpperCase()}`, 2.6);
    this.audio.reward(5);
    this.haptics.fire('perfect');
    this.refreshMenu();
  }

  bankLine() {
    // Snapshotted here rather than left to recordProgress: recordRun moves
    // bestScore and totalScore BEFORE recordProgress runs, so by the time it
    // takes its own snapshot an unlock earned by this line is already in it
    // and would never be announced.
    const earnedBefore = earnedSet(this.profile.stats, this.profile.data);
    const banked = this.score.bank();
    if (banked > 0) {
      this.audio.reward(Math.min(5, 1 + Math.floor(banked / 1500)));
      this.hud.showPrompt(`BANKED +${Math.round(banked).toLocaleString('en-US')}`, 1.5);
      this.profile.recordRun({ banked, mapId: this.map.id, airTime: this.bankedAirTime });
      this.recordProgress({ type: 'run', banked, mapId: this.map.id });
      this.bankedAirTime = 0;
      this.announceUnlocks(earnedBefore);
    }
  }

  /**
   * Feed one event to the profile and to today's challenges.
   *
   * Both read the same breakdown ScoreSystem already produced, which is why
   * neither of them has to know anything about the game — and why this is the
   * only place either of them is touched.
   */
  recordProgress(ev) {
    // Snapshot first: every unlock is a function of the stats this is about to
    // move, and the only way to notice one landing is to compare across it.
    const earnedBefore = earnedSet(this.profile.stats, this.profile.data);

    if (ev.type === 'trick') {
      this.profile.recordTrick(ev.breakdown, ev.mapId);
      this.bankedAirTime += ev.breakdown.airTime || 0;
    }
    for (const moved of scoreEvent(ev, this.today)) {
      const before = this.profile.eventProgress(moved.id);
      const after = this.profile.advanceEvent(moved.id, moved.amount, moved.goal);
      if (after.done && !before.done) {
        const challenge = this.today.find((c) => c.id === moved.id);
        this.hud.showPrompt(`CHALLENGE: ${challenge.name.toUpperCase()}`, 2.2);
        this.audio.reward(5);
      }
    }

    this.announceUnlocks(earnedBefore);
  }

  recoverFromBail() {
    const s = this.skater;
    // Put the rider back on flat ground a little way behind, so they get a
    // proper run-up at the feature they just ate.
    let z = s.position.z - 16;
    for (let i = 0; i < 60 && groundHeight(0, z) > 0.02; i++) z -= 1;
    s.reset(z);
    this.snapBoardToSkater();
    this.board.snapshot();
    this.skater.snapshot();
    this.fingers.reset();
    this.mapper.reset();
    this.time.setScale(1);
    this.cameraRig.reset(s);
    this.riderMesh.setPose(0, 0, 0);
    this.state = State.ROLL;
    this.rollTimer = 0;
    this.charging = false;
    this.chargeAmount = 0;
  }

  // ---------------------------------------------------------- presentation ---

  updatePresentation(rd) {
    const alpha = this.time.alpha;

    // --- Nail-the-Trick pacing -------------------------------------------
    if (this.state === State.AIR && this.nailActive) {
      if (this.tutorial?.hovering) {
        // No drain and no relaxation while a lesson is waiting. The meter
        // running out mid-explanation would throw the player back to full
        // speed holding a board they have not been told what to do with.
        this.time.requestScale(Config.nail.timeScale, Config.nail.enterDuration);
      } else if (!this.meter.drain(rd)) {
        this.exitNail();
        this.hud.showPrompt('METER OUT', 0.9);
      } else {
        // One flat scale, easing back toward normal over the last stretch
        // before the wheels touch — measured in seconds to the floor, so the
        // window is the same length whatever height the trick was launched at.
        const { t } = predictTouchdown(this.board.position, this.board.velocity, _predicted);
        this.time.requestScale(nailScale(t), Config.nail.enterDuration);
      }
    }

    if (this.state === State.BAIL) {
      this.bailTimer += rd;
      this.riderMesh.setBailPose(this.bailTimer);
      if (this.bailTimer > this.bailRecoverAt) this.recoverFromBail();
    }

    // --- Interpolated transforms ------------------------------------------
    // Everything below this line works in RENDER space. The simulation position
    // is only ever a source for the interpolation; the camera, the lights, the
    // effects and the finger basis all read the interpolated result, so nothing
    // visual can disagree with where the board is drawn.
    this.boardMesh.position.lerpVectors(this.board.prevPosition, this.board.position, alpha);
    this.boardMesh.quaternion
      .copy(this.board.prevQuaternion)
      .slerp(this.board.quaternion, alpha);

    _riderRender.lerpVectors(this.skater.prevPosition, this.skater.position, alpha);
    this.riderMesh.position.copy(_riderRender);
    if (this.state !== State.BAIL) {
      groundNormal(_riderRender.x, _riderRender.z, _n);
      this.riderMesh.position.addScaledVector(_n, RIDER_OFFSET);
    }
    if (this.state === State.BAIL) {
      // Tumble forward onto the deck. The pivot is the feet, so the body swings
      // down and out ahead of where the rider was standing.
      const t = MathUtils.clamp(this.bailTimer / 0.5, 0, 1);
      const fall = t * t * (3 - 2 * t);
      _q.setFromAxisAngle(UP, this.skater.yaw);
      _q2.setFromAxisAngle(FORWARD_TILT, fall * 1.5);
      this.riderMesh.quaternion.copy(_q).multiply(_q2);
      this.riderMesh.position.y += 0.1 * fall;
    } else {
      this.riderMesh.quaternion.setFromAxisAngle(UP, this.skater.yaw);
    }

    if (this.state === State.ROLL) {
      this.boardMesh.updateWheels(this.skater.speed, rd);
      this.riderMesh.setPose(this.skater.crouch, this.skater.lean, 0);
    } else if (this.state === State.AIR) {
      this.riderMesh.setPose(0.2, 0, 1);
    }
    // The tail flame runs on real time, so it keeps flickering at its own rate
    // while the world is in slow motion.
    this.riderMesh.update(rd);

    // --- Camera ------------------------------------------------------------
    // The slam into the close-up is quicker than the pull back out: arriving
    // fast reads as a cut, leaving slowly reads as a release.
    const blendRate =
      this.trickBlendTarget > this.cameraRig.trickBlend
        ? Config.camera.trickLerp
        : Config.camera.trickExitLerp;
    this.cameraRig.trickBlend = MathUtils.lerp(
      this.cameraRig.trickBlend,
      this.trickBlendTarget,
      1 - Math.exp(-blendRate * rd),
    );
    this.cameraRig.update(rd, {
      riderPos: _riderRender,
      riderYaw: this.skater.yaw,
      boardPos: this.boardMesh.position,
      flightT: this.flightT,
      paused: this.paused,
    });
    // The rider ghosts out ahead of the camera arriving, so the deck is never
    // behind a thigh at the moment the player needs to read it.
    this.riderMesh.setFade(smoothstep(0.12, 0.55, this.cameraRig.trickBlend) * 0.94);
    this.stage.focusShadows(this.riderMesh.position);
    this.stage.setTrickLighting(this.cameraRig.trickBlend, this.boardMesh.position);
    this.stage.syncSky();
    this.parkMesh.follow(this.skater.position.z);

    // --- Trick readability -------------------------------------------------
    let landingQuality = 0;
    let predicted = null;
    if (this.state === State.AIR) {
      predictLanding(this.skater.position, this.skater.velocity, _predicted);
      groundNormal(_predicted.x, _predicted.z, _n);
      this.skater.travelDir(_travel);
      landingQuality = previewLanding(this.board, _n, _travel);
      predicted = _predicted;
    }

    this.trickFX.update(rd, {
      boardPos: this.boardMesh.position,
      fingers: this.fingers,
      stanceQuat: this.cameraRig.stanceQuat,
      trickActive: this.state === State.AIR,
      landingQuality,
      predictedLanding: predicted,
      airborne: this.state === State.AIR,
    });

    // --- Post effects ------------------------------------------------------
    const slowmo = MathUtils.clamp(1 - (this.time.timeScale - 0.1) / 0.9, 0, 1);
    this.flash = Math.max(0, this.flash - rd * 1.9);
    _screen.copy(this.boardMesh.position).project(this.stage.camera);
    const focus =
      this.state === State.AIR
        ? { x: _screen.x * 0.5 + 0.5, y: _screen.y * 0.5 + 0.5 }
        : { x: 0.5, y: 0.5 };
    this.postFX.setLook(slowmo, focus, this.flash, this.time.realElapsed);

    // --- Replay ------------------------------------------------------------
    // Recorded AFTER the transforms above are final, because what the replay
    // keeps is what was on the screen. See game/Replay.js for why it stores
    // answers rather than inputs.
    if (!this.replaying) {
      this.replay.record(
        this.time.realElapsed,
        this.boardMesh.position,
        this.boardMesh.quaternion,
        this.riderMesh.position,
        this.riderMesh.quaternion,
        this.skater.crouch,
        this.skater.lean,
        this.state === State.AIR ? 1 : 0,
      );
      if (this.replayOffer > 0) {
        this.replayOffer = Math.max(0, this.replayOffer - rd);
        if (this.replayOffer === 0) this.hud.setReplayOffer(false);
      }
    }

    // --- Tutorial ----------------------------------------------------------
    // Every frame and in every state, NOT alongside the finger sampling where
    // it started out: updateFingers returns early unless the board is in the
    // air, so the two roll-in lessons were never checked and the sequence
    // could not get off its first step.
    //
    // The guide is drawn from the same hand plane the mapper uses and from the
    // INTERPOLATED board position, or it would swim against the deck it is
    // painted on.
    if (this.tutorial) {
      this.ghostHand.update(
        this.state === State.AIR ? this.tutorial.ghost : null,
        this.boardMesh.position,
        this.cameraRig.stanceQuat,
        rd,
      );
      this.checkLesson();
    } else {
      this.ghostHand.visible = false;
    }


    // --- Audio -------------------------------------------------------------
    this.audio.updateRoll(this.skater.speed, this.state === State.ROLL, slowmo);
    this.audio.setSlowmo(slowmo);
    // The music cannot go through the filter bus — it is a different graph, and
    // in remote mode a different machine — so it ducks instead. Same intent as
    // the filter closing: the trick window should sound like somewhere else.
    this.music.setDuck(slowmo * Config.music.duckInSlowmo);

    // The synthesised bed, which DOES go through the bus. Its energy is the
    // speed the rider is carrying, dropped to nothing while they are in the
    // air: the kit cutting out on the pop is what makes the trick window feel
    // like it has been lifted out of the run. And if the player has Spotify
    // connected, the bed gets out of the way entirely — two soundtracks at
    // once is worse than either one.
    const rolling = this.state === State.ROLL;
    this.audio.setMusicEnergy(
      rolling ? 0.3 + 0.7 * Math.min(1, this.skater.speed / Config.skater.maxSpeed) : 0.12,
    );
    this.audio.setMusicDuck(this.music.snapshot().connected ? 1 : 0);

    // --- HUD ---------------------------------------------------------------
    let liveTrick = this.lastTrick;
    if (this.state === State.AIR) {
      const t = recognise(this.board.spin);
      liveTrick = { ...t, name: fullName(t, quantiseBodySpin(this.skater.airYaw)) };
    }
    this.hud.update({
      realDelta: rd,
      score: this.score.total,
      pending: this.score.comboPending,
      comboMultiplier: this.score.comboMultiplier,
      comboLength: this.score.comboLength,
      speed: this.skater.speed,
      meter: this.meter.normalised,
      trickActive: this.state === State.AIR,
      trickName: liveTrick.name,
      spin: describeSpin(this.board.spin),
      bodySpin: this.state === State.AIR ? this.skater.airYaw : 0,
      landingQuality,
    });

    this.maybePromptLip();

    // --- Render ------------------------------------------------------------
    this.postFX.render(this.stage.scene, this.stage.camera);

    // Measured after the frame is submitted, so it reflects what drawing it
    // actually cost rather than what the last one did.
    this.quality.update(rd);
  }

  /** Nudge the player to charge a pop as a lip comes up. */
  maybePromptLip() {
    if (this.state !== State.ROLL) return;
    const z = this.skater.position.z;
    const near = isLip(this.skater.position.x, z + 6, 1.6);
    if (near && z - this.lastLipPrompt > 20) {
      this.lastLipPrompt = z;
      this.hud.showPrompt(this.charging ? 'RELEASE TO POP' : 'HOLD TO CHARGE', 1.4);
    }
  }
}

function smoothstep(a, b, x) {
  const t = MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Solve the rider's flight time against the height field. */
/**
 * How long this flight will last, which is what the trick camera and the HUD
 * use to know how far through it they are.
 *
 * Was a third hand-rolled copy of the ballistic march, and the crudest of them:
 * off a quarterpipe it reported 0.25s for a flight that ran 1.5, so flightT hit
 * 1 almost immediately and the trick camera sat at full landing pullback for
 * the whole trick with the deck tiny in frame.
 */
function estimateAirTime(skater) {
  return predictTouchdown(skater.position, skater.velocity).t;
}

function buildNote(result, landing) {
  const bits = [];
  if (result.repeated) bits.push('repeat — half score');
  if (result.lateCatch) bits.push('late catch');
  else if (result.caught) bits.push('caught');
  if (landing.fakie) bits.push('fakie');
  if (landing.reasons.length) bits.push(landing.reasons[0].toLowerCase());
  return bits.slice(0, 2).join(' · ');
}
