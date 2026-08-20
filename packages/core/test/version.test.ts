import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, parseVersion, satisfiesRange, sortDescending, unityMajor } from '../src/util/version.ts';

test('orders plain dotted versions', () => {
  assert.equal(compareVersions('5.4.23.5', '5.4.23.4'), 1);
  assert.equal(compareVersions('5.4.23.4', '5.4.23.5'), -1);
  assert.equal(compareVersions('5.6.1', '5.6.1'), 0);
  assert.equal(compareVersions('5.6.0', '5.6'), 0, 'missing trailing components read as zero');
  assert.equal(compareVersions('5.10.0', '5.9.0'), 1, 'numeric, not lexicographic');
});

test('orders Unity build strings including the stream suffix', () => {
  assert.equal(compareVersions('2021.3.16f1', '2021.3.9f1'), 1);
  assert.equal(compareVersions('6000.0.58f2', '2022.3.48f1'), 1);
  assert.equal(compareVersions('2021.3.16b1', '2021.3.16f1'), -1, 'beta sorts below the release build');
  assert.equal(compareVersions('2021.3.16f2', '2021.3.16f1'), 1);
});

test('parses Unity China builds', () => {
  const parsed = parseVersion('2021.3.23f1c1');
  assert.deepEqual(parsed.parts, [2021, 3, 23]);
  assert.equal(parsed.stream, 'f');
  assert.equal(parsed.build, 1);
  assert.equal(compareVersions('2021.3.23f1c1', '2021.3.22f1'), 1);
});

test('orders bleeding-edge builds by build number', () => {
  assert.equal(compareVersions('6.0.0-be.785', '6.0.0-be.733'), 1);
  assert.equal(compareVersions('6.0.0-be.704', '6.0.0-pre.2'), 1, 'higher build wins within the same base version');
  assert.equal(compareVersions('6.0.0-be.785', '5.4.23.5'), 1);
});

test('range checks treat an unknown version as "do not block"', () => {
  assert.equal(satisfiesRange(undefined, { min: '2017.1.0' }), true);
  assert.equal(satisfiesRange('2016.1.0f1', { min: '2017.1.0' }), false);
  assert.equal(satisfiesRange('2021.3.1f1', { min: '2017.1.0' }), true);
  assert.equal(satisfiesRange('2021.3.1f1', { min: '2018.1.0', max: '2018.999' }), false);
  assert.equal(satisfiesRange('2018.4.1f1', { min: '2018.1.0', max: '2018.999' }), true);
});

test('sorts descending and reads the Unity major line', () => {
  assert.deepEqual(sortDescending(['5.4.6', '5.6.1', '5.5.2']), ['5.6.1', '5.5.2', '5.4.6']);
  assert.equal(unityMajor('6000.0.58f2'), 6000);
  assert.equal(unityMajor('2021.3.16f1'), 2021);
  assert.equal(unityMajor(undefined), undefined);
});
