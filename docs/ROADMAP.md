# Stargazer — Product Roadmap

Phased delivery plan for building, verifying, and deploying the Stargazer browser-based GPU sky observation application.

---

## Phase 1: Core GPU Engine, Geolocation & Spectral Starfield (MVP)
- **Project Scaffold**: Vite + TypeScript + Three.js (`WebGPURenderer` with automatic `WebGL2` fallback) + responsive glassmorphic HUD layout.
- **Observer Location Service**: Auto-detect GPS coordinates via `navigator.geolocation` with graceful fallback to a searchable city/coordinate picker and local storage persistence.
- **Star Catalog & Constellation Pipeline**: Build binary star catalog packer (`stars.bin`) + IAU 88 constellation stick figures, boundaries, and names; implement J2000 Equatorial-to-Horizontal matrix math and the custom Spectral Star Shader ($B-V$ color temperature, magnitude PSF, atmospheric twinkling).
- **Physical Atmosphere & Compass Horizon**: Implement Rayleigh/Mie sky dome driven by solar altitude and 3D cardinal horizon ring with smooth mouse/touch pan and FOV zoom (`10°` telephoto to `120°` wide-angle).

## Phase 2: Solar System, Deep Sky Objects & Time Machine
- **Solar System Ephemeris**: Integrate `astronomy-engine` for live topocentric positions of the Sun, Moon, and Mercury–Neptune.
- **3D Lunar Phase Shader**: Render the Moon with accurate terminator lighting and orientation based on the live Sun–Moon–Observer phase angle.
- **Deep Sky Objects (DSOs)**: Add the Messier & Caldwell catalog layer (219 galaxies, nebulae, and star clusters) with morphological icons and zoom-based label reveal.
- **Time Machine Bar**: Play/Pause toggle, scrubbing slider, variable time-warp multiplier ($\pm 1\times$, $60\times$, $300\times$, $3600\times$), "Now" reset button, and date/time picker.

## Phase 3: Object Inspection HUD, Search & "Tonight's Best" Guided Tour
- **Click-to-Inspect Raycaster**: Screen-space spatial lookup for stars, planets, and DSOs; displays a live telemetry card (`Alt/Az`, `RA/Dec`, visual magnitude, distance in light-years/AU, spectral type, and today's Rise / Transit / Set times).
- **Instant Search & Camera Fly-To**: `Cmd/Ctrl+K` search across stars, constellations, planets, and Messier/Caldwell objects with smooth quaternion slerp camera tracking.
- **"Tonight's Best" Sky Tour**: Dynamic planner ranking visible planets, bright stars, and high-altitude DSOs for the user's exact location and evening window, supporting one-click guided stepping.

## Phase 4: Live Satellites (ISS) & Mobile AR Gyroscope Mode
- **Satellite & ISS Tracker**: Fetch live CelesTrak visual/station TLEs, run SGP4 orbital propagation (`satellite.js`) in a background Web Worker, render real-time orbital trajectory arcs across the sky dome, and display upcoming local ISS passes.
- **Mobile AR / Gyroscope Sensor Fusion**: Connect `DeviceOrientationEvent` (with iOS permission handshake and compass heading alignment) so users on mobile devices can point their device at the sky for live augmented-reality observation.

## Phase 5: Azure Cloud Provisioning & Automated CI/CD
- **Azure Infrastructure**: Provision an isolated Azure resource group and Azure Static Web App (`Free` SKU) using local CLI/environment configuration without committing subscription IDs, resource group names, or account identifiers to the public repository.
- **CI/CD & Production Release**: Configure GitHub Actions deployment workflow (referencing GitHub repository secrets only) with immutable cache headers for binary catalog assets, and verify live HTTPS geolocation & WebGPU/WebGL2 rendering on the deployed endpoint.

## Phase 6: Live ADS-B Aircraft Sky Tracker & Flight Radar
- **Open ADS-B Proxy (`/api/aircraft`)**: Zero-dependency managed API function (`api/aircraft`) and Vite dev/preview middleware normalizing live local traffic across `opendata.adsb.fi`, `api.adsb.lol`, and `opensky-network.org` with regional corridor fallback.
- **Topocentric Look Angles & 60 FPS Dead-Reckoning**: WGS-84 geodetic-to-horizon look-angle solver (`geodeticToEcf` + `ecfToLookAngles`), smooth dead-reckoned interpolation between polls, contrails, and `-60s` to `+90s` sky trajectory arcs.
- **WebGPU/WebGL2 Swept-Wing Aircraft Shader & Radar HUD**: Velocity-oriented instanced aircraft glyphs with navigation/anti-collision strobes, `✈ Flights` drawer, `Cmd/Ctrl+K` aircraft search, and aviation telemetry inspection.
