import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateArtifactPath, resolveArtifactContentType } from '../dist/workspace/index.js';

test('artifact paths reject traversal, control characters and the reserved probe area', () => {
  for (const path of ['', '../file', '/file', 'a//b', 'a/./b', 'a/', 'a\\b', 'a\nb', 'a\0b', '\ud800',
    '.oma-workspace-checks', '.oma-workspace-checks/a'])
    assert.throws(() => validateArtifactPath(path), /Invalid artifact path/);
  for (const name of ['README.md', 'mail@example.com', 'x^2.txt', '素材/图 片.png', 'a%2fb'])
    assert.equal(validateArtifactPath(name), name);
});

test('content types keep meaningful metadata and infer common formats', () => {
  assert.equal(resolveArtifactContentType('a.png'), 'image/png');
  assert.equal(resolveArtifactContentType('A.PDF', 'application/octet-stream'), 'application/pdf');
  assert.equal(resolveArtifactContentType('notes.md', 'text/plain'), 'text/markdown; charset=utf-8');
  assert.equal(resolveArtifactContentType('a.png', 'image/webp'), 'image/webp');
  assert.equal(resolveArtifactContentType('data.bin'), 'application/octet-stream');
  assert.equal(resolveArtifactContentType('data.bin', 'text/plain'), 'text/plain');
});
