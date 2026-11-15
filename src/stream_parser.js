/* Incremental JSON parser for a top-level array of keyframe objects.
 * Emits one object at a time (low memory), reports errors located to
 * object index and field path. Runs in workers, browsers and Node. */
(function (global) {
  "use strict";

  function KfParseError(message, details) {
    var e = new Error(message);
    e.name = "KfParseError";
    e.objectIndex = details && details.objectIndex != null ? details.objectIndex : null;
    e.path = details && details.path != null ? details.path : null;
    e.offset = details && details.offset != null ? details.offset : null;
    e.snippet = details && details.snippet != null ? details.snippet : null;
    return e;
  }

  var WS = { " ": 1, "\t": 1, "\n": 1, "\r": 1 };

  /* Walks a JSON text and returns the key path of the innermost value
   * whose start position is <= pos. Path segments: strings for object
   * keys, numbers for array indices. */
  function pathAt(text, pos) {
    var stack = [];
    var lastPath = [];
    var i = 0;
    var n = text.length;
    function snapshot() {
      var p = [];
      for (var s = 0; s < stack.length; s++) {
        var f = stack[s];
        if (f.type === "object") p.push(f.key);
        else p.push(f.index);
      }
      return p;
    }
    function skipWs() { while (i < n && WS[text[i]]) i++; }
    function readString() {
      i++; // opening quote
      var out = "";
      while (i < n) {
        var c = text[i];
        if (c === "\\") { out += text[i + 1] || ""; i += 2; continue; }
        if (c === '"') { i++; return out; }
        out += c; i++;
      }
      return out;
    }
    function readValue() {
      skipWs();
      if (i >= n) return;
      if (i <= pos) lastPath = snapshot();
      var c = text[i];
      if (c === "{") {
        stack.push({ type: "object", key: null });
        i++;
        skipWs();
        if (text[i] === "}") { i++; stack.pop(); return; }
        for (;;) {
          skipWs();
          if (text[i] === '"') {
            stack[stack.length - 1].key = readString();
          } else { i++; }
          skipWs();
          if (text[i] === ":") i++;
          readValue();
          skipWs();
          if (text[i] === ",") { i++; continue; }
          if (text[i] === "}") { i++; break; }
          break; // malformed: stop descending
        }
        stack.pop();
      } else if (c === "[") {
        stack.push({ type: "array", index: 0 });
        i++;
        skipWs();
        if (text[i] === "]") { i++; stack.pop(); return; }
        for (;;) {
          readValue();
          skipWs();
          var f = stack[stack.length - 1];
          if (text[i] === ",") { f.index++; i++; continue; }
          if (text[i] === "]") { i++; break; }
          break;
        }
        stack.pop();
      } else if (c === '"') {
        readString();
      } else {
        while (i < n && !WS[text[i]] && text[i] !== "," && text[i] !== "}" && text[i] !== "]") i++;
      }
    }
    readValue();
    return lastPath;
  }

  function formatPath(objectIndex, segments) {
    var p = "keyframes[" + objectIndex + "]";
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      if (typeof s === "number") p += "[" + s + "]";
      else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s)) p += "." + s;
      else p += "[" + JSON.stringify(s) + "]";
    }
    return p;
  }

  var NUM_RE = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;

  /* Strict JSON scan: returns the offset of the first invalid token,
   * or -1 when the text is a single well-formed JSON value. */
  function findSyntaxError(text) {
    var i = 0;
    var n = text.length;
    function ws() { while (i < n && WS[text[i]]) i++; }
    function str() {
      i++;
      while (i < n) {
        var c = text[i];
        if (c === '"') { i++; return true; }
        if (c === "\\") { i += 2; continue; }
        if (c < " ") return false;
        i++;
      }
      return false;
    }
    function value() {
      ws();
      if (i >= n) return false;
      var c = text[i];
      if (c === "{") {
        i++; ws();
        if (text[i] === "}") { i++; return true; }
        for (;;) {
          ws();
          if (text[i] !== '"' || !str()) return false;
          ws();
          if (text[i] !== ":") return false;
          i++;
          if (!value()) return false;
          ws();
          if (text[i] === ",") { i++; continue; }
          if (text[i] === "}") { i++; return true; }
          return false;
        }
      }
      if (c === "[") {
        i++; ws();
        if (text[i] === "]") { i++; return true; }
        for (;;) {
          if (!value()) return false;
          ws();
          if (text[i] === ",") { i++; continue; }
          if (text[i] === "]") { i++; return true; }
          return false;
        }
      }
      if (c === '"') return str();
      if (text.startsWith("true", i)) { i += 4; return true; }
      if (text.startsWith("false", i)) { i += 5; return true; }
      if (text.startsWith("null", i)) { i += 4; return true; }
      NUM_RE.lastIndex = i;
      var m = NUM_RE.exec(text);
      if (m && m[0].length > 0) { i += m[0].length; return true; }
      return false;
    }
    if (!value()) return i;
    ws();
    return i < n ? i : -1;
  }

  /* Schema validation for one keyframe. Returns null or {path, message}. */
  var EASINGS = { "linear": 1, "ease-in": 1, "ease-out": 1, "ease-in-out": 1, "step": 1 };
  function validateKeyframe(kf) {
    function bad(path, msg) { return { path: path, message: msg }; }
    if (kf === null || typeof kf !== "object" || Array.isArray(kf)) {
      return bad("", "关键帧必须是对象");
    }
    if (!Number.isInteger(kf.id) || kf.id < 0) return bad("id", "id 必须是非负整数");
    if (typeof kf.time !== "number" || !isFinite(kf.time)) return bad("time", "time 必须是有限数字");
    if (!Array.isArray(kf.position) || kf.position.length !== 3 ||
        !kf.position.every(function (v) { return typeof v === "number" && isFinite(v); })) {
      var bi = Array.isArray(kf.position)
        ? kf.position.findIndex(function (v) { return typeof v !== "number" || !isFinite(v); })
        : -1;
      return bad(bi >= 0 ? "position[" + bi + "]" : "position", "position 必须是 3 个有限数字的数组");
    }
    if (!Array.isArray(kf.rotation) || kf.rotation.length !== 4 ||
        !kf.rotation.every(function (v) { return typeof v === "number" && isFinite(v); })) {
      return bad("rotation", "rotation 必须是 4 个有限数字的数组（四元数）");
    }
    if (kf.meta === null || typeof kf.meta !== "object" || Array.isArray(kf.meta)) {
      return bad("meta", "meta 必须是对象");
    }
    if (typeof kf.meta.bone !== "string" || kf.meta.bone.length === 0) {
      return bad("meta.bone", "meta.bone 必须是非空字符串");
    }
    if (!EASINGS[kf.meta.easing]) {
      return bad("meta.easing", "meta.easing 必须是 linear/ease-in/ease-out/ease-in-out/step 之一");
    }
    return null;
  }

  /* Streaming parser. Feed string chunks via push(); call end() at EOF.
   * Options: onObject(obj, index), validate (bool, default true). */
  function StreamParser(options) {
    options = options || {};
    this.onObject = options.onObject || null;
    this.validate = options.validate !== false;
    this.state = "expectArray"; // expectArray|expectValue|inObject|expectComma|done
    this.count = 0;
    this.offset = 0; // stream char offset of chunk start
    this.buf = "";
    this.objStart = -1; // index in buf where current object starts
    this.depth = 0;
    this.inString = false;
    this.escaped = false;
  }

  StreamParser.prototype._fail = function (message, details) {
    details = details || {};
    if (details.offset == null) details.offset = this.offset;
    throw KfParseError(message, details);
  };

  StreamParser.prototype._snippet = function (absOffset) {
    var start = Math.max(0, absOffset - this.offset - 20);
    return this.buf.slice(start, start + 60).replace(/\s+/g, " ").trim();
  };

  StreamParser.prototype._emitObject = function (text, absOffset) {
    var index = this.count;
    var obj;
    try {
      obj = JSON.parse(text);
    } catch (err) {
      var rel = findSyntaxError(text);
      if (rel < 0) rel = 0;
      var segs = pathAt(text, rel);
      this._fail("第 " + index + " 个关键帧 JSON 语法错误: " + err.message, {
        objectIndex: index,
        path: formatPath(index, segs),
        offset: absOffset + rel,
        snippet: text.slice(Math.max(0, rel - 20), rel + 40).replace(/\s+/g, " ")
      });
    }
    if (this.validate) {
      var problem = validateKeyframe(obj);
      if (problem) {
        var full = problem.path ? "keyframes[" + index + "]." + problem.path : "keyframes[" + index + "]";
        this._fail(problem.message + "（位于 " + full + "）", {
          objectIndex: index,
          path: full,
          offset: absOffset,
          snippet: text.slice(0, 80).replace(/\s+/g, " ")
        });
      }
    }
    this.count++;
    if (this.onObject) this.onObject(obj, index);
  };

  StreamParser.prototype.push = function (chunk) {
    var base = this.offset;
    this.buf += chunk;
    var s = this.buf;
    var i = 0;
    // Resume mid-object: rescan from the object's opening brace with a
    // fresh depth/string state (objects are small, rescan is cheap).
    if (this.state === "inObject") {
      i = this.objStart + 1;
    }
    for (; i < s.length; i++) {
      var c = s[i];
      if (this.state === "inObject") {
        if (this.inString) {
          if (this.escaped) this.escaped = false;
          else if (c === "\\") this.escaped = true;
          else if (c === '"') this.inString = false;
          continue;
        }
        if (c === '"') { this.inString = true; continue; }
        if (c === "{" || c === "[") { this.depth++; continue; }
        if (c === "}" || c === "]") {
          this.depth--;
          if (this.depth === 0) {
            this._emitObject(s.slice(this.objStart, i + 1), base + this.objStart);
            this.state = "expectComma";
            // Discard consumed prefix to bound memory.
            this.buf = s = s.slice(i + 1);
            base = this.offset = this.offset + i + 1;
            i = -1;
          }
          continue;
        }
        continue;
      }
      if (WS[c]) continue;
      if (this.state === "expectArray") {
        if (c !== "[") {
          this._fail("文件必须是关键帧对象组成的顶层 JSON 数组（以 [ 开头）", {
            offset: base + i, snippet: this._snippet(base + i)
          });
        }
        this.state = "expectValue";
      } else if (this.state === "expectValue") {
        if (c === "]") {
          this.state = "done";
          this.buf = s = s.slice(i + 1);
          base = this.offset = this.offset + i + 1;
          i = -1;
          continue;
        }
        if (c !== "{") {
          this._fail("第 " + this.count + " 个关键帧必须是对象（以 { 开头）", {
            objectIndex: this.count, offset: base + i, snippet: this._snippet(base + i)
          });
        }
        this.state = "inObject";
        this.objStart = i;
        this.depth = 1;
        this.inString = false;
        this.escaped = false;
      } else if (this.state === "expectComma") {
        if (c === ",") { this.state = "expectValue"; continue; }
        if (c === "]") {
          this.state = "done";
          this.buf = s = s.slice(i + 1);
          base = this.offset = this.offset + i + 1;
          i = -1;
          continue;
        }
        this._fail("第 " + this.count + " 个关键帧之后应为 , 或 ]", {
          objectIndex: this.count, offset: base + i, snippet: this._snippet(base + i)
        });
      }
    }
    if (this.state === "inObject") {
      // Reset scan state so the next push() rescans from objStart.
      this.depth = 1;
      this.inString = false;
      this.escaped = false;
    } else if (this.state !== "done" && this.buf.length > 1 << 20) {
      // Only whitespace/commas pending; safe to trim.
      this.buf = "";
      this.offset = base + s.length;
    }
  };

  StreamParser.prototype.end = function () {
    if (this.state === "inObject") {
      this._fail("文件在第 " + this.count + " 个关键帧中被截断（对象未闭合）", {
        objectIndex: this.count, offset: this.offset + this.buf.length,
        snippet: this.buf.slice(-60).replace(/\s+/g, " ")
      });
    }
    if (this.state !== "done") {
      this._fail("文件被截断：顶层数组未闭合", { offset: this.offset + this.buf.length });
    }
    if (this.buf.trim().length > 0) {
      this._fail("顶层数组结束后存在多余内容", {
        offset: this.offset, snippet: this.buf.slice(0, 60).replace(/\s+/g, " ")
      });
    }
    return this.count;
  };

  var api = {
    StreamParser: StreamParser,
    KfParseError: KfParseError,
    validateKeyframe: validateKeyframe,
    findSyntaxError: findSyntaxError,
    pathAt: pathAt,
    formatPath: formatPath
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.KfParser = api;
})(typeof self !== "undefined" ? self : globalThis);
