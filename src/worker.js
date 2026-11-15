/* Web Worker wrapper around import_core. Messages:
 *   in:  {type:'start', file:File} | {type:'cancel'}
 *   out: {type:'progress'|'done'|'cancelled'|'error', ...} */
importScripts("sha256.js", "stream_parser.js", "import_core.js");

var cancelRequested = false;
var running = false;

self.onmessage = function (event) {
  var msg = event.data;
  if (msg.type === "cancel") {
    cancelRequested = true;
    return;
  }
  if (msg.type !== "start" || running) return;
  running = true;
  cancelRequested = false;
  var file = msg.file;
  var source = {
    size: file.size,
    read: function (start, end) {
      return file.slice(start, end).arrayBuffer().then(function (buf) {
        return new Uint8Array(buf);
      });
    }
  };
  self.KfImportCore.runImport(source, {
    onProgress: function (p) {
      self.postMessage({
        type: "progress",
        parsed: p.parsed,
        bytesRead: p.bytesRead,
        totalBytes: p.totalBytes
      });
    }
  }, function () { return cancelRequested; }).then(function (result) {
    running = false;
    if (result.status === "cancelled") {
      self.postMessage({ type: "cancelled", parsed: result.parsed });
    } else {
      self.postMessage({
        type: "done",
        count: result.count,
        hash: result.hash,
        durationMs: result.durationMs,
        preview: result.preview
      });
    }
  }).catch(function (err) {
    running = false;
    self.postMessage({
      type: "error",
      error: {
        message: err.message || String(err),
        objectIndex: err.objectIndex != null ? err.objectIndex : null,
        path: err.path != null ? err.path : null,
        offset: err.offset != null ? err.offset : null,
        snippet: err.snippet != null ? err.snippet : null
      }
    });
  });
};
