# Stargazer

Browser-based, GPU-accelerated sky observation platform anchored to your live geographic location and time.

## Live Demo

- **Public URL:** https://thankful-rock-09d5e330f.3.azurestaticapps.net

> Hosted over HTTPS (Secure Context enabled for live Geolocation, WebGPU, and Mobile AR orientation sensors).

## Features

- **GPU Spectral Starfield (`WebGPURenderer` + `WebGL2` Fallback):** Renders 41,411 stars (`Vmag <= 8.0`) in a single draw call with Ballesteros $B-V$ blackbody color temperatures, magnitude PSF halos, Kasten-Young atmospheric extinction, and horizon scintillation.
- **Physical Sky Dome & 88 IAU Constellations:** Real-time Rayleigh/Mie sky scattering driven by solar altitude, 360° cardinal compass horizon ring, and smooth zoom (`10°` telephoto to `120°` wide-angle) with constellation stick figures, boundaries, and names.
- **Solar System Ephemeris & 3D Lunar Phase Shader:** Live topocentric positions (`astronomy-engine`) for the Sun, Moon, and Mercury–Neptune, plus a physically oriented 3D lunar terminator shader and interactive Time Machine controls (`Play/Pause`, time scrubber, and time-warp multipliers).
- **Deep Sky Objects, Search & "Tonight's Best" Tour:** Complete 219-object Messier (`M1–M110`) and Caldwell (`C1–C109`) catalog, `Cmd/Ctrl+K` instant search with smooth slerp camera fly-to, live telemetry inspector (`Alt/Az`, `RA/Dec`, Rise/Transit/Set), and an evening-aware guided tour.
- **Live Satellite & ISS Tracker + Mobile AR Mode:** Background Web Worker SGP4 propagation (`satellite.js`) with live CelesTrak TLE updates, sky trajectory arcs, local pass predictions, and `DeviceOrientationEvent` gyroscope fusion for mobile sky pointing.
- **Live ADS-B Aircraft Sky Radar (`✈ Flights`):** Real-time local airspace tracker powered by open ADS-B data (`adsb.fi`, `adsb.lol`, `opensky-network.org`) via `/api/aircraft` with 60 FPS dead-reckoning interpolation, velocity-oriented swept-wing aircraft & contrail GPU shaders, flight search (`Cmd/Ctrl+K`), and click-to-inspect aviation telemetry.

## Local Development

```bash
npm install
npm run dev
```

### Verification & Production Build

```bash
npm test
npm run build
```

## Documentation

- [System & Shader Architecture](docs/ARCHITECTURE.md)
- [Product Roadmap](docs/ROADMAP.md)
