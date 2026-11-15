/* Chunked import pipeline shared by the Web Worker and Node tests.
 * Reads a byte source in slices, feeds the streaming parser, hashes
 * incrementally, reports progress, and honours cancellation between
 * chunks so the UI thread stays responsive. */
(function (global) {
  "use strict";

  var CHUNK_SIZE = 1 << 20; // 1 MiB
  var PREVIEW_LIMIT = 200;

  /* source: { size:Number, read(start, end) -> Promise<Uint8Array> }
   * hooks: { onProgress({parsed, bytesRead, totalBytes}) }
   * shouldCancel: () -> Boolean
   * Resolves {status:'done', count, hash, durationMs, preview}
   * or {status:'cancelled', parsed}. Throws KfParseError on bad data. */
  function runImport(source, hooks, shouldCancel) {
    hooks = hooks || {};
    shouldCancel = shouldCancel || function () { return false; };
    var sha = new global.KfSha256.Sha256();
    var decoder = new TextDecoder("utf-8");
    var count = 0;
    var preview = [];
    var parser = new global.KfParser.StreamParser({
      onObject: function (obj, index) {
        count = index + 1;
        if (preview.length < PREVIEW_LIMIT) preview.push(obj);
      }
    });
    var startedAt = Date.now();
    var offset = 0;
    var lastReport = 0;

    function report(force) {
      var now = Date.now();
      if (!force && now - lastReport < 80) return;
      lastReport = now;
      if (hooks.onProgress) {
        hooks.onProgress({ parsed: count, bytesRead: offset, totalBytes: source.size });
      }
    }

    function loop() {
      if (shouldCancel()) {
        return { status: "cancelled", parsed: count };
      }
      if (offset >= source.size) {
        parser.end();
        report(true);
        return {
          status: "done",
          count: count,
          hash: sha.digestHex(),
          durationMs: Date.now() - startedAt,
          preview: preview
        };
      }
      var end = Math.min(offset + CHUNK_SIZE, source.size);
      return Promise.resolve(source.read(offset, end)).then(function (bytes) {
        sha.update(bytes);
        parser.push(decoder.decode(bytes, { stream: end < source.size }));
        offset = end;
        report(false);
        return loop();
      });
    }

    return Promise.resolve().then(loop);
  }

  var api = { runImport: runImport, CHUNK_SIZE: CHUNK_SIZE, PREVIEW_LIMIT: PREVIEW_LIMIT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.KfImportCore = api;
})(typeof self !== "undefined" ? self : globalThis);
