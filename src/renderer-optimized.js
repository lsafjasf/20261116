// Optimized render path (driver-safe, no instanced attributes):
//  - geometry for each unique cache key is uploaded to the GPU exactly once
//    and shared by every node using that shape;
//  - per-node state is written into one reusable uniform-buffer record
//    (pos/scale/layer/select), so the only per-node GPU cost is 32 bytes;
//  - each visible node is a drawElements against the shared VAO.
// The vertex transform is the same float32 mul/add the baseline uses, so the
// generated pixels are byte-identical; only resource organization changes.

import { uploadTextureArray } from "./textures.js";
import { createSharedProgram } from "./shaders.js";
import { uploadMesh, bindMeshAttributes } from "./gl-mesh.js";
import { mat4Multiply } from "./math.js";

export class OptimizedRenderer {
  constructor(gl, cache, scene) {
    this.mode = "optimized";
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

    // One shared GPU mesh per geometry cache key.
    this.groups = new Map();
    for (const node of this.scene.nodes) {
      const cached = this.cache.get(node.geoKey, node.tessellation);
      let group = this.groups.get(cached.key);
      if (!group) {
        const mesh = uploadMesh(gl, cached.geometry);
        const vao = gl.createVertexArray();
        bindMeshAttributes(gl, vao, mesh);
        gl.bindVertexArray(null);
        group = { key: cached.key, nodes: [], mesh, vao };
        this.groups.set(cached.key, group);
      }
      group.nodes.push(node);
    }

    // Single reusable UBO for the active node (std140: two vec4 = 32 bytes).
    this.ubo = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
    gl.bufferData(gl.UNIFORM_BUFFER, 32, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.ubo);

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

    // Global node order keeps overlapping-fragment resolution deterministic;
    // depth testing makes the result independent of geometry grouping.
    for (const node of visibleNodes) {
      const cached = this.cache.get(node.geoKey, node.tessellation);
      const group = this.groups.get(cached.key);

      const r = this._record;
      r[0] = node.position[0];
      r[1] = node.position[1];
      r[2] = node.position[2];
      r[3] = 0;
      r[4] = node.scale;
      r[5] = node.layer;
      r[6] = node.id === selectedId ? 1 : 0;
      r[7] = 0;
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, r);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.ubo);

      gl.bindVertexArray(group.vao);
      gl.drawElements(gl.TRIANGLES, group.mesh.indexCount, group.mesh.indexType, 0);
      this.drawCalls++;
    }
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteBuffer(this.ubo);
    for (const group of this.groups.values()) {
      gl.deleteVertexArray(group.vao);
      gl.deleteBuffer(group.mesh.vbo);
      gl.deleteBuffer(group.mesh.uvbo);
      gl.deleteBuffer(group.mesh.ibo);
    }
    gl.deleteTexture(this.texture);
    gl.deleteProgram(this.program);
    this.groups.clear();
  }
}
