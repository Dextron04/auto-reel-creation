import test from 'node:test';
import assert from 'node:assert/strict';
import {topicHistoryPath} from './topic-history-path.mjs';

test('topicHistoryPath defaults to the shared history file when no namespace is given', () => {
  assert.equal(topicHistoryPath(), '/media/topic-history.json');
  assert.equal(topicHistoryPath(''), '/media/topic-history.json');
});

test('topicHistoryPath namespaces separate content pipelines into distinct files', () => {
  assert.equal(topicHistoryPath('tips'), '/media/topic-history.tips.json');
});

test('topicHistoryPath rejects a namespace that could escape MEDIA_ROOT', () => {
  assert.throws(() => topicHistoryPath('../../etc/passwd'), /TOPIC_HISTORY_INVALID_NAMESPACE/);
  assert.throws(() => topicHistoryPath('tips/../x'), /TOPIC_HISTORY_INVALID_NAMESPACE/);
});
