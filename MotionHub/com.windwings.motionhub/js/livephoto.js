/*
    MotionHub Studio · Apple 实况照片（Live Photo）
    把一张 JPEG 封面和一段 H.264 视频配成一对：
      - JPEG：在 EXIF 的 Apple MakerNote 里写入内容标识（tag 17）
      - MOV：写入 com.apple.quicktime.content.identifier，并加一条 still-image-time 定时元数据轨，标出封面所在时刻
    两个文件用同一个 UUID，导入「照片」时就会合成一张实况照片。

    SPDX-License-Identifier: Apache-2.0
    本文件的 MOV / MakerNote 写法改写自 video-to-live-photo（Copyright 2026 杨振，Apache-2.0）
    及 LiveCanvas 的修订版（MIT，pengchujin）；许可证与署名见 third_party/video-to-live-photo/。
    改动：从 Python 改写为 JavaScript；自行生成 EXIF；接收 MP4 时把 ftyp 改为 QuickTime。
*/
(function (root) {
    "use strict";

    var CONTENT_KEY = ascii("com.apple.quicktime.content.identifier");
    var STILL_TIME_KEY = ascii("com.apple.quicktime.still-image-time");
    var TIMED_SAMPLE = new Uint8Array([0, 0, 0, 9, 0, 0, 0, 1, 0]);
    var CONTAINERS = { moov: 1, trak: 1, mdia: 1, minf: 1, dinf: 1, stbl: 1, edts: 1, tref: 1, gmhd: 1, udta: 1, ilst: 1 };

    // ---------------------------------------------------------------- 字节工具
    function ascii(s) { var b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; }
    function toAscii(b) { var s = ""; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; }
    function concat() {
        var parts = Array.prototype.slice.call(arguments), n = 0, i;
        for (i = 0; i < parts.length; i++) n += parts[i].length;
        var out = new Uint8Array(n), o = 0;
        for (i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
        return out;
    }
    function u8(v) { return new Uint8Array([v & 255]); }
    function u16(v) { return new Uint8Array([(v >>> 8) & 255, v & 255]); }
    function i16(v) { return u16(v & 0xFFFF); }
    function u24(v) { return new Uint8Array([(v >>> 16) & 255, (v >>> 8) & 255, v & 255]); }
    function u32(v) { return new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]); }
    function i32(v) { return u32(v >>> 0); }
    function u64(v) { var hi = Math.floor(v / 4294967296), lo = v >>> 0; return concat(u32(hi), u32(lo)); }
    function zeros(n) { return new Uint8Array(n); }
    function rd32(b, o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
    function rd64(b, o) { return rd32(b, o) * 4294967296 + rd32(b, o + 4); }
    function wr32(b, o, v) { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; }
    function wr64(b, o, v) { wr32(b, o, Math.floor(v / 4294967296)); wr32(b, o + 4, v >>> 0); }
    function type(b, o) { return toAscii(b.subarray(o + 4, o + 8)); }

    // ---------------------------------------------------------------- ISO BMFF
    function atom(kind, payload) {
        var size = payload.length + 8;
        if (size > 0xFFFFFFFF) throw new Error("atom 太大");
        return concat(u32(size), ascii(kind), payload);
    }

    function parseAtoms(b, start, end) {
        var out = [], pos = start;
        while (pos < end) {
            if (pos + 8 > end) throw new Error("MOV atom 头部不完整");
            var size = rd32(b, pos), kind = type(b, pos), header = 8;
            if (size === 1) { size = rd64(b, pos + 8); header = 16; }
            else if (size === 0) size = end - pos;
            if (size < header || pos + size > end) throw new Error("MOV atom " + kind + " 超出文件边界");
            out.push({ start: pos, size: size, end: pos + size, type: kind, body: pos + header });
            pos += size;
        }
        return out;
    }
    function children(b, a) { return parseAtoms(b, a.body, a.end); }
    function firstChild(b, a, kind) { var c = children(b, a); for (var i = 0; i < c.length; i++) if (c[i].type === kind) return c[i]; return null; }

    // 把整个 moov 里所有 stco / co64 的偏移量加上 delta
    function patchChunkOffsets(moov, delta) {
        var b = new Uint8Array(moov);
        (function visit(parent) {
            children(b, parent).forEach(function (a) {
                if (a.type === "stco" || a.type === "co64") {
                    var count = rd32(b, a.body + 4), w = a.type === "stco" ? 4 : 8, at = a.body + 8;
                    for (var i = 0; i < count; i++) {
                        var p = at + i * w, v = (w === 4 ? rd32(b, p) : rd64(b, p)) + delta;
                        if (v < 0 || (w === 4 && v > 0xFFFFFFFF)) throw new Error("MOV 偏移量调整后越界");
                        if (w === 4) wr32(b, p, v); else wr64(b, p, v);
                    }
                } else if (CONTAINERS[a.type]) visit(a);
            });
        })(parseAtoms(b, 0, b.length)[0]);
        return b;
    }

    function fullbox(version, flags) { return concat(u8(version || 0), u24(flags || 0)); }
    function pascal(text) { var t = ascii(text); return concat(u8(t.length), t); }

    function contentIdentifierMeta(id) {
        var ident = ascii(id);
        var hdlr = atom("hdlr", concat(fullbox(), zeros(4), ascii("mdta"), zeros(12), zeros(2)));
        var keyEntry = concat(u32(8 + CONTENT_KEY.length), ascii("mdta"), CONTENT_KEY);
        var keys = atom("keys", concat(fullbox(), u32(1), keyEntry));
        var data = atom("data", concat(u32(1), u32(0), ident));
        var item = concat(u32(data.length + 8), new Uint8Array([0, 0, 0, 1]), data);
        return atom("meta", concat(hdlr, keys, atom("ilst", item)));
    }

    function timedMetadataTrack(trackId, videoTrackId, timescale, coverTicks, sampleOffset, sampleTicks) {
        var matrix = concat(u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000));
        var tkhd = atom("tkhd", concat(fullbox(0, 0x0F), u32(0), u32(0), u32(trackId), u32(0), u32(coverTicks + sampleTicks),
            zeros(8), i16(0), i16(0), i16(0), i16(0), matrix, u32(0), u32(0)));
        var edits = [];
        if (coverTicks) edits.push(concat(u32(coverTicks), i32(-1), u16(1), u16(0)));
        edits.push(concat(u32(sampleTicks), i32(0), u16(1), u16(0)));
        var elst = atom("elst", concat(fullbox(), u32(edits.length), concat.apply(null, edits)));
        var edts = atom("edts", elst);
        var tref = atom("tref", atom("cdsc", u32(videoTrackId)));
        var mdhd = atom("mdhd", concat(fullbox(), u32(0), u32(0), u32(timescale), u32(sampleTicks), u16(0x55C4), u16(0)));
        var hdlr = atom("hdlr", concat(fullbox(), ascii("mhlrmetaappl"), u32(1), u32(0), pascal("Core Media Metadata")));
        var gmin = atom("gmin", concat(fullbox(), u16(0x0040), u16(0x8000), u16(0x8000), u16(0x8000), u16(0), u16(0)));
        var gmhd = atom("gmhd", gmin);
        var dataHdlr = atom("hdlr", concat(fullbox(), ascii("dhlralisappl"), u32(0), u32(0), pascal("Core Media Data Handler")));
        var dinf = atom("dinf", atom("dref", concat(fullbox(), u32(1), atom("alis", fullbox(0, 1)))));
        var keyd = atom("keyd", concat(ascii("mdta"), STILL_TIME_KEY));
        var dtyp = atom("dtyp", concat(fullbox(), u32(0x41)));
        var keyRecord = concat(u32(8 + keyd.length + dtyp.length), u32(1), keyd, dtyp);
        var mebx = atom("mebx", concat(zeros(6), u16(1), atom("keys", keyRecord)));
        var stsd = atom("stsd", concat(fullbox(), u32(1), mebx));
        var stts = atom("stts", concat(fullbox(), u32(1), u32(1), u32(sampleTicks)));
        var stsc = atom("stsc", concat(fullbox(), u32(1), u32(1), u32(1), u32(1)));
        var stsz = atom("stsz", concat(fullbox(), u32(0), u32(1), u32(TIMED_SAMPLE.length)));
        var co = sampleOffset <= 0xFFFFFFFF ? atom("stco", concat(fullbox(), u32(1), u32(sampleOffset))) : atom("co64", concat(fullbox(), u32(1), u64(sampleOffset)));
        var stbl = atom("stbl", concat(stsd, stts, stsc, stsz, co));
        var minf = atom("minf", concat(gmhd, dataHdlr, dinf, stbl));
        var mdia = atom("mdia", concat(mdhd, hdlr, minf));
        return atom("trak", concat(tkhd, edts, tref, mdia));
    }

    function trackId(b, trak) { var t = firstChild(b, trak, "tkhd"); return rd32(b, t.start + (b[t.body] === 1 ? 28 : 20)); }
    function handler(b, trak) {
        var mdia = firstChild(b, trak, "mdia"), h = mdia && firstChild(b, mdia, "hdlr");
        return h ? toAscii(b.subarray(h.start + 16, h.start + 20)) : "";
    }

    // mp4/mov（H.264，单个 mdat）→ 实况照片用的 MOV
    function writeLiveMov(src, id, stillTime, duration, fps) {
        var top = parseAtoms(src, 0, src.length), mdat = null, moov = null, mdats = 0, i;
        for (i = 0; i < top.length; i++) {
            if (top[i].type === "mdat") { mdat = top[i]; mdats++; }
            if (top[i].type === "moov") moov = top[i];
            if (top[i].type === "moof") throw new Error("不支持分段（fragmented）的视频");
        }
        if (!mdat || !moov || mdats !== 1) throw new Error("视频必须是只有一个 mdat 的 MP4 / MOV");
        var mvhd = firstChild(src, moov, "mvhd");
        var timescale = rd32(src, mvhd.start + (src[mvhd.body] === 1 ? 28 : 20));
        var tracks = children(src, moov).filter(function (a) { return a.type === "trak"; });
        var video = null, maxId = 0;
        tracks.forEach(function (t) { maxId = Math.max(maxId, trackId(src, t)); if (!video && handler(src, t) === "vide") video = t; });
        if (!video) throw new Error("视频里没有画面轨道");
        var metaId = maxId + 1;
        var cover = Math.min(Math.max(0, Math.round(stillTime * timescale)), Math.max(0, Math.round(duration * timescale) - 1));

        // 文件头：ftyp 换成 QuickTime，其余非 mdat / moov 的 atom 原样保留
        var prefixParts = [atom("ftyp", concat(ascii("qt  "), u32(0), ascii("qt  ")))];
        top.forEach(function (a) { if (a.type !== "mdat" && a.type !== "moov" && a.type !== "ftyp") prefixParts.push(src.subarray(a.start, a.end)); });
        var prefix = concat.apply(null, prefixParts);
        var media = src.subarray(mdat.body, mdat.end);
        var newMdat = atom("mdat", concat(media, TIMED_SAMPLE));
        var newMediaStart = prefix.length + 8;
        var delta = newMediaStart - mdat.body, sampleOffset = newMediaStart + media.length;

        var pm = patchChunkOffsets(src.subarray(moov.start, moov.end), delta);
        var pmAtom = parseAtoms(pm, 0, pm.length)[0], pmvhd = firstChild(pm, pmAtom, "mvhd");
        wr32(pm, pmvhd.end - 4, metaId + 1);   // next_track_ID
        var additions = concat(contentIdentifierMeta(id), timedMetadataTrack(metaId, trackId(src, video), timescale, cover, sampleOffset, Math.max(1, Math.round(timescale / fps))));
        var newMoov = atom("moov", concat(pm.subarray(pmAtom.body, pmAtom.end), additions));
        return concat(prefix, newMdat, newMoov);
    }

    // 读回检查
    function inspectLiveMov(b) {
        var top = parseAtoms(b, 0, b.length), moov = null;
        top.forEach(function (a) { if (a.type === "moov") moov = a; });
        if (!moov) throw new Error("缺少 moov");
        var meta = firstChild(b, moov, "meta"), id = null;
        if (meta) {
            var ilst = firstChild(b, meta, "ilst"), item = ilst && children(b, ilst)[0], data = item && firstChild(b, item, "data");
            if (data) id = toAscii(b.subarray(data.body + 8, data.end));
        }
        var hasStill = false;
        children(b, moov).forEach(function (t) { if (t.type === "trak" && handler(b, t) === "meta") hasStill = toAscii(b.subarray(t.start, t.end)).indexOf("still-image-time") !== -1; });
        return { id: id, stillTrack: hasStill };
    }

    // ---------------------------------------------------------------- JPEG / EXIF
    function makerNote(id) {
        var ident = ascii(id);
        return concat(ascii("Apple iOS"), u8(0), u16(1), ascii("MM"), u16(1), u16(0x11), u16(2), u32(ident.length + 1), u32(32), u32(0), ident, u8(0));
    }

    // 自己拼一个大端 EXIF：IFD0（Make / Model / ExifIFD 指针）+ ExifIFD（含 MakerNote）
    function exifApp1(id, w, h) {
        var note = makerNote(id), make = ascii("Apple\0"), model = ascii("MotionHub\0");
        var ifd0At = 8, ifd0Size = 2 + 3 * 12 + 4, makeAt = ifd0At + ifd0Size, modelAt = makeAt + make.length;
        var exifAt = modelAt + model.length + ((modelAt + model.length) % 2), exifSize = 2 + 6 * 12 + 4, noteAt = exifAt + exifSize;
        function entry(tag, kind, count, value) { return concat(u16(tag), u16(kind), u32(count), value.length === 4 ? value : concat(value, zeros(4 - value.length))); }
        var ifd0 = concat(u16(3),
            entry(0x010F, 2, make.length, u32(makeAt)),
            entry(0x0110, 2, model.length, u32(modelAt)),
            entry(0x8769, 4, 1, u32(exifAt)),
            u32(0));
        var exif = concat(u16(6),
            entry(0x9000, 7, 4, ascii("0232")),
            entry(0x927C, 7, note.length, u32(noteAt)),
            entry(0xA000, 7, 4, ascii("0100")),
            entry(0xA001, 3, 1, concat(u16(1), u16(0))),
            entry(0xA002, 4, 1, u32(w)),
            entry(0xA003, 4, 1, u32(h)),
            u32(0));
        var pad = zeros(exifAt - (modelAt + model.length));
        var tiff = concat(ascii("MM"), u16(42), u32(ifd0At), ifd0, make, model, pad, exif, note);
        var body = concat(ascii("Exif\0\0"), tiff);
        return concat(new Uint8Array([0xFF, 0xE1]), u16(body.length + 2), body);
    }

    // 去掉原来的 APP0 / APP1，把新的 EXIF 放在 SOI 后面
    function writeLiveJpeg(jpeg, id, w, h) {
        if (jpeg[0] !== 0xFF || jpeg[1] !== 0xD8) throw new Error("不是 JPEG");
        var pos = 2, keep = [];
        while (pos + 4 <= jpeg.length && jpeg[pos] === 0xFF) {
            var marker = jpeg[pos + 1];
            if (marker === 0xDA) break;
            var len = (jpeg[pos + 2] << 8) + jpeg[pos + 3];
            if (marker !== 0xE0 && marker !== 0xE1) keep.push(jpeg.subarray(pos, pos + 2 + len));
            pos += 2 + len;
        }
        return concat.apply(null, [jpeg.subarray(0, 2), exifApp1(id, w, h)].concat(keep, [jpeg.subarray(pos)]));
    }

    function uuid() {
        var b = new Uint8Array(16);
        (root.crypto || require("crypto").webcrypto).getRandomValues(b);
        b[6] = (b[6] & 0x0F) | 0x40;
        b[8] = (b[8] & 0x3F) | 0x80;
        var h = Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("").toUpperCase();
        return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
    }

    root.MHLive = { writeLiveMov: writeLiveMov, writeLiveJpeg: writeLiveJpeg, inspectLiveMov: inspectLiveMov, uuid: uuid };
})(typeof window !== "undefined" ? window : globalThis);
