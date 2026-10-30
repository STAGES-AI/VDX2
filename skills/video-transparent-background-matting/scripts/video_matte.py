#!/usr/bin/env python3
"""Deterministic, guided matting for a colored subject on a pale, simple plate.

Requires Python 3.9+, NumPy, Pillow, ffmpeg and ffprobe. This is not a universal
segmentation model. Subject seeds must remain inside the subject throughout the
clip. White subject detail connected to the plate cannot be recovered reliably.
Reconstructed alpha/foreground color require visual review on several backgrounds.
"""
import argparse
from dataclasses import dataclass, field
from fractions import Fraction
import hashlib
import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import uuid

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

DEFAULT_STORAGE_ROOT = Path(os.environ['VIDEO_MATTE_STORAGE_ROOT']) if os.environ.get('VIDEO_MATTE_STORAGE_ROOT') else None


def run(command, data=None):
    result = subprocess.run([str(x) for x in command], input=data,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode or result.stderr.strip():
        raise RuntimeError('Command failed or emitted an error: ' +
                           ' '.join(str(x) for x in command[:3]) + '\n' +
                           result.stderr.decode(errors='replace').strip())
    return result.stdout


class FramePipe:
    """Stream frame stdout while concurrently draining a bounded stderr tail.

    No log files or temporary paths. Call finish() in a finally block even when
    frame processing raises, so pipe handles and the child are always collected.
    """
    def __init__(self, command, stderr_limit=16384):
        if stderr_limit < 256:
            raise ValueError('stderr summary limit must be at least 256 bytes')
        self.process = subprocess.Popen([str(x) for x in command], stdin=subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.stdout = self.process.stdout
        self.stderr_limit = stderr_limit
        self._tail = bytearray()
        self._total = 0
        self._result = None
        self._reader = threading.Thread(target=self._drain_stderr, daemon=True)
        self._reader.start()

    def _drain_stderr(self):
        try:
            while True:
                block = self.process.stderr.read(8192)
                if not block:
                    break
                self._total += len(block)
                self._tail.extend(block)
                if len(self._tail) > self.stderr_limit:
                    del self._tail[:-self.stderr_limit]
        finally:
            self.process.stderr.close()

    def finish(self):
        if self._result is not None:
            return self._result
        self.stdout.close()
        try:
            status = self.process.wait(timeout=60)
        except subprocess.TimeoutExpired:
            try:
                self.process.kill()
            except ProcessLookupError:
                pass
            try:
                status = self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                status = -1
        self._reader.join(timeout=5)
        if self._reader.is_alive():
            status = -1
        summary = bytes(self._tail)
        if self._total > self.stderr_limit:
            prefix = ('[stderr truncated: %d bytes total; tail follows]\n' % self._total).encode()
            summary = prefix + summary[-(self.stderr_limit-len(prefix)):]
        self._result = (status, summary)
        return self._result


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def probe(path, ffprobe):
    info = json.loads(run([ffprobe, '-v', 'error', '-show_streams', '-show_format',
                           '-of', 'json', path]))
    videos = [s for s in info['streams'] if s['codec_type'] == 'video']
    if len(videos) != 1:
        raise ValueError('Exactly one video stream is required')
    v = videos[0]
    audio_streams = [s for s in info['streams'] if s['codec_type'] == 'audio']
    if len(audio_streams) > 1:
        raise ValueError('Multiple audio tracks require an explicit track-selection workflow')
    if v.get('color_transfer') in ('smpte2084', 'arib-std-b67'):
        raise ValueError('HDR video requires an explicit color-managed workflow before SDR matting')
    try:
        rate = Fraction(v.get('avg_frame_rate', '0/1'))
    except (ValueError, ZeroDivisionError):
        raise ValueError('No usable average frame rate')
    if rate <= 0:
        raise ValueError('No usable average frame rate')
    # Reading timestamps establishes the frame count and rejects unsupported VFR.
    timing = json.loads(run([ffprobe, '-v', 'error', '-select_streams', 'v:0',
                            '-show_frames', '-show_entries',
                            'frame=best_effort_timestamp_time', '-of', 'json', path]))
    times = [float(f['best_effort_timestamp_time']) for f in timing['frames']]
    if not times:
        raise ValueError('No decoded video frames')
    step = 1 / float(rate)
    tick = abs(float(Fraction(v.get('time_base', '1/1000000'))))
    tolerance = max(0.000002, tick + 0.000002)
    if abs(times[0]) > tolerance:
        raise ValueError('Nonzero video start time needs an explicit timing workflow')
    if any(abs(observed - index * step) > tolerance for index, observed in enumerate(times)):
        raise ValueError('Variable frame rate needs an explicit timing workflow')
    rotations = [int(s.get('rotation', 0)) for s in v.get('side_data_list', [])]
    if any(r % 360 for r in rotations) or int(v.get('tags', {}).get('rotate', 0)) % 360:
        raise ValueError('Rotated video requires an explicitly oriented source first')
    return dict(width=int(v['width']), height=int(v['height']),
                rate=str(rate), time_base=v.get('time_base'), frames=len(times), video_codec=v['codec_name'],
                audio=any(s['codec_type'] == 'audio' for s in info['streams']),
                duration=float(info['format'].get('duration', len(times) * step)))


def read_frame(source, index, width, height, ffmpeg):
    data = run([ffmpeg, '-v', 'error', '-noautorotate', '-i', source,
                '-vf', 'select=eq(n\\,%d)' % index, '-frames:v', '1',
                '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
    if len(data) != width * height * 3:
        raise RuntimeError('Reference frame did not decode completely')
    return np.frombuffer(data, np.uint8).reshape(height, width, 3).copy()


def morph(mask, radius, dilate=False):
    if radius == 0:
        return mask.copy()
    filt = ImageFilter.MaxFilter(2 * radius + 1) if dilate else ImageFilter.MinFilter(2 * radius + 1)
    return np.asarray(Image.fromarray(mask.astype(np.uint8) * 255).filter(filt)) > 0


def component(mask, seed):
    x, y = seed
    h, w = mask.shape
    if not (0 <= x < w and 0 <= y < h) or not mask[y, x]:
        raise ValueError('Subject seed %s is outside the visible foreground' % (seed,))
    # fromarray may expose a read-only array-backed image; copy is essential.
    image = Image.fromarray(mask.astype(np.uint8) * 255).copy()
    ImageDraw.floodfill(image, (x, y), 128)
    result = np.asarray(image) == 128
    if not result.any():
        raise RuntimeError('Subject component flood fill did not mutate the image')
    return result


def fill_holes(mask):
    h, w = mask.shape
    image = Image.fromarray(mask.astype(np.uint8) * 255).copy()
    border = [(x, 0) for x in range(w)] + [(x, h - 1) for x in range(w)]
    border += [(0, y) for y in range(h)] + [(w - 1, y) for y in range(h)]
    for point in border:
        if image.getpixel(point) == 0:
            ImageDraw.floodfill(image, point, 128)
    return np.asarray(image) != 128


def rectangle_mask(shape, rectangles):
    h, w = shape
    result = np.zeros(shape, bool)
    for x, y, rw, rh in rectangles:
        if min(x, y) < 0 or min(rw, rh) <= 0 or x + rw > w or y + rh > h:
            raise ValueError('ROI is outside the inspected video: %s' % ((x, y, rw, rh),))
        result[y:y + rh, x:x + rw] = True
    return result


@dataclass
class Config:
    background: tuple = (250, 250, 250)
    seeds: list = field(default_factory=list)
    holes: list = field(default_factory=list)
    accents: list = field(default_factory=list)
    background_tolerance: float = 18
    foreground_distance: float = 18
    edge_radius: int = 5
    outer_radius: int = 3
    search_radius: int = 14
    alpha_cutoff: float = 0.018
    accent_reference_contrast: float = 160
    bleed_radius: int = 2


class Matte:
    def __init__(self, width, height, config):
        self.w, self.h, self.config = width, height, config
        if min(config.background) < 200 or max(config.background) > 255:
            raise ValueError('This helper supports pale gray/white plates only (RGB >=200)')
        if not all(math.isfinite(v) and v > 0 for v in (config.background_tolerance, config.foreground_distance, config.accent_reference_contrast)):
            raise ValueError('Color thresholds must be finite positive numbers')
        if not config.seeds:
            raise ValueError('Render requires an inspected subject seed')
        for radius in (config.edge_radius, config.outer_radius, config.search_radius, config.bleed_radius):
            if radius < 0 or radius > max(width, height):
                raise ValueError('Invalid morphology/search radius')
        if config.search_radius < max(config.edge_radius, config.outer_radius):
            raise ValueError('Search radius must cover the selected edge band')
        if not 0 < config.alpha_cutoff < 0.2:
            raise ValueError('Alpha cutoff must be between zero and 0.2')
        y, x = np.mgrid[:height, :width]
        xn = (x - width / 2) / width; yn = (y - height / 2) / height
        self.basis = np.stack([np.ones_like(xn), xn, yn, xn*xn, xn*yn, yn*yn], -1).astype(np.float32)
        self.holes = rectangle_mask((height, width), config.holes)
        self.accents = rectangle_mask((height, width), config.accents)
        r = config.search_radius
        self.offsets = sorted([(dy, dx) for dy in range(-r, r + 1)
                               for dx in range(-r, r + 1) if dx*dx + dy*dy <= r*r],
                              key=lambda q: q[0]*q[0] + q[1]*q[1])
        self.palette = None

    def background(self, rgb):
        v = rgb.astype(np.float32)
        good = np.max(np.abs(v - np.array(self.config.background)), 2) < self.config.background_tolerance
        stride = max(1, min(self.w, self.h) // 64)
        sample = good[::stride, ::stride]
        design = self.basis[::stride, ::stride][sample]
        if len(design) < 24 or np.linalg.matrix_rank(design) < 6:
            raise ValueError('Insufficient pale plate samples; inspect background color/tolerance')
        values = v[::stride, ::stride][sample]
        coefficients = np.linalg.lstsq(design, values, rcond=None)[0]
        return np.clip(self.basis @ coefficients, 200, 255)

    def silhouette(self, rgb, background):
        distance = np.linalg.norm(rgb.astype(np.float32) - background, axis=2)
        raw = distance > self.config.foreground_distance
        filled = fill_holes(raw)
        # Only user-inspected ROIs can reopen an enclosed white negative space.
        filled[self.holes & ~raw] = False
        body = np.zeros_like(filled)
        for seed in self.config.seeds:
            body |= component(filled, seed)
        return body

    def nearest(self, support, ys, xs, colors):
        guide = np.zeros((len(ys), 3), np.float32)
        pending = np.ones(len(ys), bool)
        for dy, dx in self.offsets:
            ids = np.flatnonzero(pending)
            if not len(ids): break
            sy = np.clip(ys[ids] + dy, 0, self.h - 1)
            sx = np.clip(xs[ids] + dx, 0, self.w - 1)
            hit = support[sy, sx]
            found = ids[hit]
            guide[found] = colors[sy[hit], sx[hit]]
            pending[found] = False
        return guide, pending

    def body(self, rgb, background):
        v = rgb.astype(np.float32)
        shape = self.silhouette(rgb, background)
        core = morph(shape, self.config.edge_radius)
        if not core.any():
            raise ValueError('No opaque core; reduce edge radius or use another matting method')
        band = morph(shape, self.config.outer_radius, True) & ~core
        ys, xs = np.nonzero(band)
        guide, pending = self.nearest(core, ys, xs, v)
        guide[pending] = v[ys[pending], xs[pending]]
        observed = v[ys, xs]; plate = background[ys, xs]
        d = guide - plate
        a = np.clip(((observed - plate) * d).sum(1) / np.maximum((d*d).sum(1), 1), 0, 1)
        a[pending] = shape[ys[pending], xs[pending]]
        a[a < self.config.alpha_cutoff] = 0; a[a > 0.995] = 1
        alpha = np.zeros((self.h, self.w), np.float32)
        alpha[core] = 1; alpha[ys, xs] = a
        color = v.copy()
        corrected = np.clip((observed - (1-a[:, None]) * plate) / np.maximum(a[:, None], self.config.alpha_cutoff), 0, 255)
        weight = np.clip(a / 0.20, 0, 1)[:, None]
        color[ys, xs] = corrected * weight + guide * (1-weight)
        color[alpha == 0] = 0
        rgba = np.dstack((np.rint(color).astype(np.uint8), np.rint(alpha*255).astype(np.uint8)))
        return rgba, shape, int(pending.sum())

    def prepare_accent_reference(self, rgb):
        background = self.background(rgb)
        body = self.silhouette(rgb, background)
        preserve_radius = max(self.config.edge_radius, self.config.outer_radius)
        region = self.accents & ~morph(body, preserve_radius, True)
        distance = np.linalg.norm(background - rgb.astype(np.float32), axis=2)
        samples = region & (distance > self.config.accent_reference_contrast)
        samples = morph(samples, 1)
        colors = rgb[samples].astype(np.float32)
        deltas = (background - rgb.astype(np.float32))[samples]
        if len(colors) < 3:
            raise ValueError('Accent reference lacks clearly visible, high-contrast accent samples')
        directions = deltas / np.maximum(np.linalg.norm(deltas, axis=1, keepdims=True), 1)
        count = min(24, len(colors))
        order = np.argsort(directions[:, 1])
        centers = directions[order[np.linspace(0, len(order)-1, count).astype(int)]].copy()
        for _ in range(8):
            labels = ((directions[:, None] - centers[None])**2).sum(2).argmin(1)
            for k in range(count):
                if np.any(labels == k): centers[k] = directions[labels == k].mean(0)
        palette = []
        strength = np.linalg.norm(deltas, axis=1)
        for k, center in enumerate(centers):
            ids = np.flatnonzero(labels == k)
            if not len(ids): continue
            score = ((directions[ids] - center)**2).sum(1)
            score += 0.00001 * (strength[ids] - np.median(strength[ids]))**2
            palette.append(colors[ids[score.argmin()]])
        self.palette = np.asarray(palette, np.float32)

    def refine_accents(self, rgb, rgba, shape, background):
        if not self.accents.any(): return rgba
        if self.palette is None:
            raise ValueError('Accent ROIs require a measured reference frame')
        v = rgb.astype(np.float32); delta = background - v
        distance = np.linalg.norm(delta, axis=2)
        preserve_radius = max(self.config.edge_radius, self.config.outer_radius)
        preserve = morph(shape, preserve_radius, True) | (rgba[:, :, 3] > 0)
        allowed = self.accents & ~preserve
        candidate = allowed & (distance > 3)
        support = candidate & (distance > self.config.foreground_distance)
        # Reconstruct connected faint colored edges from visible accent seeds.
        for _ in range(max(self.w, self.h)):
            grown = morph(support, 1, True) & candidate
            if np.array_equal(grown, support): break
            support = grown
        result = rgba.copy()
        ys, xs = np.nonzero(support)
        if not len(ys): return result
        observed = v[ys, xs]; plate = background[ys, xs]
        d = plate - observed
        directions = d / np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1)
        guides = plate[:, None] - self.palette[None]
        unit = guides / np.maximum(np.linalg.norm(guides, axis=2, keepdims=True), 1)
        best = ((unit - directions[:, None])**2).sum(2).argmin(1)
        foreground = self.palette[best]; guide_delta = plate - foreground
        a = np.clip((d*guide_delta).sum(1)/np.maximum((guide_delta*guide_delta).sum(1), 1), 0, 1)
        a[a < max(self.config.alpha_cutoff, 0.025)] = 0; a[a > 0.995] = 1
        corrected = np.clip((observed-(1-a[:, None])*plate)/np.maximum(a[:, None], 0.018), 0, 255)
        weight = np.clip(a/0.20, 0, 1)[:, None]
        corrected = corrected*weight + foreground*(1-weight)
        result[ys, xs, :3] = np.rint(corrected).astype(np.uint8)
        result[ys, xs, 3] = np.rint(a*255).astype(np.uint8)
        return result

    def __call__(self, rgb):
        background = self.background(rgb)
        rgba, shape, pending = self.body(rgb, background)
        rgba = self.refine_accents(rgb, rgba, shape, background)
        support = rgba[:, :, 3] > 0
        if self.config.bleed_radius:
            ys, xs = np.nonzero(morph(support, self.config.bleed_radius, True) & ~support)
            guide, unresolved = self.nearest(support, ys, xs, rgba[:, :, :3])
            rgba[ys[~unresolved], xs[~unresolved], :3] = guide[~unresolved].astype(np.uint8)
        return rgba, dict(opaque=int((rgba[:, :, 3] == 255).sum()),
                          partial=int(((rgba[:, :, 3] > 0) & (rgba[:, :, 3] < 255)).sum()),
                          body_pixels=int(shape.sum()), unsupported_edge_pixels=pending)


def parse_numbers(text, length):
    try: values = tuple(int(x) for x in text.split(','))
    except ValueError: raise argparse.ArgumentTypeError('Use comma-separated integers')
    if len(values) != length: raise argparse.ArgumentTypeError('Expected %d integers' % length)
    return values


def prepare_destination(source, output, storage):
    source = source.expanduser().resolve(strict=True)
    output = output.expanduser().resolve()
    storage = storage.expanduser().resolve(strict=True)
    if not storage.is_dir() or (output != storage and storage not in output.parents):
        raise ValueError('Output must remain beneath the available authorized storage root')
    if source == output or output in source.parents:
        raise ValueError('Input must be outside the output directory; input overwrite is forbidden')
    output.mkdir(parents=True, exist_ok=True)
    return source, output


def inspection(source, output, meta, ffmpeg):
    paths = [output/'inspection.json', output/'source-contact-sheet.png']
    if any(p.exists() or p.is_symlink() for p in paths):
        raise ValueError('Inspection output already exists; select a new output directory')
    count = min(9, meta['frames'])
    indices = sorted(set(np.linspace(0, meta['frames']-1, count).astype(int).tolist()))
    columns = min(3, len(indices)); rows = math.ceil(len(indices)/columns)
    thumb_w = min(320, meta['width']); thumb_h = max(1, round(meta['height']*thumb_w/meta['width']))
    expression = '+'.join('eq(n\\,%d)' % n for n in indices)
    vf = 'select=%s,scale=%d:%d,tile=%dx%d' % (expression, thumb_w, thumb_h, columns, rows)
    png = run([ffmpeg, '-v', 'error', '-noautorotate', '-i', source,
               '-vf', vf, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'])
    with paths[1].open('xb') as handle: handle.write(png)
    report = dict(source=str(source), source_sha256=sha256(source), metadata=meta,
                  sampled_frames=indices, scope='Pale simple plate; inspect seed/edge/hole/accent geometry before render')
    with paths[0].open('x', encoding='utf-8') as handle: handle.write(json.dumps(report, indent=2)+'\n')
    return report


def hash_audio(path, ffmpeg):
    return run([ffmpeg, '-v', 'error', '-i', path, '-map', '0:a:0', '-c:a', 'copy',
                '-f', 'hash', '-hash', 'sha256', 'pipe:1']).decode().strip()


def verify(source, output, meta, ffmpeg, ffprobe):
    record_path = output/'render.json'
    if not record_path.is_file():
        raise ValueError('Verification requires the recorded render.json source identity')
    try:
        recorded = json.loads(record_path.read_text(encoding='utf-8'))
    except (ValueError, OSError) as error:
        raise ValueError('Cannot read the recorded render identity: '+str(error))
    current_source_hash = sha256(source)
    render_source_hash = recorded.get('source_sha256')
    if current_source_hash != render_source_hash:
        raise ValueError('Current input SHA-256 does not match the recorded render source')
    if recorded.get('metadata') != meta:
        raise ValueError('Current input metadata does not match the recorded render source metadata')
    report = dict(current_source_sha256=current_source_hash,
                  render_source_sha256=render_source_hash,
                  expected_frames=meta['frames'], expected_rate=meta['rate'], exports={})
    for name, decoder in [('transparent.mov', []), ('transparent.webm', ['-c:v', 'libvpx-vp9'])]:
        path = output/name
        details = probe(path, ffprobe)
        if (details['width'], details['height'], details['frames'], details['rate']) != (meta['width'], meta['height'], meta['frames'], meta['rate']):
            raise RuntimeError('Export geometry, timing or frame count changed: '+name)
        if name.endswith('.webm') and details['audio']:
            raise RuntimeError('Browser WebM must be explicitly silent')
        proc = FramePipe([ffmpeg, '-v', 'error', *decoder, '-i', str(path),
                          '-map', '0:v:0', '-vf', 'alphaextract,format=gray',
                          '-an', '-f', 'rawvideo', 'pipe:1'])
        count=0; total=0; maximum=0; partial=0; border=0
        try:
            while True:
                data=proc.stdout.read(meta['width']*meta['height'])
                if not data: break
                if len(data) != meta['width']*meta['height']: raise RuntimeError('Truncated decoded alpha')
                if count >= meta['frames']: raise RuntimeError('Extra export frame')
                actual=np.frombuffer(data,np.uint8).reshape(meta['height'],meta['width'])
                reference=np.asarray(Image.open(output/'frames'/('%06d.png'%count)))[:,:,3]
                error=np.abs(actual.astype(int)-reference.astype(int))
                maximum=max(maximum,int(error.max()));total+=int(error.sum())
                partial+=int(((actual>0)&(actual<255)).sum())
                border+=int((actual[0]>0).sum()+(actual[-1]>0).sum()+(actual[:,0]>0).sum()+(actual[:,-1]>0).sum())
                count+=1
        finally:
            status, errors = proc.finish()
        if status or errors.strip() or count != meta['frames'] or maximum>2:
            raise RuntimeError('Export alpha verification failed: '+name+' '+errors.decode(errors='replace'))
        report['exports'][name]=dict(frames=count, dimensions=[meta['width'],meta['height']],
                                    decoded_alpha_max_error_8bit=maximum,
                                    decoded_alpha_mean_error_8bit=total/(count*meta['width']*meta['height']),
                                    partial_alpha_pixels=partial, nontransparent_border_samples=border,
                                    silent=not details['audio'], bytes=path.stat().st_size, sha256=sha256(path))
    report['original_audio_packet_hash_preserved'] = (hash_audio(source,ffmpeg)==hash_audio(output/'transparent.mov',ffmpeg)) if meta['audio'] else None
    if meta['audio'] and not report['original_audio_packet_hash_preserved']:
        raise RuntimeError('Master did not preserve original compressed audio packet bytes')
    if sha256(source) != current_source_hash:
        raise RuntimeError('Source changed during verification; no validation report was written')
    report['visual_review_required']=True
    report['limitations']='Reconstructed alpha is an estimate. Numeric checks do not establish artifact-free edges, correct negative spaces, playback support, or user acceptance.'
    destination = output/'validation.json'
    if destination.exists() or destination.is_symlink():
        destination = output/('validation-recheck-'+uuid.uuid4().hex+'.json')
    with destination.open('x', encoding='utf-8') as handle: handle.write(json.dumps(report,indent=2)+'\n')
    return report


def render(source, output, meta, args):
    reserved = ['frames','transparent.mov','transparent.webm','preview-checkerboard.mp4','checkerboard.png','render.json','validation.json','transparent.gif']
    if any((output/name).exists() or (output/name).is_symlink() for name in reserved):
        raise ValueError('Render output already exists; select a new output directory')
    if meta['width']%2 or meta['height']%2:
        raise ValueError('Silent 4:2:0 WebM needs even source dimensions; no implicit resize is performed')
    source_hash=sha256(source)
    config=Config(background=args.background,seeds=args.subject_seed,holes=args.hole_roi,accents=args.accent_roi,
                  background_tolerance=args.background_tolerance,foreground_distance=args.foreground_distance,
                  edge_radius=args.edge_radius,outer_radius=args.outer_radius,search_radius=args.search_radius,
                  alpha_cutoff=args.alpha_cutoff,accent_reference_contrast=args.accent_reference_contrast,
                  bleed_radius=args.bleed_radius)
    engine=Matte(meta['width'],meta['height'],config)
    if config.accents:
        if args.accent_reference is None or not 0<=args.accent_reference<meta['frames']:
            raise ValueError('Accent ROIs require an in-range --accent-reference frame index')
        reference=read_frame(source,args.accent_reference,meta['width'],meta['height'],args.ffmpeg)
        engine.prepare_accent_reference(reference)
    elif args.accent_reference is not None:
        raise ValueError('Accent reference requires explicit --accent-roi')
    frames=output/'frames';frames.mkdir()
    proc=FramePipe([args.ffmpeg,'-v','error','-noautorotate','-i',str(source),'-map','0:v:0',
                    '-an','-f','rawvideo','-pix_fmt','rgb24','pipe:1'])
    stats=[];start=time.time()
    try:
        while True:
            data=proc.stdout.read(meta['width']*meta['height']*3)
            if not data: break
            if len(data)!=meta['width']*meta['height']*3:raise RuntimeError('Truncated source frame')
            if len(stats)>=meta['frames']:raise RuntimeError('Source frame count changed')
            rgb=np.frombuffer(data,np.uint8).reshape(meta['height'],meta['width'],3)
            rgba,stat=engine(rgb)
            Image.fromarray(rgba).save(frames/('%06d.png'%len(stats)),compress_level=3)
            stat['frame']=len(stats);stats.append(stat)
    finally:
        status, errors = proc.finish()
    if status or errors.strip() or len(stats)!=meta['frames']:
        raise RuntimeError('Source decode/frame count failed: '+errors.decode(errors='replace'))
    base=[args.ffmpeg,'-v','error','-n','-framerate',meta['rate'],'-i',str(frames/'%06d.png')]
    master=base+['-i',str(source),'-map','0:v:0','-map','1:a:0?','-map_metadata','-1',
                 '-c:v','prores_ks','-profile:v','4','-qscale:v','5','-pix_fmt','yuva444p10le',
                 '-alpha_bits','16','-c:a','copy',str(output/'transparent.mov')]
    run(master)
    run(base+['-map','0:v:0','-an','-c:v','libvpx-vp9','-lossless','1','-b:v','0',
              '-pix_fmt','yuva420p','-auto-alt-ref','0','-deadline','good','-cpu-used','4',
              '-row-mt','1','-threads','4',str(output/'transparent.webm')])
    y,x=np.mgrid[:meta['height'],:meta['width']]
    cell=max(4,min(meta['width'],meta['height'])//24)
    checker=np.where(((x//cell+y//cell)%2)[:,:,None],np.array([185,185,185]),np.array([225,225,225])).astype(np.uint8)
    Image.fromarray(checker).save(output/'checkerboard.png')
    run([args.ffmpeg,'-v','error','-n','-framerate',meta['rate'],'-loop','1','-i',str(output/'checkerboard.png'),
         '-i',str(output/'transparent.mov'),'-filter_complex','[0:v][1:v]overlay=shortest=1:format=auto,format=yuv420p[v]',
         '-map','[v]','-map','1:a:0?','-c:v','libx264','-crf','18','-preset','fast','-c:a','copy',
         '-movflags','+faststart',str(output/'preview-checkerboard.mp4')])
    if args.gif:
        print('GIF WARNING: palette colors, binary transparency and centisecond timing cannot preserve the master\'s smooth alpha/colors/timing.',file=sys.stderr)
        run([args.ffmpeg,'-v','error','-n','-i',str(output/'transparent.mov'),'-an','-filter_complex',
             '[0:v]split[a][b];[a]palettegen=reserve_transparent=1:stats_mode=full[p];[b][p]paletteuse=alpha_threshold=128:dither=bayer',
             str(output/'transparent.gif')])
    if sha256(source) != source_hash:
        raise RuntimeError('Source changed during rendering; outputs remain unaccepted')
    record=dict(source=str(source),source_sha256=source_hash,metadata=meta,configuration=vars(config),
                measured_accent_palette=engine.palette.astype(int).tolist() if engine.palette is not None else None,
                seconds=time.time()-start,frame_statistics=stats,
                gif_limitations='GIF uses binary alpha, indexed color and centisecond timing' if args.gif else None)
    with (output/'render.json').open('x', encoding='utf-8') as handle: handle.write(json.dumps(record,indent=2)+'\n')
    return verify(source,output,meta,args.ffmpeg,args.ffprobe)


def parser():
    p=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--input',type=Path,required=True)
    p.add_argument('--output-dir',type=Path,required=True)
    p.add_argument('--storage-root',type=Path,default=DEFAULT_STORAGE_ROOT,required=DEFAULT_STORAGE_ROOT is None,help='Authorized output root (or VIDEO_MATTE_STORAGE_ROOT); never silently falls back')
    p.add_argument('--ffmpeg',default='ffmpeg');p.add_argument('--ffprobe',default='ffprobe')
    p.add_argument('--mode',choices=['inspect','render','verify'],required=True)
    p.add_argument('--background',type=lambda s:parse_numbers(s,3),default=(250,250,250),help='Inspected pale RGB, e.g. 250,250,250')
    p.add_argument('--subject-seed',type=lambda s:parse_numbers(s,2),action='append',default=[],help='X,Y inside subject on every frame; repeat for separate parts')
    p.add_argument('--hole-roi',type=lambda s:parse_numbers(s,4),action='append',default=[],help='Explicit inspected X,Y,W,H negative-space ROI; never cover mouth/eye whites')
    p.add_argument('--accent-roi',type=lambda s:parse_numbers(s,4),action='append',default=[],help='Explicit detached-accent X,Y,W,H bounds over full motion')
    p.add_argument('--accent-reference',type=int,help='Zero-based fully visible source reference frame')
    p.add_argument('--background-tolerance',type=float,default=18)
    p.add_argument('--foreground-distance',type=float,default=18)
    p.add_argument('--edge-radius',type=int,default=5);p.add_argument('--outer-radius',type=int,default=3)
    p.add_argument('--search-radius',type=int,default=14);p.add_argument('--bleed-radius',type=int,default=2)
    p.add_argument('--alpha-cutoff',type=float,default=0.018)
    p.add_argument('--accent-reference-contrast',type=float,default=160)
    p.add_argument('--gif',action='store_true',help='Optional visibly quantized silent GIF; master remains authoritative')
    return p


def main(argv=None):
    args=parser().parse_args(argv)
    source,output=prepare_destination(args.input,args.output_dir,args.storage_root)
    meta=probe(source,args.ffprobe)
    if args.mode=='inspect':report=inspection(source,output,meta,args.ffmpeg)
    elif args.mode=='verify':report=verify(source,output,meta,args.ffmpeg,args.ffprobe)
    else:report=render(source,output,meta,args)
    print(json.dumps(report,indent=2))
    return 0


if __name__=='__main__':
    try:sys.exit(main())
    except (ValueError,RuntimeError,FileNotFoundError) as error:
        print('ERROR: '+str(error),file=sys.stderr);sys.exit(1)
