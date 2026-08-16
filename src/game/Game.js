import { Vector3, Quaternion, MathUtils } from 'three';

import Config from '../core/Config.js';
import GameTime from '../core/GameTime.js';
import Input from '../core/Input.js';
import Haptics from '../core/Haptics.js';

import Board from '../sim/Board.js';
import Skater from '../sim/Skater.js';
import FingerFlipController from '../sim/Fingers.js';
import { recognise, describeSpin, fullName, quantiseBodySpin } from '../sim/Tricks.js';
import { evaluateLanding, previewLanding, Quality } from '../sim/Landing.js';
import GrabTracker from '../sim/Grabs.js';
import { groundHeight, groundNormal, isLip } from '../sim/Park.js';

import ScoreSystem, { NailMeter } from './Score.js';
import FingerMapper from './FingerMapper.js';

import Stage from '../view/Stage.js';
import PostFX from '../view/PostFX.js';
import QualityManager from '../view/Quality.js';
import BoardMesh from '../view/BoardMesh.js';
import RiderMesh from '../view/RiderMesh.js';
import ParkMesh from '../view/ParkMesh.js';
import CameraRig from '../view/CameraRig.js';
import TrickFX, { predictLanding } from '../view/TrickFX.js';

import Hud from '../ui/Hud.js';
import AudioEngine from '../audio/Audio.js';

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
const _q = new Quaternion();
const _q2 = new Quaternion();
const _predicted = new Vector3();
const _screen = new Vector3();

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
    this.haptics = new Haptics();

    // --- simulation -------------------------------------------------------
    this.skater = new Skater();
    this.board = new Board();
    this.fingers = new FingerFlipController();
    this.grabs = new GrabTracker();
    this.mapper = new FingerMapper(this.input, this.fingers);
    this.score = new ScoreSystem();
    this.meter = new NailMeter();

    // --- presentation -----------------------------------------------------
    this.postFX = new PostFX(this.stage.renderer);
    this.quality = new QualityManager(this.stage, this.postFX);
    this.boardMesh = new BoardMesh();
    this.riderMesh = new RiderMesh();
    this.parkMesh = new ParkMesh();
    this.trickFX = new TrickFX();
    this.cameraRig = new CameraRig(this.stage.camera);

    this.stage.scene.add(this.parkMesh, this.boardMesh, this.riderMesh, this.trickFX);

    this.hud = new Hud(container);
    this.hud.onStart(() => this.begin());
    this.hud.onCommit(() => this.commitLanding());

    this.stage.onResize = (w, h) => {
      this.postFX.setSize(w, h, this.stage.renderer.getPixelRatio());
      // The trick framing is fitted to the viewport, so a rotation or a resize
      // has to re-fit or the flick window silently changes size.
      this.cameraRig.fitToViewport();
    };
    this.postFX.setSize(this.stage.width, this.stage.height, this.stage.renderer.getPixelRatio());

    // --- state ------------------------------------------------------------
    this.state = State.ROLL;
    this.nailActive = false;
    this.trickBlendTarget = 0;
    this.flightT = 0;
    this.totalAirTime = 1;
    this.bailTimer = 0;
    this.rollTimer = 0;
    this.flash = 0;
    this.charging = false;
    this.chargeAmount = 0;
    this.lastLipPrompt = -1;
    this.taughtFingers = false;
    this.started = false;
    this.running = false;
    this.lastTrick = { name: 'Ollie' };
    this.controls = { steer: 0, push: 1, brake: 0, charging: false };

    this.resetRun();
    this._frame = this._frame.bind(this);
  }

  // ------------------------------------------------------------ lifecycle ---

  begin() {
    if (this.started) return;
    this.started = true;
    // The run so far happened behind the title card. Start it properly.
    this.resetRun();
    this.audio.start();
    this.hud.setHint('H for controls');
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
    this.grabs.reset();
    this.mapper.reset();
    this.score.reset();
    this.meter.reset();
    this.time.reset();
    this.cameraRig.reset(this.skater);
    this.state = State.ROLL;
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

    if (this.started) {
      this.handleStateInput(rd);
      this.updateFingers(rd);
    }

    for (let i = 0; i < steps; i++) {
      this.board.snapshot();
      this.skater.snapshot();
      this.stepSim(Config.sim.fixedStep);
    }

    this.updatePresentation(rd);
    this.input.endFrame();
  }

  // ---------------------------------------------------------------- input ---

  handleGlobalKeys() {
    const i = this.input;
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
    // Any touch or key counts as the gesture that unlocks audio.
    if (!this.started && (i.touchCount > 0 || i.keysPressed.size > 0)) {
      this.hud.hideStart();
      this.begin();
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
      if (this.state === State.AIR && i.pressed('Space')) this.commitLanding();
    }
  }

  /** Sample the two fingers. Only meaningful once the board is free. */
  updateFingers(rd) {
    if (this.state !== State.AIR) {
      for (const f of this.fingers.fingers) f.active = false;
      return;
    }
    this.mapper.updateBasis(this.stage.camera, this.board.position, this.cameraRig.stanceQuat);
    this.mapper.update(rd);

    const before = this.fingers.totalFlicks;
    const caughtBefore = this.fingers.caught;
    const omegaBefore = this.board.angularVelocity.length();
    this.fingers.update(this.board, this.cameraRig.stanceQuat, rd, this.flightT);

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

    const wasGrabbing = this.grabs.isGrabbing;
    this.grabs.update(this.fingers, rd);
    if (this.grabs.isGrabbing && !wasGrabbing) {
      this.audio.grab();
      this.haptics.fire('grab');
    }

    // A grabbed board is held against the feet, so it stops drifting away.
    if (this.grabs.isGrabbing) {
      const hold = Math.max(0, 1 - Config.grabs.driftDamping * rd);
      this.board.velocity.x = MathUtils.lerp(this.skater.velocity.x, this.board.velocity.x, hold);
      this.board.velocity.z = MathUtils.lerp(this.skater.velocity.z, this.board.velocity.z, hold);
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
    this.grabs.reset();
    this.mapper.reset();
    this.mapper.homeKeyFingers();
    this.cameraRig.beginTrick(this.skater);

    this.totalAirTime = Math.max(0.25, estimateAirTime(this.skater));
    this.flightT = 0;
    this.state = State.AIR;
    this.rollTimer = 0;

    this.audio.pop(0.5 + charge * 0.6);
    this.haptics.fire('pop');
    this.cameraRig.addShake(0.1 + charge * 0.16);

    if (this.meter.canActivate) {
      this.enterNail();
      if (!this.taughtFingers) {
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

  /** Player chose to drop out of slow motion and take the landing. */
  commitLanding() {
    if (this.state !== State.AIR || !this.nailActive) return;
    this.exitNail();
    this.hud.showPrompt('COMMITTED', 0.7);
  }

  resolveLanding() {
    const s = this.skater;
    groundNormal(s.position.x, s.position.z, _n);
    s.travelDir(_travel);

    const landing = evaluateLanding(this.board, _n, _travel, s.position);
    const trick = recognise(this.board.spin);
    const grab = this.grabs.score();
    const bodyTurns = quantiseBodySpin(s.airYaw);
    const name = fullName(trick, grab.name, bodyTurns);
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

    const result = this.score.award(trick, landing, flight, hands, { grab, bodyTurns, name });

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
  }

  bail(trick, landing) {
    this.state = State.BAIL;
    this.bailTimer = 0;

    const s = this.skater;
    s.airborne = false;
    s.position.y = groundHeight(s.position.x, s.position.z);
    // Keep some of the momentum so the rider slides out rather than stopping dead.
    s.velocity.y = 0;
    s.velocity.multiplyScalar(0.55);
    s.speed = 0;

    // Throw the board clear.
    this.board.velocity.set(
      (Math.random() - 0.5) * 4,
      1.6 + Math.random() * 1.6,
      this.board.velocity.z * 0.5 + 1.5,
    );
    this.board.angularVelocity.set(
      (Math.random() - 0.5) * 9,
      (Math.random() - 0.5) * 9,
      (Math.random() - 0.5) * 14,
    );
    this.board.airborne = true;

    this.audio.bail();
    this.haptics.fire('bail');
    this.cameraRig.addShake(0.75);
    this.trickFX.burst(s.position, 1, 0xff8a5a);

    this.hud.showResult({
      trick: trick.name,
      quality: 'BAIL',
      points: 0,
      note: landing.reasons[0] || 'Lost it',
    });
  }

  bankLine() {
    const banked = this.score.bank();
    if (banked > 0) {
      this.audio.reward(Math.min(5, 1 + Math.floor(banked / 1500)));
      this.hud.showPrompt(`BANKED +${Math.round(banked).toLocaleString('en-US')}`, 1.5);
    }
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
      if (!this.meter.drain(rd)) {
        this.exitNail();
        this.hud.showPrompt('METER OUT', 0.9);
      } else {
        // Let time creep back up as the ground approaches, so the landing is
        // never a crawl even if the player never commits.
        const R = Config.nail;

        // Deepest slow motion only while a finger is on the job.
        const working = this.fingers.fingers.some((f) => f.active || f.contact > 0.05);
        let target = working ? R.timeScale : R.idleTimeScale;

        // And time winds back up over the last stretch regardless, so the
        // landing never crawls even if the player never commits.
        if (this.flightT > R.releaseFrom) {
          const t = MathUtils.clamp((this.flightT - R.releaseFrom) / (1 - R.releaseFrom), 0, 1);
          target = MathUtils.lerp(target, R.releaseTimeScale, t);
        }
        this.time.requestScale(target, R.idleRamp);
      }
    }

    if (this.state === State.BAIL) {
      this.bailTimer += rd;
      this.riderMesh.setBailPose(this.bailTimer);
      if (this.bailTimer > 1.7) this.recoverFromBail();
    }

    // --- Interpolated transforms ------------------------------------------
    this.boardMesh.position.lerpVectors(this.board.prevPosition, this.board.position, alpha);
    this.boardMesh.quaternion
      .copy(this.board.prevQuaternion)
      .slerp(this.board.quaternion, alpha);

    _v.lerpVectors(this.skater.prevPosition, this.skater.position, alpha);
    this.riderMesh.position.copy(_v);
    if (this.state !== State.BAIL) {
      groundNormal(_v.x, _v.z, _n);
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
      skater: this.skater,
      board: this.board,
      flightT: this.flightT,
    });
    // The rider ghosts out ahead of the camera arriving, so the deck is never
    // behind a thigh at the moment the player needs to read it.
    this.riderMesh.setFade(smoothstep(0.12, 0.55, this.cameraRig.trickBlend) * 0.94);
    this.stage.focusShadows(this.riderMesh.position);
    this.stage.setTrickLighting(this.cameraRig.trickBlend, this.board.position);
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
      board: this.board,
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
    _screen.copy(this.board.position).project(this.stage.camera);
    const focus =
      this.state === State.AIR
        ? { x: _screen.x * 0.5 + 0.5, y: _screen.y * 0.5 + 0.5 }
        : { x: 0.5, y: 0.5 };
    this.postFX.setLook(slowmo, focus, this.flash, this.time.realElapsed);

    // --- Audio -------------------------------------------------------------
    this.audio.updateRoll(this.skater.speed, this.state === State.ROLL, slowmo);
    this.audio.setSlowmo(slowmo);

    // --- HUD ---------------------------------------------------------------
    let liveTrick = this.lastTrick;
    if (this.state === State.AIR) {
      const t = recognise(this.board.spin);
      const held = this.grabs.isGrabbing ? this.grabs.liveName : null;
      liveTrick = { ...t, name: fullName(t, held, quantiseBodySpin(this.skater.airYaw)) };
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
      grab: this.state === State.AIR && this.grabs.isGrabbing ? this.grabs.liveName : null,
      grabHold: this.grabs.currentHold,
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
function estimateAirTime(skater) {
  const g = Config.sim.gravity;
  const p = skater.position;
  const v = skater.velocity;
  let t = 0;
  for (let i = 0; i < 200; i++) {
    t += 0.02;
    const y = p.y + v.y * t + 0.5 * g * t * t;
    if (y <= groundHeight(p.x + v.x * t, p.z + v.z * t)) return t;
    if (t > 4) break;
  }
  return 1;
}

function buildNote(result, landing) {
  const bits = [];
  if (result.grab && result.grabHold > 0.6) bits.push(`${result.grabHold.toFixed(1)}s grab`);
  if (result.repeated) bits.push('repeat — half score');
  if (result.lateCatch) bits.push('late catch');
  else if (result.caught) bits.push('caught');
  if (landing.fakie) bits.push('fakie');
  if (landing.reasons.length) bits.push(landing.reasons[0].toLowerCase());
  return bits.slice(0, 2).join(' · ');
}
