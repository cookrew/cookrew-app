/**
 * THE H.264 ENCODER, AS A PAGE SCRIPT (cast-encoder-script.ts).
 *
 * WebCodecs lives in pages, not in Electron's main process, so the encoder runs
 * in a hidden window (main/cast-encoder.ts) and main calls these functions with
 * executeJavaScript. The same text runs in a real Chrome page in the tests, so
 * what is tested is what ships.
 *
 *   __castEncSupported(codec, w, h)            can this page encode it at all
 *   __castEncOpen(id, { codec, bitrate, framerate })
 *   __castEncEncode(id, jpegBase64, key, timestampMicros, width, height)  -> { data, key } | null
 *   __castEncClose(id)
 *
 * A picture arrives as the screencast's JPEG and is drawn, unscaled, at the top
 * left of a canvas of the size main asks for (the largest frame of the
 * viewport so far, so a screencast that jitters by two rows changes two rows),
 * at even dimensions (4:2:0 needs them; an odd last row or column is dropped
 * and the phone draws the picture back at the frame's own size). The encoder
 * is set up again whenever that size changes, and its first chunk is then a
 * key frame.
 * Every encode is flushed, so each call gives back its own chunk: realtime and
 * in order, which is what the phone's decoder needs. Annex B: a key frame
 * carries its own parameter sets, so the phone needs no separate description.
 */
export const CAST_ENCODER_SCRIPT = `(() => {
  const encs = window.__castEncs || (window.__castEncs = new Map());
  const even = (v) => Math.max(2, v - (v % 2));
  const config = (codec, width, height, bitrate, framerate) => ({
    codec, width: even(width), height: even(height), bitrate, framerate,
    latencyMode: 'realtime', bitrateMode: 'variable', hardwareAcceleration: 'no-preference',
    avc: { format: 'annexb' }
  });
  const toBytes = (s) => {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const toBase64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  window.__castEncSupported = async (codec, width, height) => {
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return false;
    try {
      const answer = await VideoEncoder.isConfigSupported(config(codec, width, height, 2000000, 30));
      return answer.supported === true;
    } catch (e) {
      return false;
    }
  };
  window.__castEncOpen = (id, options) => {
    const old = encs.get(id);
    if (old && old.encoder && old.encoder.state !== 'closed') old.encoder.close();
    encs.set(id, { options, encoder: null, canvas: null, w: 0, h: 0, out: [], error: null });
    return true;
  };
  const configure = (entry, w, h) => {
    if (entry.encoder && entry.encoder.state !== 'closed') entry.encoder.close();
    entry.out = [];
    entry.error = null;
    entry.encoder = new VideoEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        entry.out.push({ bytes, key: chunk.type === 'key' });
      },
      error: (e) => { entry.error = String(e && e.message || e); }
    });
    entry.encoder.configure(config(entry.options.codec, w, h, entry.options.bitrate, entry.options.framerate));
    entry.canvas = new OffscreenCanvas(w, h);
    entry.context = entry.canvas.getContext('2d', { alpha: false });
    entry.w = w;
    entry.h = h;
  };
  window.__castEncEncode = async (id, jpegBase64, key, timestamp, width, height) => {
    const entry = encs.get(id);
    if (!entry) throw new Error('This encoder is not open.');
    const bitmap = await createImageBitmap(new Blob([toBytes(jpegBase64)], { type: 'image/jpeg' }));
    let keyFrame = key === true;
    try {
      // Closed while the picture was decoding: no encoder may be made for it now.
      if (encs.get(id) !== entry) return null;
      const w = even(width || bitmap.width);
      const h = even(height || bitmap.height);
      if (!entry.encoder || entry.encoder.state === 'closed' || entry.w !== w || entry.h !== h) {
        configure(entry, w, h);
        keyFrame = true;
      }
      entry.context.drawImage(bitmap, 0, 0);
    } finally {
      bitmap.close();
    }
    const frame = new VideoFrame(entry.canvas, { timestamp });
    entry.out = [];
    try {
      entry.encoder.encode(frame, { keyFrame });
    } finally {
      frame.close();
    }
    await entry.encoder.flush();
    if (entry.error) {
      const message = entry.error;
      entry.error = null;
      entry.encoder = null;
      throw new Error(message);
    }
    if (entry.out.length === 0) return null;
    const size = entry.out.reduce((sum, c) => sum + c.bytes.length, 0);
    const all = new Uint8Array(size);
    let at = 0;
    for (const c of entry.out) { all.set(c.bytes, at); at += c.bytes.length; }
    const isKey = entry.out[0].key;
    entry.out = [];
    return { data: toBase64(all), key: isKey };
  };
  window.__castEncClose = (id) => {
    const entry = encs.get(id);
    encs.delete(id);
    if (entry && entry.encoder && entry.encoder.state !== 'closed') entry.encoder.close();
    return true;
  };
  return true;
})()`
