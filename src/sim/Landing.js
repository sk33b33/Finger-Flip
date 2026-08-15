import { Vector3 } from 'three';
import Config from '../core/Config.js';

/**
 * LandingDetector + BailController.
 *
 * Landing is graded, never automatic. Four independent checks each produce a
 * tier; the landing takes the WORST of them, so one badly wrong axis will sink
 * an otherwise tidy trick. Every check reports its own reason string, because
 * the brief is explicit that the player must understand why a trick failed.
 */

export const Quality = Object.freeze({
  PERFECT: 'PERFECT',
  CLEAN: 'CLEAN',
  ROUGH: 'ROUGH',
  SLAM: 'SLAM',
  BAIL: 'BAIL',
});

const ORDER = [Quality.PERFECT, Quality.CLEAN, Quality.ROUGH, Quality.SLAM, Quality.BAIL];
const RANK = new Map(ORDER.map((q, i) => [q, i]));

const _up = new Vector3();
const _nose = new Vector3();
const _flatNose = new Vector3();
const _flatTravel = new Vector3();
const _drift = new Vector3();

const DEG = 180 / Math.PI;

/**
 * @param {Board} board
 * @param {Vector3} surfaceNormal
 * @param {Vector3} travelDir horizontal direction the rider is moving
 * @param {Vector3} riderGroundPos where the rider's feet want the board to be
 * @returns {{quality:string, tilt:number, yawError:number, spin:number, drift:number,
 *            fakie:boolean, reasons:string[], score:number}}
 */
export function evaluateLanding(board, surfaceNormal, travelDir, riderGroundPos) {
  const L = Config.landing;
  const reasons = [];

  // --- 1. Board attitude against the surface -------------------------------
  board.up(_up);
  const tilt = Math.acos(clamp(_up.dot(surfaceNormal), -1, 1)) * DEG;
  let tiltTier;
  if (tilt > L.invertedBailDeg) {
    tiltTier = Quality.BAIL;
    reasons.push(tilt > 130 ? 'Landed upside down' : 'Board on its side');
  } else if (tilt <= L.perfectTiltDeg) tiltTier = Quality.PERFECT;
  else if (tilt <= L.cleanTiltDeg) tiltTier = Quality.CLEAN;
  else if (tilt <= L.roughTiltDeg) {
    tiltTier = Quality.ROUGH;
    reasons.push('Board not flat');
  } else {
    tiltTier = Quality.SLAM;
    reasons.push('Board way off flat');
  }

  // --- 2. Yaw alignment with travel ----------------------------------------
  board.nose(_nose);
  projectOntoPlane(_flatNose.copy(_nose), surfaceNormal).normalize();
  projectOntoPlane(_flatTravel.copy(travelDir), surfaceNormal).normalize();
  let yawError = Math.acos(clamp(_flatNose.dot(_flatTravel), -1, 1)) * DEG;
  // Rolling away fakie is a legal landing, so fold the error about 180 degrees.
  const fakie = yawError > 90;
  if (fakie) yawError = 180 - yawError;

  let yawTier;
  if (yawError <= L.perfectYawDeg) yawTier = Quality.PERFECT;
  else if (yawError <= L.cleanYawDeg) yawTier = Quality.CLEAN;
  else if (yawError <= L.roughYawDeg) {
    yawTier = Quality.ROUGH;
    reasons.push('Sideways landing');
  } else {
    yawTier = Quality.BAIL;
    reasons.push('Landed sideways');
  }

  // --- 3. Residual spin -----------------------------------------------------
  const spin = board.angularVelocity.length();
  let spinTier;
  if (spin <= L.perfectSpin) spinTier = Quality.PERFECT;
  else if (spin <= L.cleanSpin) spinTier = Quality.CLEAN;
  else if (spin <= L.roughSpin) {
    spinTier = Quality.ROUGH;
    reasons.push('Board still spinning');
  } else if (spin <= L.bailSpin) {
    spinTier = Quality.SLAM;
    reasons.push('Never caught the board');
  } else {
    spinTier = Quality.BAIL;
    reasons.push('Never caught the board');
  }

  // --- 4. Board still under the rider ---------------------------------------
  _drift.copy(board.position).sub(riderGroundPos);
  _drift.y = 0;
  const drift = _drift.length();
  let driftTier;
  if (drift <= L.perfectDrift) driftTier = Quality.PERFECT;
  else if (drift <= L.cleanDrift) driftTier = Quality.CLEAN;
  else if (drift <= L.roughDrift) {
    driftTier = Quality.ROUGH;
    reasons.push('Off-centre');
  } else if (drift <= L.bailDrift) {
    driftTier = Quality.SLAM;
    reasons.push('Feet missed the board');
  } else {
    driftTier = Quality.BAIL;
    reasons.push('Board shot out');
  }

  const quality = worst(tiltTier, yawTier, spinTier, driftTier);

  // Continuous 0..1 quality, used for the score multiplier ramp and for VFX
  // intensity, so the reward curve is not a staircase.
  const score = clamp01(
    1 -
      0.34 * norm(tilt, L.perfectTiltDeg, L.roughTiltDeg) -
      0.26 * norm(yawError, L.perfectYawDeg, L.roughYawDeg) -
      0.26 * norm(spin, L.perfectSpin, L.roughSpin) -
      0.14 * norm(drift, L.perfectDrift, L.roughDrift),
  );

  return { quality, tilt, yawError, spin, drift, fakie, reasons, score };
}

/**
 * Live landing preview used by the HUD while the trick is still in the air, so
 * the player can see whether the board is currently in a landable attitude.
 * Same maths, no drift term (the rider has not committed yet).
 */
export function previewLanding(board, surfaceNormal, travelDir) {
  const L = Config.landing;
  board.up(_up);
  const tilt = Math.acos(clamp(_up.dot(surfaceNormal), -1, 1)) * DEG;
  board.nose(_nose);
  projectOntoPlane(_flatNose.copy(_nose), surfaceNormal).normalize();
  projectOntoPlane(_flatTravel.copy(travelDir), surfaceNormal).normalize();
  let yawError = Math.acos(clamp(_flatNose.dot(_flatTravel), -1, 1)) * DEG;
  if (yawError > 90) yawError = 180 - yawError;
  const spin = board.angularVelocity.length();

  return clamp01(
    1 -
      0.44 * norm(tilt, L.perfectTiltDeg, L.roughTiltDeg) -
      0.28 * norm(yawError, L.perfectYawDeg, L.roughYawDeg) -
      0.28 * norm(spin, L.perfectSpin, L.roughSpin),
  );
}

function worst(...tiers) {
  let w = tiers[0];
  for (const t of tiers) if (RANK.get(t) > RANK.get(w)) w = t;
  return w;
}

function norm(v, good, bad) {
  if (v <= good) return 0;
  return clamp01((v - good) / (bad - good));
}

function projectOntoPlane(v, n) {
  return v.addScaledVector(n, -v.dot(n));
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
