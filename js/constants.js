// Global tuning constants for the two-player camera rig.
// All distances are in metres, angles in radians, exposure in EV stops.

export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;

export const FILM_START = 6;          // rolls loaded at boot
export const DURABILITY_START = 100;  // rig health percent
export const DURABILITY_BAD_SHOT = 4; // wear per rejected capture
export const DURABILITY_GOOD_SHOT = 1;

// Left player: gimbal.
export const PAN_SPEED = 1.6;         // rad/s under full input
export const TILT_SPEED = 1.1;
export const PAN_LIMIT = 1.25;
export const TILT_LIMIT = 0.85;

// Right player: focus / aperture / shutter.
export const FOCUS_MIN = 2;
export const FOCUS_MAX = 60;
export const FOCUS_SPEED = 18;        // metres per second
export const APERTURE_STOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16];
export const SHUTTER_STOPS = [1 / 4000, 1 / 2000, 1 / 1000, 1 / 500, 1 / 250,
  1 / 125, 1 / 60, 1 / 30, 1 / 15, 1 / 8, 1 / 4, 1 / 2, 1];
export const FOCAL_MIN = 18;          // mm
export const FOCAL_MAX = 200;
export const ZOOM_SPEED = 55;         // mm per second

// Photo judgement gates.
export const COMPOSE_EDGE = 0.78;     // target centre must stay inside this fraction of half-frame
export const COMPOSE_SIZE_MIN = 0.08; // target angular height as frame fraction
export const COMPOSE_SIZE_MAX = 0.72;
export const FOCUS_TOLERANCE = 0.18;  // |d - s| / s must be below this
export const EXPOSURE_LO = -0.7;      // EV band around the metered value
export const EXPOSURE_HI = 0.7;
export const BLUR_LIMIT = 0.022;      // smear as frame-height fraction

// Frame geometry (logical canvas units).
export const FRAME_W = 720;
export const FRAME_H = 480;

// Fixed seed keeps every run deterministic.
export const RUN_LENGTH_TICKS = 30 * TICK_HZ;
