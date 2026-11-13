import { describe, expect, it } from 'vitest';
import {
  compareNames,
  fileExtension,
  firstLine,
  formatBytes,
  formatDuration,
  shapeLabel,
  storageExtension,
  videoTypeFor,
} from './format';
import { rejectionMessage, screenFiles } from './select';
import { applyOrder, detectOrder, moveKey, sortForMode } from './order';

describe('formatBytes / formatDuration', () => {
  it('formats sizes in binary units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(45.2 * 1024 * 1024)).toBe('45.2 MB');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GB');
    expect(formatBytes(-1)).toBe('—');
  });

  it('formats durations as m:ss or h:mm:ss', () => {
    expect(formatDuration(58_000)).toBe('0:58');
    expect(formatDuration(72_400)).toBe('1:12');
    expect(formatDuration(59_600)).toBe('1:00');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
    expect(formatDuration(null)).toBe('—');
  });
});

describe('shapeLabel', () => {
  it('names common shapes within 3 %', () => {
    expect(shapeLabel(1080, 1920)).toBe('9:16');
    expect(shapeLabel(720, 1280)).toBe('9:16');
    expect(shapeLabel(1080, 1350)).toBe('4:5');
    expect(shapeLabel(1080, 1080)).toBe('1:1');
    expect(shapeLabel(1920, 1080)).toBe('16:9');
    expect(shapeLabel(1440, 1080)).toBe('4:3');
  });

  it('falls back to a ratio against 9 for unusual sizes', () => {
    expect(shapeLabel(1080, 2340)).toBe('9:19.5');
    expect(shapeLabel(2560, 1080)).toBe('21.3:9');
    expect(shapeLabel(null, 1920)).toBeNull();
    expect(shapeLabel(0, 0)).toBeNull();
  });
});

describe('video types', () => {
  it('accepts mp4 and mov by MIME type or extension', () => {
    expect(videoTypeFor('a.mp4', 'video/mp4')).toBe('video/mp4');
    expect(videoTypeFor('a.MOV', '')).toBe('video/quicktime');
    expect(videoTypeFor('a.m4v', 'video/x-m4v')).toBe('video/mp4');
    expect(videoTypeFor('a.mov', 'application/octet-stream')).toBe('video/quicktime');
    expect(videoTypeFor('a.webm', 'video/webm')).toBeNull();
    expect(videoTypeFor('a.pdf', '')).toBeNull();
  });

  it('stores the original under a matching extension', () => {
    expect(fileExtension('Clip.Final.MP4')).toBe('mp4');
    expect(fileExtension('noext')).toBe('');
    expect(storageExtension('clip.m4v', 'video/mp4')).toBe('m4v');
    expect(storageExtension('clip', 'video/quicktime')).toBe('mov');
    expect(storageExtension('clip.mov', 'video/mp4')).toBe('mp4');
  });
});

describe('compareNames / firstLine', () => {
  it('sorts filenames naturally', () => {
    const names = ['clip 10.mp4', 'Clip 2.mp4', 'clip 1.mp4', '01_beach.mp4'];
    expect([...names].sort(compareNames)).toEqual([
      '01_beach.mp4',
      'clip 1.mp4',
      'Clip 2.mp4',
      'clip 10.mp4',
    ]);
  });

  it('takes the first non-empty line and cuts it', () => {
    expect(firstLine('\n  Socha tha normal sunset hoga…\nphir ye hua 😳')).toBe(
      'Socha tha normal sunset hoga…',
    );
    expect(firstLine('a'.repeat(100), 10)).toBe(`${'a'.repeat(9)}…`);
    expect(firstLine(null)).toBe('');
  });
});

describe('screenFiles', () => {
  const f = (name: string, size: number, type = '') => ({ name, size, type });

  it('accepts videos and explains rejections', () => {
    const out = screenFiles([
      f('a.mp4', 10, 'video/mp4'),
      f('b.pdf', 10, 'application/pdf'),
      f('c.mov', 0),
      f('d.mov', 3 * 1024 ** 3),
    ]);
    expect(out.accepted.map((a) => [a.file.name, a.type])).toEqual([['a.mp4', 'video/mp4']]);
    expect(out.rejected.map((r) => r.reason)).toEqual([
      'not an MP4 or MOV video',
      'the file is empty',
      'larger than 2.0 GB',
    ]);
    expect(rejectionMessage(out.rejected)).toBe(
      'Skipped b.pdf: not an MP4 or MOV video; c.mov: the file is empty; and 1 more.',
    );
  });

  it('caps a drop at maxFiles', () => {
    const files = Array.from({ length: 5 }, (_, i) => f(`${i}.mp4`, 1, 'video/mp4'));
    const out = screenFiles(files, { maxFiles: 3 });
    expect(out.accepted).toHaveLength(3);
    expect(out.overflow.map((o) => o.name)).toEqual(['3.mp4', '4.mp4']);
  });
});

describe('card order', () => {
  const items = [
    { assetId: 'a', filename: 'clip 10.mp4', createdAt: new Date(3), sortIndex: 0 },
    { assetId: 'b', filename: 'clip 2.mp4', createdAt: new Date(1), sortIndex: 1 },
    { assetId: 'c', filename: 'clip 1.mp4', createdAt: new Date(2), sortIndex: 2 },
  ];

  it('sorts by name, selection and date added', () => {
    expect(sortForMode(items, 'name')).toEqual(['c', 'b', 'a']);
    expect(sortForMode(items, 'selection')).toEqual(['b', 'c', 'a']);
    expect(sortForMode(items, 'added')).toEqual(['a', 'c', 'b']);
    expect(sortForMode(items, 'custom')).toEqual(['a', 'b', 'c']);
  });

  it('detects the mode the current order matches', () => {
    expect(detectOrder(items)).toBe('custom');
    expect(detectOrder(applyOrder(items, ['c', 'b', 'a']))).toBe('name');
    expect(detectOrder(applyOrder(items, ['b', 'c', 'a']))).toBe('selection');
    expect(detectOrder(applyOrder(items, ['a', 'c', 'b']))).toBe('added');
    expect(detectOrder([items[0]!])).toBe('name');
  });

  it('applies an order as sortIndex', () => {
    const out = applyOrder(items, ['c', 'a', 'b']);
    expect(out.map((i) => [i.assetId, i.sortIndex])).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('moves one key', () => {
    expect(moveKey(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(moveKey(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a']);
    const same = ['a', 'b'];
    expect(moveKey(same, 'a', 0)).toBe(same);
    expect(moveKey(same, 'x', 1)).toBe(same);
  });
});
