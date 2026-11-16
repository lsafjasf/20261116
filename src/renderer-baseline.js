// Baseline render path. It runs the exact same shared-geometry shader math as
// the optimized path, but deliberately does everything the wasteful way:
//  - every node re-uploads its own copy of the geometry to the GPU (no sharing);
//  - every node owns a separate VAO and a separate uniform buffer object;
//  - selection rewrites each node's UBO individually every frame.
// Visible output is therefore identical, while memory and state changes are high.

import { uploadTextureArray } from "./textures.js";
import { createSharedProgram } from "./shaders.js";
import { uploadMesh, bindMeshAttributes } from "./gl-mesh.js";
import { mat4Multiply } from "./math.js";

export class BaselineRenderer {
  constructor(gl, cache, scene) {
    this.mode = "baseline";
    this.gl = gl;
    this.cache = cache;
    this.scene = scene;
    this.drawCalls = 0;
  }

  build() {
    const gl = this.gl;
    this.program = createSharedProgram(gl);
    this.locViewProj = gl.getUniformLocation(this.program, "uViewProj");
    this.locTex = gl.getUniformLocation(this.program, "uTexArray");
    this.blockIndex = gl.getUniformBlockIndex(this.program, "NodeBlock");
    gl.uniformBlockBinding(this.program, this.blockIndex, 0);
    this.texture = uploadTextureArray(gl);

    this.nodeGL = this.scene.nodes.map((node) => {
      const cached = this.cache.get(node.geoKey, node.tessellation);
      // Deliberate duplication: a fresh GPU mesh per node, never shared.
      const mesh = uploadMesh(gl, cached.geometry);
      const vao = gl.createVertexArray();
      bindMeshAttributes(gl, vao, mesh);
      gl.bindVertexArray(null);

      const ubo = gl.createBuffer();
      gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
      gl.bufferData(gl.UNIFORM_BUFFER, 32, gl.DYNAMIC_DRAW);

      return { node, vao, mesh, ubo };
    });

    this._record = new Float32Array(8);
    this._vp = new Float32Array(16);
  }

  render(visibleNodes, camera, selectedId) {
    const gl = this.gl;
    this.drawCalls = 0;
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.uniform1i(this.locTex, 0);
    mat4Multiply(this._vp, camera.proj, camera.view);
    gl.uniformMatrix4fv(this.locViewProj, false, this._vp);

    for (const node of visibleNodes) {
      const entry = this.nodeGL[node.id];
      const r = this._record;
      r[0] = node.position[0];
      r[1] = node.position[1];
      r[2] = node.position[2];
      r[3] = 0;
      r[4] = node.scale;
      r[5] = node.layer;
      r[6] = node.id === selectedId ? 1 : 0;
      r[7] = 0;
      gl.bindBuffer(gl.UNIFORM_BUFFER, entry.ubo);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, r);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, entry.ubo);

      gl.bindVertexArray(entry.vao);
      gl.drawElements(gl.TRIANGLES, entry.mesh.indexCount, entry.mesh.indexType, 0);
      this.drawCalls++;
    }
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    for (const entry of this.nodeGL) {
      gl.deleteVertexArray(entry.vao);
      gl.deleteBuffer(entry.ubo);
      gl.deleteBuffer(entry.mesh.vbo);
      gl.deleteBuffer(entry.mesh.uvbo);
      gl.deleteBuffer(entry.mesh.ibo);
    }
    gl.deleteTexture(this.texture);
    gl.deleteProgram(this.program);
    this.nodeGL = [];
  }
}
