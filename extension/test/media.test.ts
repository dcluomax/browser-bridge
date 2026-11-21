import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyAndRankMediaCandidates, parseResolutionFromUrl } from '../src/shared/media_rank.ts';

test('classifies and ranks progressive MP4s, HLS master/variant playlists, and filters fMP4 init/segment chunks', () => {
  const { candidates, observedSegments } = classifyAndRankMediaCandidates([
    // fMP4 init header & .m4s segments must be counted as segments and excluded from downloadable candidates
    {
      url: 'https://video.twimg.com/amplify_video/2123679739806388224/vid/avc1/0/0/468x720/hRDVFlV-CcbMk7tt.mp4',
      source: 'resource_timing',
      frameId: 0,
    },
    {
      url: 'https://video.twimg.com/amplify_video/2123679739806388224/vid/avc1/0/3000/468x720/27M3k9qEc5wmiMCQ.m4s',
      source: 'resource_timing',
      frameId: 0,
    },
    // MSE blob URL (lowest fallback score)
    {
      url: 'blob:https://x.com/9b7d21f0-1234-4a5b-8c9d-abcdef012345',
      source: 'dom',
      frameId: 0,
    },
    // Variant HLS playlist
    {
      url: 'https://video.twimg.com/amplify_video/2123679739806388224/pl/avc1/320x492/OIqdWfI1vFrY6IYJ.m3u8',
      source: 'resource_timing',
      frameId: 0,
    },
    // Master HLS playlist
    {
      url: 'https://video.twimg.com/amplify_video/2123679739806388224/pl/qreVjD___cDEoT7y.m3u8?tag=16&variant_version=1',
      source: 'resource_timing',
      frameId: 0,
    },
    // Progressive MP4 variants from component_state
    {
      url: 'https://video.twimg.com/amplify_video/2123679739806388224/vid/avc1/320x492/low.mp4?tag=16',
      mimeType: 'video/mp4',
      bitrate: 310_000,
      source: 'component_state',
      frameId: 0,
    },
    {
      url: 'https://video.twimg.com/amplify_video/2123679739806388224/vid/avc1/468x720/high.mp4?tag=16',
      mimeType: 'video/mp4',
      bitrate: 832_000,
      source: 'component_state',
      frameId: 0,
    },
  ]);

  assert.equal(observedSegments, 2);
  assert.equal(candidates.length, 5);
  assert.equal(candidates[0].kind, 'progressive');
  assert.match(candidates[0].url, /468x720\/high\.mp4/);
  assert.equal(candidates[0].width, 468);
  assert.equal(candidates[0].height, 720);
  assert.equal(candidates[1].kind, 'progressive');
  assert.match(candidates[1].url, /320x492\/low\.mp4/);
  assert.equal(candidates[2].kind, 'hls_master');
  assert.equal(candidates[3].kind, 'hls_variant');
  assert.equal(candidates[4].kind, 'blob');
  assert.deepEqual(parseResolutionFromUrl('/vid/avc1/1280x720/clip.mp4'), { width: 1280, height: 720 });
});
