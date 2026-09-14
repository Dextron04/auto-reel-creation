import test from 'node:test';
import assert from 'node:assert/strict';

import {executionDisclosure, videoDisclosure} from './public/presenters.mjs';

test('executionDisclosure keeps the scan line compact and expands into operational details', () => {
  const html = executionDisclosure({
    status: 'error',
    statusLabel: 'Failed',
    started: '1:19 PM',
    duration: '3m 44s',
    mode: 'Manual',
    node: 'Generate dialogue WAV',
    error: 'Service failed <retry>',
    id: '38',
  });

  assert.match(html, /<details class="mobile-record execution-record">/);
  assert.match(html, /<summary[\s\S]*Failed[\s\S]*1:19 PM[\s\S]*Generate dialogue WAV[\s\S]*<\/summary>/);
  assert.match(html, /Duration[\s\S]*3m 44s/);
  assert.match(html, /Mode[\s\S]*Manual/);
  assert.match(html, /Execution[\s\S]*#38/);
  assert.match(html, /Service failed &lt;retry&gt;/);
});

test('videoDisclosure provides a thumb-sized expandable row with an inline player', () => {
  const html = videoDisclosure({
    file: 'reel.mp4',
    created: 'Sep 14, 1:26 PM',
    duration: '51.4s',
    size: '62.8 MB',
    url: '/videos/reel.mp4',
  });

  assert.match(html, /<details class="mobile-record video-record">/);
  assert.match(html, /<summary[\s\S]*reel\.mp4[\s\S]*51\.4s[\s\S]*<\/summary>/);
  assert.match(html, /<video controls preload="none" src="\/videos\/reel\.mp4"><\/video>/);
});
