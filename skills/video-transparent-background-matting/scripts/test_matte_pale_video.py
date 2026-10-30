#!/usr/bin/env python3
"""Meaningful synthetic regression and short FFmpeg round-trip tests.

Run with --work-dir on authorized writable storage. No network or installation.
"""
import argparse
import contextlib
from fractions import Fraction
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

import numpy as np
from PIL import Image, ImageDraw
import video_matte as helper

WORK=None
FFMPEG=None
FFPROBE=None


def fixture(width=112,height=84,shift=0):
    scale=4
    matte=Image.new('L',(width*scale,height*scale))
    draw=ImageDraw.Draw(matte)
    draw.rounded_rectangle(((18+shift)*scale,10*scale,(89+shift)*scale,73*scale),radius=12*scale,fill=255)
    alpha=np.asarray(matte.resize((width,height),Image.Resampling.LANCZOS),np.float32)/255
    foreground=np.empty((height,width,3),np.float32);foreground[:]=(220,90,20)
    rgb=np.rint(alpha[:,:,None]*foreground+(1-alpha[:,:,None])*255).astype(np.uint8)
    # Enclosed white mouth/eye detail must survive; a different enclosed white
    # opening is removed only when the user explicitly supplies its ROI.
    rgb[26:35,35+shift:50+shift]=255
    rgb[46:57,66+shift:77+shift]=255
    return rgb,alpha


def configuration(**changes):
    defaults=dict(background=(255,255,255),seeds=[(45,42)],edge_radius=2,
                  outer_radius=2,search_radius=6,bleed_radius=2)
    defaults.update(changes)
    return helper.Config(**defaults)


class ImageMattingTests(unittest.TestCase):
    def test_non_square_geometry_white_mouth_and_explicit_negative_space(self):
        rgb,_=fixture()
        engine=helper.Matte(112,84,configuration(holes=[(64,44,15,15)]))
        rgba,statistics=engine(rgb)
        self.assertEqual(rgba.shape,(84,112,4))
        self.assertEqual(int(rgba[30,42,3]),255,'Enclosed mouth white must remain opaque')
        self.assertEqual(int(rgba[51,71,3]),0,'Inspected negative space must open')
        self.assertGreater(statistics['body_pixels'],3000)
        self.assertTrue(np.all(rgba[0,:,3]==0))

    def test_partial_edges_are_straight_alpha_not_dark_premultiplied_rgb(self):
        rgb,true_alpha=fixture()
        rgba,_=helper.Matte(112,84,configuration())(rgb)
        edge=(true_alpha>0.1)&(true_alpha<0.9)
        self.assertGreater(int(edge.sum()),20)
        actual=rgba[:,:,3].astype(float)/255
        self.assertLess(float(np.abs(actual[edge]-true_alpha[edge]).mean()),0.025)
        color=rgba[:,:,:3][edge].astype(int)
        self.assertLess(float(np.abs(color-np.array([220,90,20])).mean()),3)
        # Reconstruction over the original plate matches the observed source.
        rebuilt=np.rint(rgba[:,:,:3]*actual[:,:,None]+255*(1-actual[:,:,None]))
        self.assertLess(float(np.abs(rebuilt[edge]-rgb[edge]).mean()),2)

    def test_writable_component_and_invalid_seed(self):
        raw=np.zeros((39,57),bool);raw[8:31,12:45]=True
        self.assertEqual(int(helper.component(raw,(20,20)).sum()),23*33)
        with self.assertRaises(ValueError):helper.component(raw,(0,0))

    def test_temporal_accent_reference_retains_fade_without_touching_body(self):
        width,height=136,92
        ref=np.full((height,width,3),255,np.uint8)
        ref[16:78,14:85]=(220,90,20)
        ref[10:32,104:124]=(245,210,30)
        faded=ref.copy()
        faded[10:32,104:124]=np.rint(np.array([245,210,30])*.4+255*.6).astype(np.uint8)
        engine=helper.Matte(width,height,configuration(seeds=[(40,40)],accents=[(98,4,34,35)]))
        engine.prepare_accent_reference(ref)
        background=engine.background(faded)
        body,shape,_=engine.body(faded,background)
        accent_only=engine.refine_accents(faded,body,shape,background)
        rgba,_=engine(faded)
        preserved=helper.morph(shape,engine.config.edge_radius,True)
        self.assertTrue(np.array_equal(body[preserved],accent_only[preserved]))
        self.assertAlmostEqual(int(rgba[20,114,3])/255,.4,delta=.02)
        self.assertLess(float(np.abs(rgba[20,114,:3].astype(int)-[245,210,30]).mean()),4)

    def test_accent_overlap_preserves_full_body_band_when_outer_exceeds_edge(self):
        width,height=136,92
        reference=np.full((height,width,3),255,np.uint8)
        reference[16:78,14:85]=(220,90,20)
        # A detached accent lies inside part of the body's wider outer trimap.
        # Its explicit ROI overlaps that band and some body pixels.
        reference[20:42,89:113]=(245,210,30)
        config=configuration(seeds=[(40,40)],edge_radius=1,outer_radius=6,
                             search_radius=8,accents=[(78,12,45,40)])
        engine=helper.Matte(width,height,config)
        engine.prepare_accent_reference(reference)
        plate=engine.background(reference)
        incoming,shape,_=engine.body(reference,plate)
        support=incoming[:,:,3]>0
        beyond_old_preserve=support & ~helper.morph(shape,config.edge_radius,True)
        self.assertTrue(np.any(beyond_old_preserve & engine.accents),
                        'Fixture must expose body alpha beyond the old preserve radius')
        refined=engine.refine_accents(reference,incoming,shape,plate)
        self.assertTrue(np.array_equal(incoming[support],refined[support]),
                        'Accent refinement must preserve every incoming body-alpha pixel')

    def test_frame_pipe_drains_large_stderr_before_stdout_without_deadlock(self):
        program="import os; os.write(2,b'error-detail\\n'*65536); os.write(1,b'frame')"
        pipe=helper.FramePipe([sys.executable,'-c',program],stderr_limit=1024)
        result={}
        reader=threading.Thread(target=lambda:result.setdefault('stdout',pipe.stdout.read(5)),daemon=True)
        reader.start();reader.join(timeout=5)
        if reader.is_alive():
            pipe.process.kill();reader.join(timeout=2);pipe.finish()
            self.fail('stderr blocked stdout: child exceeded pipe-buffer capacity')
        status,summary=pipe.finish()
        self.assertEqual(status,0)
        self.assertEqual(result.get('stdout'),b'frame')
        self.assertTrue(summary)
        self.assertLessEqual(len(summary),1024)
        self.assertIn(b'truncated',summary)
        self.assertIn(b'error-detail',summary)

    def test_storage_safety_rejects_input_within_output(self):
        with tempfile.TemporaryDirectory(dir=WORK) as td:
            root=Path(td);source=root/'source.mp4';source.write_bytes(b'preserve-me')
            with self.assertRaises(ValueError):helper.prepare_destination(source,root,Path(WORK))
            self.assertEqual(source.read_bytes(),b'preserve-me')

    def test_dangling_inspection_symlink_cannot_redirect_a_write(self):
        with tempfile.TemporaryDirectory(dir=WORK) as td:
            root=Path(td);output=root/'result';output.mkdir()
            forbidden=root/'must-not-be-created.json'
            (output/'inspection.json').symlink_to(forbidden)
            with self.assertRaises(ValueError):
                helper.inspection(root/'unused.mp4',output,dict(frames=1,width=112,height=84),FFMPEG)
            self.assertFalse(forbidden.exists())

    def test_finish_returns_failure_when_child_ignores_both_wait_deadlines(self):
        from unittest.mock import Mock
        pipe = helper.FramePipe.__new__(helper.FramePipe)
        pipe.stdout = Mock()
        pipe.process = Mock()
        pipe.process.wait.side_effect = subprocess.TimeoutExpired('stalled-decoder', 1)
        pipe._reader = Mock()
        pipe._reader.is_alive.return_value = False
        pipe._tail = bytearray()
        pipe._total = 0
        pipe.stderr_limit = 1024
        pipe._result = None
        result = pipe.finish()
        self.assertNotEqual(result[0], 0, 'Unreaped child must not be accepted')
        pipe.process.kill.assert_called_once()
        self.assertEqual(pipe.process.wait.call_count, 2)
        for call in pipe.process.wait.call_args_list:
            self.assertGreater(call.kwargs['timeout'], 0)
            self.assertLessEqual(call.kwargs['timeout'], 60)
        self.assertGreater(pipe._reader.join.call_args.kwargs['timeout'], 0)
        self.assertIs(pipe.finish(), result, 'Repeated finish must preserve the original result')
        self.assertEqual(pipe.process.wait.call_count, 2)

    def test_finish_reports_failure_when_stderr_reader_cannot_finish(self):
        from unittest.mock import Mock
        pipe = helper.FramePipe.__new__(helper.FramePipe)
        pipe.stdout = Mock()
        pipe.process = Mock()
        pipe.process.wait.return_value = 0
        pipe._reader = Mock()
        pipe._reader.is_alive.return_value = True
        pipe._tail = bytearray(b'partial decoder diagnostic')
        pipe._total = len(pipe._tail)
        pipe.stderr_limit = 1024
        pipe._result = None
        status, errors = pipe.finish()
        self.assertNotEqual(status, 0, 'A live reader cannot be reported as complete')
        self.assertIn(b'partial decoder diagnostic', errors)
        self.assertGreater(pipe._reader.join.call_args.kwargs['timeout'], 0)
        self.assertLessEqual(pipe._reader.join.call_args.kwargs['timeout'], 60)


class VideoRoundTripTests(unittest.TestCase):
    def roundtrip(self,rate,make_gif=False,wrong_source=False):
        with tempfile.TemporaryDirectory(prefix='matte-e2e-',dir=WORK) as td:
            root=Path(td);inputs=root/'inputs';inputs.mkdir()
            for n in range(6):Image.fromarray(fixture(shift=n%2)[0]).save(inputs/('%06d.png'%n))
            source=root/'source.mp4'
            helper.run([FFMPEG,'-v','error','-n','-framerate',rate,'-i',str(inputs/'%06d.png'),
                        '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration='+str(6/float(Fraction(rate))),
                        '-map','0:v:0','-map','1:a:0','-frames:v','6','-c:v','libx264',
                        '-pix_fmt','yuv420p','-c:a','aac',str(source)])
            before=helper.sha256(source)
            output=root/'result'
            common=['--input',str(source),'--output-dir',str(output),'--storage-root',str(WORK),
                    '--ffmpeg',FFMPEG,'--ffprobe',FFPROBE]
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(helper.main(common+['--mode','inspect']),0)
                self.assertEqual(helper.main(common+['--mode','render','--background','255,255,255',
                                  '--subject-seed','45,42','--hole-roi','64,44,16,16',
                                  '--edge-radius','2','--outer-radius','2','--search-radius','6']+(['--gif'] if make_gif else [])),0)
            report=json.loads((output/'validation.json').read_text())
            self.assertEqual(report['expected_frames'],6)
            self.assertEqual(report['expected_rate'],str(Fraction(rate)))
            self.assertTrue(report['original_audio_packet_hash_preserved'])
            self.assertTrue(report['exports']['transparent.webm']['silent'])
            self.assertFalse(report['exports']['transparent.mov']['silent'])
            self.assertEqual(helper.sha256(source),before)
            self.assertEqual(len(list((output/'frames').glob('*.png'))),6)
            self.assertTrue((output/'source-contact-sheet.png').is_file())
            self.assertTrue((output/'preview-checkerboard.mp4').is_file())
            if make_gif:
                gif=Image.open(output/'transparent.gif')
                self.assertEqual(gif.n_frames,6)
                self.assertEqual(set(np.unique(np.asarray(gif.convert('RGBA'))[:,:,3])),{0,255})
                gif.close()
            original_report=(output/'validation.json').read_bytes()
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(helper.main(common+['--mode','verify']),0)
            self.assertEqual((output/'validation.json').read_bytes(),original_report)
            self.assertEqual(len(list(output.glob('validation-recheck-*.json'))),1)
            if wrong_source:
                # An additional hardlink verifies path independence without duplicating bytes.
                copied=root/'same-bytes-link.mp4';copied.hardlink_to(source)
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(helper.main(['--input',str(copied)]+common[2:]+['--mode','verify']),0)
                altered=root/'different-visual-source.mp4'
                helper.run([FFMPEG,'-v','error','-n','-i',str(source),'-map','0:v:0','-map','0:a:0',
                            '-vf','hue=h=120','-c:v','libx264','-pix_fmt','yuv420p','-c:a','copy',str(altered)])
                self.assertEqual(helper.hash_audio(source,FFMPEG),helper.hash_audio(altered,FFMPEG))
                self.assertNotEqual(helper.sha256(source),helper.sha256(altered))
                current=helper.probe(altered,FFPROBE);original=helper.probe(source,FFPROBE)
                self.assertEqual([current[k] for k in ('width','height','frames','rate')],
                                 [original[k] for k in ('width','height','frames','rate')])
                before_files={str(p.relative_to(output)):helper.sha256(p) for p in output.rglob('*') if p.is_file()}
                with self.assertRaisesRegex(ValueError,'SHA-256'):
                    with contextlib.redirect_stdout(io.StringIO()):
                        helper.main(['--input',str(altered)]+common[2:]+['--mode','verify'])
                after_files={str(p.relative_to(output)):helper.sha256(p) for p in output.rglob('*') if p.is_file()}
                self.assertEqual(before_files,after_files,'Failed identity verification must not write any output')
                render_record=json.loads((output/'render.json').read_text())
                self.assertEqual(report['current_source_sha256'],render_record['source_sha256'])
                self.assertEqual(report['render_source_sha256'],render_record['source_sha256'])
                incorrect_metadata=dict(original,frames=original['frames']+1)
                with self.assertRaisesRegex(ValueError,'metadata'):
                    helper.verify(source,output,incorrect_metadata,FFMPEG,FFPROBE)
                record_path=output/'render.json';pending=output/'render-record-held.json';record_path.rename(pending)
                try:
                    with self.assertRaisesRegex(ValueError,'render.json'):
                        helper.verify(source,output,original,FFMPEG,FFPROBE)
                finally:pending.rename(record_path)
            first=np.asarray(Image.open(output/'frames'/'000000.png'))
            self.assertEqual(int(first[30,42,3]),255)
            self.assertEqual(int(first[51,71,3]),0)
            with self.assertRaises(ValueError):
                with contextlib.redirect_stdout(io.StringIO()):
                    helper.main(common+['--mode','render','--subject-seed','45,42'])
            (Path(WORK)/('synthetic-e2e-'+rate.replace('/','-')+'-validation.json')).write_text(json.dumps(report,indent=2)+'\n')

    def test_short_non768_video_all_frames_audio_silent_webm_and_gif(self):
        self.roundtrip('12',make_gif=True)

    def test_actual_24fps_webm_millisecond_timing_roundtrip(self):
        self.roundtrip('24')

    def test_2997fps_webm_millisecond_timing_roundtrip(self):
        self.roundtrip('30000/1001')

    def test_same_audio_geometry_wrong_visual_source_is_rejected(self):
        self.roundtrip('24',wrong_source=True)


if __name__=='__main__':
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--work-dir',type=Path,required=True)
    ap.add_argument('--ffmpeg',default='ffmpeg');ap.add_argument('--ffprobe',default='ffprobe')
    options,remaining=ap.parse_known_args()
    WORK=str(options.work_dir.expanduser().resolve(strict=True))
    FFMPEG=options.ffmpeg;FFPROBE=options.ffprobe
    unittest.main(argv=[sys.argv[0]]+remaining,verbosity=2)
