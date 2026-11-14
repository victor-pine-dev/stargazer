import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  clamp,
  dot,
  exp,
  float,
  Fn,
  max,
  mix,
  normalize,
  positionLocal,
  pow,
  smoothstep,
  uniform,
  varying,
  vec3,
} from 'three/tsl';

const SKY_DOME_RADIUS = 520;

export interface AtmosphereDomeLayer {
  mesh: THREE.Mesh;
  update: (sunWorldDir: [number, number, number], sunAltDeg: number, visibleAtmosphere: boolean) => void;
  dispose: () => void;
}

/**
 * Creates the physical Rayleigh + Mie atmospheric scattering sky dome driven by solar altitude.
 */
export function createAtmosphereDome(): AtmosphereDomeLayer {
  const geometry = new THREE.SphereGeometry(SKY_DOME_RADIUS, 64, 48);

  const uSunDir = uniform(new THREE.Vector3(0, -1, 0));
  const uSunAltDeg = uniform(-30);
  const uShowAtmosphere = uniform(1.0);

  const vRayDir = varying(normalize(positionLocal), 'vAtmoRayDir');

  const skyColorNode = Fn(() => {
    const rayDir = normalize(vRayDir);
    const sunDir = normalize(uSunDir);

    const elev = rayDir.y;
    const sunElev = uSunAltDeg;

    // Twilight / Day / Night state weights
    const dayWeight = smoothstep(float(-3.5), float(14.0), sunElev);
    const twilightPeak = smoothstep(float(-18.0), float(-1.0), sunElev).mul(
      float(1.0).sub(smoothstep(float(1.0), float(15.0), sunElev)),
    );
    const nightWeight = float(1.0).sub(smoothstep(float(-18.0), float(-3.5), sunElev));

    // Optical airmass approximation toward the horizon
    const zenith = max(elev, float(0.008));
    const horizonProximity = pow(float(1.0).sub(clamp(elev, float(0.0), float(1.0))), float(3.2));
    const opticalDepth = float(1.0).div(zenith.add(float(0.14)));

    // Rayleigh & Mie scattering geometry relative to the Sun
    const cosTheta = dot(rayDir, sunDir);
    const rayleighPhase = float(0.75).mul(float(1.0).add(cosTheta.mul(cosTheta)));

    // Henyey-Greenstein forward scattering (g = 0.76) for Mie solar aureole
    const g = float(0.76);
    const g2 = g.mul(g);
    const hgDenom = pow(
      max(float(1.0).add(g2).sub(float(2.0).mul(g).mul(cosTheta)), float(0.02)),
      float(1.5),
    );
    const miePhase = float(0.045).mul(float(1.0).sub(g2)).div(hgDenom);

    // 1. Daytime sky gradient (Rayleigh azure zenith -> pale cyan horizon + solar aureole)
    const dayZenith = vec3(0.06, 0.22, 0.62);
    const dayHorizon = vec3(0.42, 0.64, 0.88);
    const dayScatter = mix(dayZenith, dayHorizon, horizonProximity).mul(
      float(0.88).add(rayleighPhase.mul(0.14)),
    );
    const daySunDisk = vec3(1.0, 0.95, 0.85).mul(
      smoothstep(float(0.9982), float(0.9997), cosTheta).mul(1.8),
    );
    const dayColor = dayScatter.add(vec3(0.95, 0.86, 0.72).mul(miePhase).mul(0.35)).add(daySunDisk);

    // 2. Twilight / Sunset / Sunrise scattering (amber-crimson solar horizon + Belt of Venus)
    const twiZenith = vec3(0.015, 0.032, 0.11);
    const twiAntiSolar = vec3(0.16, 0.09, 0.18);
    const twiSolarHorizon = vec3(0.92, 0.34, 0.09);
    const towardSun = smoothstep(float(-0.4), float(0.92), cosTheta);
    const twiHorizonBand = mix(twiAntiSolar, twiSolarHorizon, towardSun);
    const twiColor = mix(twiZenith, twiHorizonBand, pow(horizonProximity, float(0.75)))
      .add(vec3(1.0, 0.45, 0.16).mul(miePhase).mul(0.55).mul(horizonProximity.add(0.25)));

    // 3. Astronomical Night sky (deep obsidian-cobalt zenith + faint horizon airglow)
    const nightZenith = vec3(0.0025, 0.0045, 0.013);
    const nightHorizon = vec3(0.012, 0.021, 0.042);
    const nightColor = mix(nightZenith, nightHorizon, pow(horizonProximity, float(1.1)))
      .add(vec3(0.006, 0.01, 0.02).mul(exp(opticalDepth.mul(-0.18))));

    const skyAbove = dayColor.mul(dayWeight).add(twiColor.mul(twilightPeak)).add(nightColor.mul(nightWeight));

    // Vacuum / atmosphere-off dark space mode
    const spaceColor = mix(vec3(0.0018, 0.003, 0.009), vec3(0.006, 0.01, 0.022), horizonProximity);
    const activeSkyAbove = mix(spaceColor, skyAbove, uShowAtmosphere);

    // Ground below the horizon (smooth atmospheric horizon transition)
    const groundNight = vec3(0.005, 0.007, 0.013);
    const groundDay = vec3(0.035, 0.045, 0.062);
    const groundColor = mix(groundNight, groundDay, dayWeight.add(twilightPeak.mul(0.35)).mul(uShowAtmosphere));
    const groundFade = float(1.0).sub(smoothstep(float(-0.025), float(0.018), elev));

    const horizonGlow = mix(
      vec3(0.03, 0.05, 0.09),
      twiSolarHorizon.mul(0.35).add(dayHorizon.mul(0.25)),
      dayWeight.add(twilightPeak).mul(uShowAtmosphere),
    ).mul(exp(elev.abs().mul(-32.0)));

    return mix(activeSkyAbove, groundColor, groundFade).add(horizonGlow);
  })();

  const material = new MeshBasicNodeMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  material.colorNode = skyColorNode;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'AtmosphereDome';
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;

  return {
    mesh,
    update(sunWorldDir, sunAltDeg, visibleAtmosphere) {
      uSunDir.value.set(sunWorldDir[0], sunWorldDir[1], sunWorldDir[2]).normalize();
      uSunAltDeg.value = sunAltDeg;
      uShowAtmosphere.value = visibleAtmosphere ? 1.0 : 0.0;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
