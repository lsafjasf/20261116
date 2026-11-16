// Shared fragment shader for every render path: identical texture sampling and
// selection tint, so all paths produce the same color for the same inputs.

export const FRAGMENT_SRC = `#version 300 es
precision highp float;

uniform highp sampler2DArray uTexArray;

in vec2 vUV;
flat in int vLayer;
in float vSelected;

out vec4 outColor;

void main() {
  vec4 base = texture(uTexArray, vec3(vUV, float(vLayer)));
  vec3 color = mix(base.rgb, vec3(1.0, 1.0, 1.0), vSelected * 0.55);
  outColor = vec4(color, 1.0);
  // Depth cue identical for both paths; no alpha blending involved.
}
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

// Shared-geometry shader for the optimized path. Geometry is uploaded once
// per cache key; per-node transform arrives through a uniform block, so the
// only per-node GPU data is a few floats. The transform expression matches
// the baseline's CPU pre-transform (float32 mul/add) for identical pixels.
const SHARED_VERTEX_SRC = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec2 aUV;

layout(std140) uniform NodeBlock {
  vec4 uNodePos;
  vec4 uNodeParams;
} uNode;

uniform mat4 uViewProj;

out vec2 vUV;
flat out int vLayer;
out float vSelected;

void main() {
  float scale = uNode.uNodeParams.x;
  vec3 world = aPosition * scale + uNode.uNodePos.xyz;
  gl_Position = uViewProj * vec4(world, 1.0);
  vUV = aUV;
  vLayer = int(uNode.uNodeParams.y + 0.5);
  vSelected = uNode.uNodeParams.z;
}
`;

const SHARED_FRAGMENT_SRC = FRAGMENT_SRC;

export function createSharedProgram(gl) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, SHARED_VERTEX_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, SHARED_FRAGMENT_SRC);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`shared program link failed: ${log}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}
