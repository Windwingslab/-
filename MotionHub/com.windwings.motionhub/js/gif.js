/* MotionHub Studio · GIF 编码器
   全局调色板（中位切分，最多 256 色）+ 可选误差扩散抖动 + LZW 压缩，循环播放 */
(function (root) {
    "use strict";

    // 中位切分：从采样像素里挑出 n 种代表色
    function buildPalette(samples, n) {
        var px = [];
        for (var i = 0; i < samples.length; i += 3) px.push([samples[i], samples[i + 1], samples[i + 2]]);
        if (!px.length) px.push([0, 0, 0]);
        var boxes = [px];
        while (boxes.length < n) {
            var bi = -1, bestRange = -1, bestCh = 0;
            for (var b = 0; b < boxes.length; b++) {
                if (boxes[b].length < 2) continue;
                for (var c = 0; c < 3; c++) {
                    var lo = 255, hi = 0, box = boxes[b];
                    for (var k = 0; k < box.length; k++) { var v = box[k][c]; if (v < lo) lo = v; if (v > hi) hi = v; }
                    if (hi - lo > bestRange) { bestRange = hi - lo; bi = b; bestCh = c; }
                }
            }
            if (bi < 0 || bestRange === 0) break;
            var sorted = boxes[bi].sort(function (x, y) { return x[bestCh] - y[bestCh]; });
            var mid = sorted.length >> 1;
            boxes.splice(bi, 1, sorted.slice(0, mid), sorted.slice(mid));
        }
        return boxes.map(function (box) {
            var r = 0, g = 0, bl = 0;
            for (var k = 0; k < box.length; k++) { r += box[k][0]; g += box[k][1]; bl += box[k][2]; }
            return [Math.round(r / box.length), Math.round(g / box.length), Math.round(bl / box.length)];
        });
    }

    // 最近色查询，带 15 位颜色缓存
    function makeMapper(palette) {
        var cache = new Int16Array(32768).fill(-1);
        return function (r, g, b) {
            var key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
            var hit = cache[key];
            if (hit >= 0) return hit;
            var best = 0, bd = 1e9;
            for (var i = 0; i < palette.length; i++) {
                var p = palette[i], dr = p[0] - r, dg = p[1] - g, db = p[2] - b;
                var d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
                if (d < bd) { bd = d; best = i; }
            }
            cache[key] = best;
            return best;
        };
    }

    function Encoder(width, height, opts) {
        opts = opts || {};
        this.w = width;
        this.h = height;
        this.delay = Math.max(2, Math.round(opts.delayCs || 7));
        this.dither = !!opts.dither;
        this.frames = [];
        this.samples = [];
    }

    // 先收集帧的采样，最后统一建调色板
    Encoder.prototype.addFrame = function (rgba) {
        var copy = new Uint8ClampedArray(rgba);
        this.frames.push(copy);
        var step = Math.max(1, Math.floor(copy.length / 4 / 6000)) * 4;
        for (var i = 0; i < copy.length; i += step) this.samples.push(copy[i], copy[i + 1], copy[i + 2]);
    };

    Encoder.prototype.finish = function (onProgress) {
        var palette = buildPalette(this.samples, 256);
        while (palette.length < 256) palette.push([0, 0, 0]);
        var map = makeMapper(palette), w = this.w, h = this.h, out = new Bytes();
        out.str("GIF89a");
        out.u16(w); out.u16(h);
        out.byte(0xF7); out.byte(0); out.byte(0);   // 全局调色板 256 色
        for (var i = 0; i < 256; i++) { out.byte(palette[i][0]); out.byte(palette[i][1]); out.byte(palette[i][2]); }
        out.byte(0x21); out.byte(0xFF); out.byte(11); out.str("NETSCAPE2.0"); out.byte(3); out.byte(1); out.u16(0); out.byte(0); // 无限循环

        for (var f = 0; f < this.frames.length; f++) {
            var px = this.frames[f], idx = new Uint8Array(w * h);
            if (this.dither) {
                var err = new Float32Array(w * h * 3);
                for (var y = 0; y < h; y++) {
                    for (var x = 0; x < w; x++) {
                        var p = y * w + x, q = p * 4, e = p * 3;
                        var r = clamp(px[q] + err[e]), g = clamp(px[q + 1] + err[e + 1]), b = clamp(px[q + 2] + err[e + 2]);
                        var k = map(r, g, b), c = palette[k];
                        idx[p] = k;
                        var er = r - c[0], eg = g - c[1], eb = b - c[2];
                        spread(err, w, h, x + 1, y, er, eg, eb, 7 / 16);
                        spread(err, w, h, x - 1, y + 1, er, eg, eb, 3 / 16);
                        spread(err, w, h, x, y + 1, er, eg, eb, 5 / 16);
                        spread(err, w, h, x + 1, y + 1, er, eg, eb, 1 / 16);
                    }
                }
            } else {
                for (var j = 0, n = w * h; j < n; j++) idx[j] = map(px[j * 4], px[j * 4 + 1], px[j * 4 + 2]);
            }
            out.byte(0x21); out.byte(0xF9); out.byte(4); out.byte(0x04); out.u16(this.delay); out.byte(0); out.byte(0); // 帧延时
            out.byte(0x2C); out.u16(0); out.u16(0); out.u16(w); out.u16(h); out.byte(0);
            out.byte(8);
            var data = lzw(idx, 8);
            for (var s = 0; s < data.length; s += 255) {
                var len = Math.min(255, data.length - s);
                out.byte(len);
                for (var t = 0; t < len; t++) out.byte(data[s + t]);
            }
            out.byte(0);
            this.frames[f] = null;
            if (onProgress) onProgress((f + 1) / this.frames.length);
        }
        out.byte(0x3B);
        return out.result();
    };

    function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }
    function spread(err, w, h, x, y, er, eg, eb, k) {
        if (x < 0 || x >= w || y >= h) return;
        var e = (y * w + x) * 3;
        err[e] += er * k; err[e + 1] += eg * k; err[e + 2] += eb * k;
    }

    // GIF 的 LZW：变长编码，4096 个码满了就发清除码重来
    function lzw(indices, minSize) {
        var clear = 1 << minSize, eoi = clear + 1, size = minSize + 1, next = eoi + 1;
        var out = [], acc = 0, bits = 0, dict = new Map();
        function emit(code) {
            acc |= code << bits;
            bits += size;
            while (bits >= 8) { out.push(acc & 255); acc >>>= 8; bits -= 8; }
        }
        emit(clear);
        var prefix = indices[0];
        for (var i = 1; i < indices.length; i++) {
            var k = indices[i], key = (prefix << 8) | k, hit = dict.get(key);
            if (hit !== undefined) { prefix = hit; continue; }
            emit(prefix);
            if (next < 4096) {
                dict.set(key, next++);
                if (next > (1 << size) && size < 12) size++;
            } else {
                emit(clear);
                dict.clear();
                size = minSize + 1;
                next = eoi + 1;
            }
            prefix = k;
        }
        emit(prefix);
        emit(eoi);
        if (bits > 0) out.push(acc & 255);
        return out;
    }

    function Bytes() { this.chunks = []; this.buf = new Uint8Array(1 << 16); this.pos = 0; }
    Bytes.prototype.byte = function (v) {
        if (this.pos >= this.buf.length) { this.chunks.push(this.buf); this.buf = new Uint8Array(1 << 16); this.pos = 0; }
        this.buf[this.pos++] = v & 255;
    };
    Bytes.prototype.u16 = function (v) { this.byte(v & 255); this.byte((v >> 8) & 255); };
    Bytes.prototype.str = function (s) { for (var i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); };
    Bytes.prototype.result = function () {
        var total = this.pos, i;
        for (i = 0; i < this.chunks.length; i++) total += this.chunks[i].length;
        var r = new Uint8Array(total), o = 0;
        for (i = 0; i < this.chunks.length; i++) { r.set(this.chunks[i], o); o += this.chunks[i].length; }
        r.set(this.buf.subarray(0, this.pos), o);
        return r;
    };

    root.MHGif = { Encoder: Encoder, buildPalette: buildPalette, lzw: lzw };
})(typeof window !== "undefined" ? window : globalThis);
