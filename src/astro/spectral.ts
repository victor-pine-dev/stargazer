/**
 * Spectral color temperature, visual magnitude flux scaling, and atmospheric airmass math.
 */

/**
 * Maps a star's B-V color index to effective blackbody temperature (Kelvin)
 * using Ballesteros' formula:
 * T_eff = 4600 * (1 / (0.92*(B-V) + 1.7) + 1 / (0.92*(B-V) + 0.62))
 */
export function bvToKelvin(bv: number): number {
  const clampedBv = Math.max(-0.4, Math.min(2.2, Number.isFinite(bv) ? bv : 0.65));
  return 4600 * (1 / (0.92 * clampedBv + 1.7) + 1 / (0.92 * clampedBv + 0.62));
}

/**
 * Approximates Planckian blackbody sRGB-compatible linear RGB [0..1] from Kelvin temperature
 * (Tanner Helland / CIE Planckian locus approximation tuned for luminous star points).
 */
export function kelvinToLinearRGB(tempK: number): [number, number, number] {
  const t = Math.max(1500, Math.min(35000, tempK)) / 100;

  let r: number;
  if (t <= 66) {
    r = 1;
  } else {
    r = 1.29293618606 * Math.pow(t - 60, -0.1332047592);
    r = Math.max(0, Math.min(1, r));
  }

  let g: number;
  if (t <= 66) {
    g = 0.390081578769 * Math.log(t) - 0.631841443788;
  } else {
    g = 1.1298908609 * Math.pow(t - 60, -0.0755148492);
  }
  g = Math.max(0, Math.min(1, g));

  let b: number;
  if (t >= 66) {
    b = 1;
  } else if (t <= 19) {
    b = 0;
  } else {
    b = 0.54320678911 * Math.log(t - 10) - 1.19625408914;
    b = Math.max(0, Math.min(1, b));
  }

  // Convert approximate perceptual sRGB curve to linear RGB for GPU shader blending
  const toLinear = (c: number) => Math.pow(c, 2.2);
  return [toLinear(r), toLinear(g), toLinear(b)];
}

/**
 * Convenience wrapper mapping B-V color index directly to linear RGB.
 */
export function bvToRGB(bv: number): [number, number, number] {
  return kelvinToLinearRGB(bvToKelvin(bv));
}

/**
 * Computes relative optical flux from Pogson's magnitude scale: F = 10^(-0.4 * (m - m0)).
 */
export function magnitudeToFlux(mag: number, refMag = 0): number {
  return Math.pow(10, -0.4 * (mag - refMag));
}

/**
 * Kasten-Young (1989) atmospheric airmass approximation from apparent altitude in degrees.
 * Returns ~1.0 at Zenith and increases rapidly toward ~38 at the horizon.
 */
export function computeAirmass(altDeg: number): number {
  if (altDeg <= -2) return 40;
  const clampedAlt = Math.max(0, Math.min(90, altDeg));
  const altRad = (clampedAlt * Math.PI) / 180;
  return 1 / (Math.sin(altRad) + 0.50572 * Math.pow(clampedAlt + 6.07995, -1.6364));
}
