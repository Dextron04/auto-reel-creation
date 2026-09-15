import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveSceneType, sceneMotion} from './scene-registry.mjs';

test('unknown scene types use the safe static fallback', () => {
  assert.equal(resolveSceneType({scene_type: 'does-not-exist'}), 'static');
});

test('known scene types are preserved', () => {
  assert.equal(resolveSceneType({scene_type: 'terminal-demo'}), 'terminal-demo');
  assert.equal(resolveSceneType({scene_type: 'connected-workflow'}), 'connected-workflow');
});

test('existing visual purposes map to motion without prompt changes', () => {
  assert.equal(resolveSceneType({visual_purpose: 'interface'}), 'screenshot-focus');
  assert.equal(resolveSceneType({visual_purpose: 'mechanism'}), 'connected-workflow');
  assert.equal(resolveSceneType({visual_purpose: 'evidence'}), 'metric-counter');
});

test('motion styles are deterministic and differ by scene type', () => {
  const staticStyle = sceneMotion({scene_type: 'static'}, 15, 30);
  const terminalStyle = sceneMotion({scene_type: 'terminal-demo'}, 15, 30);
  assert.notDeepEqual(terminalStyle, staticStyle);
  assert.equal(typeof terminalStyle.transform, 'string');
});

test('static fallback preserves the original gentle zoom', () => {
  const start = sceneMotion({scene_type: 'static', start: 0, end: 4}, 0, 30);
  const entered = sceneMotion({scene_type: 'static', start: 0, end: 4}, 6, 30);
  const end = sceneMotion({scene_type: 'static', start: 0, end: 4}, 120, 30);
  assert.match(start.transform, /scale\(0\.96/);
  assert.equal(entered.transform, 'scale(1.0000)');
  assert.match(end.transform, /scale\(1\.035/);
});
