import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, fmtAuthor, textToHtml, ocrToHtml, isJunkTitle, parseRoute, geometry, mergeLibrary } from '../public/lib.js';

test('esc', () => assert.equal(esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;'));

test('fmtAuthor', () => {
  assert.equal(fmtAuthor('Austen, Jane'), 'Jane Austen');
  assert.equal(fmtAuthor('Twain, Mark (Samuel)'), 'Mark Twain');
  assert.equal(fmtAuthor('Homer'), 'Homer');
  assert.equal(fmtAuthor(), 'Unknown author');
});

test('textToHtml strips Gutenberg boilerplate', () => {
  const t = 'license junk\n*** START OF THE PROJECT GUTENBERG EBOOK X ***\nHello\nworld\n\n<b>Two</b>\n*** END OF THE PROJECT GUTENBERG EBOOK X ***\nmore junk';
  assert.equal(textToHtml(t), '<p>Hello world</p>\n<p>&lt;b&gt;Two&lt;/b&gt;</p>');
});

test('parseRoute', () => {
  assert.deepEqual(parseRoute('#/'), { view: 'home', key: null, params: {} });
  assert.deepEqual(parseRoute('#/read/se/jane-austen/persuasion'), { view: 'read', key: 'se:jane-austen/persuasion', params: {} });
  assert.deepEqual(parseRoute('#/search?q=war%20and'), { view: 'search', key: null, params: { q: 'war and' } });
});

test('geometry: page stride equals viewport width', () => {
  for (const W of [375, 800, 1440]) {
    const g = geometry(W, 24);
    assert.equal(g.cols * g.colWidth + (g.cols - 1) * g.gap + 2 * g.m, W);
  }
  assert.equal(geometry(375, 24).m, 24);
});

import { parseCsv, cleanAuthor } from '../catalog.js';
test('parseCsv handles quotes, commas and newlines', () => {
  assert.deepEqual(parseCsv('a,b\n1,"x, ""y""\nz"\n'), [['a', 'b'], ['1', 'x, "y"\nz']]);
});
test('cleanAuthor', () => {
  assert.equal(cleanAuthor('Austen, Jane, 1775-1817'), 'Jane Austen');
  assert.equal(cleanAuthor('Shelley, Mary Wollstonecraft, 1797-1851 [Author]; Smith, A'), 'Mary Wollstonecraft Shelley');
  assert.equal(cleanAuthor('Homer, 751? BCE-651? BCE'), 'Homer');
});

test('mergeLibrary keeps the newest copy of each book', () => {
  const a = { x: { progress: 0.5, updated: 2 }, y: { progress: 0.1, updated: 5 } };
  const b = { x: { progress: 0.2, updated: 1 }, y: { deleted: true, updated: 6 }, z: { progress: 0, updated: 1 } };
  assert.deepEqual(mergeLibrary(a, b), { x: { progress: 0.5, updated: 2 }, y: { deleted: true, updated: 6 }, z: { progress: 0, updated: 1 } });
});

test('ocrToHtml drops scan noise and rejoins lines', () => {
  const t = '1  I  §\n\ni=   t\n\nCHAPTER I\n\nJonathan Harker\u2019s Journal. Left Munich at 8:35 P.M., on 1st May, ar-\nriving at Vienna early next morning.\n\n';
  assert.equal(ocrToHtml(t), '<h3>CHAPTER I</h3>\n<p>Jonathan Harker\u2019s Journal. Left Munich at 8:35 P.M., on 1st May, arriving at Vienna early next morning.</p>');
});

test('isJunkTitle', () => {
  assert.equal(isJunkTitle('Summary of The Silent Patient by Alex Michaelides', 'the silent patient'), true);
  assert.equal(isJunkTitle('Workbook: The Silent Patient'), true);
  assert.equal(isJunkTitle('Paperback - the Silent Patient'), true);
  assert.equal(isJunkTitle('The Silent Patient', 'the silent patient'), false);
  assert.equal(isJunkTitle('Analysis of Mind', 'analysis'), false);
});
