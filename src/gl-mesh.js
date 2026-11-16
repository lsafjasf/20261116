// GPU mesh helpers shared by both render paths.

export function uploadMesh(gl, geometry) {
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.positions, gl.STATIC_DRAW);

  const uvbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvbo);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.uvs, gl.STATIC_DRAW);

  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);

  return {
    vbo, uvbo, ibo,
    indexCount: geometry.indices.length,
    indexType: gl.UNSIGNED_SHORT,
  };
}

export function deleteMesh(gl, mesh) {
  gl.deleteBuffer(mesh.vbo);
  gl.deleteBuffer(mesh.uvbo);
  gl.deleteBuffer(mesh.ibo);
}

export function bindMeshAttributes(gl, vao, mesh) {
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvbo);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
  gl.bindVertexArray(null);
}

export function makeVAO(gl) {
  return gl.createVertexArray();
}
