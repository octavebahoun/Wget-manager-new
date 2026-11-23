'use strict';
// Tests unitaires (sans réseau) : node --test
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');

const util = require('../lib/util');
const { classifyUrl, normalizeUrl, isSegmentUrl, extractUrl } = require('../lib/detect');
const { scrapeHtml, parseHls } = require('../lib/scraper');
const { sniffBuffer } = require('../lib/probe');
const { isPrivateIp, filenameFromDisposition } = require('../lib/net');
const { normalizeCookieJar, toNetscape, cookieHeaderFor } = require('../lib/cookies');
const { pickTracks, summarizeManifest } = require('../lib/engines/vimeo');
const { parseAria2Line } = require('../lib/engines/aria2');
const { buildFormat, summarizeInfo } = require('../lib/engines/ytdlp');

test('sanitizeFilename : accents, caractères interdits, longueur', () => {
  assert.equal(util.sanitizeFilename('PRÉSENTATION « Vidéos » | Été/2024'), 'PRESENTATION_Videos_Ete_2024');
  assert.equal(util.sanitizeFilename('../../etc/passwd'), 'etc_passwd');
  assert.equal(util.sanitizeFilename('   '), '');
  assert.ok(util.sanitizeFilename('a'.repeat(400)).length <= 150);
});

test('splitExt ne prend que les extensions connues', () => {
  assert.deepEqual(util.splitExt('www.skool.com'), { base: 'www.skool.com', ext: '' });
  assert.deepEqual(util.splitExt('Film.MP4'), { base: 'Film', ext: 'mp4' });
});

test('parseSize / formatBytes / formatDuration', () => {
  assert.equal(util.parseSize('5G'), 5 * 1024 ** 3);
  assert.equal(util.parseSize('11MiB'), 11 * 1024 ** 2);
  assert.equal(util.parseSize('0'), 0);
  assert.equal(util.formatBytes(1536), '1.5 KB');
  assert.equal(util.formatDuration(3725), '1h02m');
});

test('classifyUrl reconnaît les types de liens', () => {
  assert.equal(classifyUrl('https://www.youtube.com/watch?v=jNQXAC9IVRw').kind, 'platform');
  assert.equal(classifyUrl('https://cdn.site.com/a/master.m3u8?t=1').kind, 'hls');
  assert.equal(classifyUrl('https://cdn.site.com/a/manifest.mpd').kind, 'dash');
  assert.equal(classifyUrl('https://vod-adaptive-ak.vimeocdn.com/e/u/v2/playlist/av/primary/playlist.json?x=1').kind, 'vimeo-json');
  assert.equal(classifyUrl('https://vod-adaptive-ak.vimeocdn.com/e/u/v2/range/prot/x/avf/a.mp4?range=1-2').kind, 'segment');
  assert.equal(classifyUrl('https://rr1.googlevideo.com/videoplayback?x=1').kind, 'googlevideo');
  assert.equal(classifyUrl('https://example.com/doc.pdf').kind, 'direct');
  assert.equal(classifyUrl('https://example.com/watch/123').kind, 'unknown');
  assert.equal(classifyUrl('ftp://example.com/a').kind, 'invalid');
});

test('isSegmentUrl', () => {
  assert.ok(isSegmentUrl('https://c.com/v/seg-12-v1-a1.ts'));
  assert.ok(isSegmentUrl('https://c.com/v/chunk_3.m4s'));
  assert.ok(!isSegmentUrl('https://c.com/v/video.mp4'));
});

test('normalizeUrl convertit les liens API Vimeo et nettoie googlevideo', () => {
  assert.equal(normalizeUrl('https://api.vimeo.com/videos/1168474376:84cee970e5?anon_signature=x'), 'https://player.vimeo.com/video/1168474376?h=84cee970e5');
  assert.equal(normalizeUrl('https://api.vimeo.com/videos/76979871'), 'https://vimeo.com/76979871');
  assert.equal(normalizeUrl('https://r1.googlevideo.com/videoplayback?a=1&range=0-100&rn=2'), 'https://r1.googlevideo.com/videoplayback?a=1');
  assert.equal(normalizeUrl('<https://a.com/x.mp4?a=1&amp;b=2>'), 'https://a.com/x.mp4?a=1&b=2');
});

test('extractUrl récupère une URL au milieu d\'en-têtes', () => {
  assert.equal(extractUrl('Referer: x\nhttps://a.com/v.mp4 more'), 'https://a.com/v.mp4');
  assert.equal(extractUrl('pas d\'url'), null);
});

test('scrapeHtml trouve vidéos, flux, embeds et JSON échappé', () => {
  const html = `<html><head><title>T</title><meta property="og:title" content="Ma vidéo">
    <meta property="og:video" content="https://cdn.a.com/og.mp4"></head><body>
    <video poster="/p.jpg"><source src="/media/720p.mp4" type="video/mp4"></video>
    <iframe src="https://player.vimeo.com/video/123456?h=abcdef"></iframe>
    <script>var c={"hls":"https:\\/\\/s.b.com\\/live\\/master.m3u8?tok=1"};</script>
    <a href="/files/guide.pdf">PDF</a><a href="/about">x</a>
    <script>ads("https://doubleclick.net/x.mp4")</script></body></html>`;
  const r = scrapeHtml(html, 'https://site.com/page');
  const urls = r.candidates.map((c) => c.url);
  assert.equal(r.title, 'Ma vidéo');
  assert.ok(urls.includes('https://site.com/media/720p.mp4'));
  assert.ok(urls.includes('https://cdn.a.com/og.mp4'));
  assert.ok(urls.includes('https://player.vimeo.com/video/123456?h=abcdef'));
  assert.ok(urls.includes('https://s.b.com/live/master.m3u8?tok=1'));
  assert.ok(urls.includes('https://site.com/files/guide.pdf'));
  assert.ok(!urls.some((u) => u.includes('doubleclick')));
  assert.equal(r.candidates[0].kind, 'platform');
});

test('parseHls : master, durée, DRM', () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\nhd.m3u8\n';
  const m = parseHls(master, 'https://c.com/v/master.m3u8');
  assert.ok(m.isMaster);
  assert.equal(m.variants[0].height, 1080);
  assert.equal(m.variants[0].url, 'https://c.com/v/hd.m3u8');
  const media = parseHls('#EXTM3U\n#EXTINF:4.0,\na.ts\n#EXTINF:4.0,\nb.ts\n#EXT-X-ENDLIST\n', 'https://c.com/');
  assert.equal(media.duration, 8);
  assert.equal(media.isLive, false);
  const drm = parseHls('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:4,\na.ts\n', 'https://c.com/');
  assert.ok(drm.drm);
  assert.equal(parseHls('<html>', 'https://c.com/'), null);
});

test('sniffBuffer reconnaît le vrai contenu', () => {
  assert.equal(sniffBuffer(Buffer.from('#EXTM3U\n#EXT-X-VERSION:3')).kind, 'hls');
  assert.equal(sniffBuffer(Buffer.from('{"clip_id":"x","base_url":"../"}')).kind, 'vimeo-json');
  assert.equal(sniffBuffer(Buffer.from('<!DOCTYPE html><html>')).kind, 'page');
  assert.equal(sniffBuffer(Buffer.from('<?xml version="1.0"?><MPD xmlns="x">')).kind, 'dash');
  const mp4 = Buffer.alloc(16);
  mp4.write('ftypisom', 4, 'latin1');
  assert.deepEqual(sniffBuffer(mp4), { kind: 'direct', ext: 'mp4' });
  assert.equal(sniffBuffer(Buffer.from('%PDF-1.4')).ext, 'pdf');
  assert.equal(sniffBuffer(Buffer.from('ID3\x03')).ext, 'mp3');
});

test('isPrivateIp bloque localhost / réseaux privés', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fd00::1', 'fe80::1', '0.0.0.0', '100.64.1.1']) {
    assert.ok(isPrivateIp(ip), ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '172.32.0.1']) assert.ok(!isPrivateIp(ip), ip);
});

test('filenameFromDisposition gère UTF-8', () => {
  assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''Ma%20Vid%C3%A9o.mp4"), 'Ma Vidéo.mp4');
  assert.equal(filenameFromDisposition('attachment; filename="a b.zip"'), 'a b.zip');
  assert.equal(filenameFromDisposition(null), null);
});

test('cookies : fichier Netscape et en-tête filtré par URL', () => {
  const jar = normalizeCookieJar([
    { domain: '.example.com', hostOnly: false, path: '/', secure: true, name: 'sid', value: 'a1' },
    { domain: 'www.example.com', hostOnly: true, path: '/', name: 'host', value: 'b2' },
    { domain: 'other.com', hostOnly: true, path: '/', name: 'x', value: 'y' },
    { name: 'invalide' },
  ]);
  assert.equal(jar.length, 3);
  assert.equal(cookieHeaderFor('https://cdn.example.com/v.mp4', jar), 'sid=a1');
  assert.equal(cookieHeaderFor('https://www.example.com/', jar), 'sid=a1; host=b2');
  assert.equal(cookieHeaderFor('http://www.example.com/', jar), 'host=b2');
  const txt = toNetscape(jar);
  assert.match(txt, /^\.example\.com\tTRUE\t\/\tTRUE\t0\tsid\ta1$/m);
  assert.match(txt, /^www\.example\.com\tFALSE\t\/\tFALSE\t0\thost\tb2$/m);
});

test('Vimeo : choix des pistes selon la qualité', () => {
  const seg = [{ url: 's1', size: 10 }];
  const manifest = {
    video: [
      { id: 'a', height: 360, bitrate: 1, segments: seg },
      { id: 'b', height: 1080, bitrate: 5, segments: seg },
      { id: 'c', height: 720, bitrate: 3, segments: seg },
    ],
    audio: [
      { id: 'x', bitrate: 64, segments: seg },
      { id: 'y', bitrate: 128, audio_primary: true, segments: seg },
    ],
  };
  assert.equal(pickTracks(manifest).video.id, 'b');
  assert.equal(pickTracks(manifest, '720').video.id, 'c');
  assert.equal(pickTracks(manifest, '240').video.id, 'a');
  assert.equal(pickTracks(manifest, 'audio').video, null);
  assert.equal(pickTracks(manifest).audio.id, 'y');
  assert.deepEqual(summarizeManifest(manifest).formats.map((f) => f.id), ['1080', '720', '360', 'audio']);
});

test('aria2 : lecture de la progression (GID hexadécimal)', () => {
  const p = parseAria2Line('[#c583f7 3.0MiB/11MiB(27%) CN:4 DL:1.5MiB ETA:5s]');
  assert.equal(p.progress, 27);
  assert.equal(p.connections, 4);
  assert.equal(p.totalBytes, 11 * 1024 ** 2);
  assert.equal(p.etaSec, 5);
  assert.equal(parseAria2Line('[#c583f7 9.2MiB/11MiB(81%) CN:1 DL:2.2MiB]').etaSec, null);
  assert.equal(parseAria2Line('FILE: /tmp/x'), null);
});

test('yt-dlp : format selon la qualité + résumé des formats', () => {
  assert.equal(buildFormat({ quality: 'best' }), 'bv*+ba/b');
  assert.equal(buildFormat({ quality: 'audio' }), 'ba/b');
  assert.match(buildFormat({ quality: '720' }), /height<=720/);
  assert.equal(buildFormat({ quality: 'best', format: 'bv[ext=mp4]' }), 'bv[ext=mp4]');
  const s = summarizeInfo({
    title: 'T',
    duration: 10,
    formats: [
      { height: 1080, vcodec: 'avc1', acodec: 'none', tbr: 5000, filesize: 100 },
      { height: 720, vcodec: 'avc1', acodec: 'none', tbr: 2500 },
      { vcodec: 'none', acodec: 'mp4a', abr: 128, filesize: 10 },
    ],
  });
  assert.deepEqual(s.formats.map((f) => f.id), ['1080', '720', 'audio']);
  assert.equal(s.formats[0].size, 110);
  const pl = summarizeInfo({ _type: 'playlist', title: 'P', entries: [{ url: 'https://youtu.be/aaaaaaaaaaa', title: 'A' }] });
  assert.ok(pl.isPlaylist);
  assert.equal(pl.entries.length, 1);
});
