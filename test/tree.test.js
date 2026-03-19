'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { flattenTree } = require('../src/tree');

describe('flattenTree', () => {
  it('flattens a simple root folder with docs and files', () => {
    const rootFolder = [{
      _id: 'root1',
      name: '',
      docs: [
        { _id: 'doc1', name: 'main.tex' },
        { _id: 'doc2', name: 'refs.bib' },
      ],
      fileRefs: [
        { _id: 'file1', name: 'figure.png' },
      ],
      folders: [],
    }];

    const result = flattenTree(rootFolder);

    assert.equal(result.rootFolderId, 'root1');
    assert.equal(result.docPaths.get('doc1'), 'main.tex');
    assert.equal(result.docPaths.get('doc2'), 'refs.bib');
    assert.equal(result.pathDocs.get('main.tex'), 'doc1');
    assert.equal(result.filePaths.get('file1'), 'figure.png');
    assert.equal(result.pathFiles.get('figure.png'), 'file1');
  });

  it('flattens nested folders', () => {
    const rootFolder = [{
      _id: 'root1',
      name: '',
      docs: [{ _id: 'doc1', name: 'main.tex' }],
      fileRefs: [],
      folders: [{
        _id: 'folder1',
        name: 'images',
        docs: [],
        fileRefs: [{ _id: 'file1', name: 'cat.png' }],
        folders: [{
          _id: 'folder2',
          name: 'sub',
          docs: [{ _id: 'doc2', name: 'notes.tex' }],
          fileRefs: [],
          folders: [],
        }],
      }],
    }];

    const result = flattenTree(rootFolder);

    assert.equal(result.docPaths.get('doc1'), 'main.tex');
    assert.equal(result.filePaths.get('file1'), 'images/cat.png');
    assert.equal(result.docPaths.get('doc2'), 'images/sub/notes.tex');
    assert.equal(result.pathFolders.get('images'), 'folder1');
    assert.equal(result.pathFolders.get('images/sub'), 'folder2');
    assert.equal(result.folderPaths.get('folder1'), 'images');
    assert.equal(result.folderPaths.get('folder2'), 'images/sub');
  });

  it('handles empty root folder', () => {
    const rootFolder = [{
      _id: 'root1',
      name: '',
      docs: [],
      fileRefs: [],
      folders: [],
    }];

    const result = flattenTree(rootFolder);

    assert.equal(result.rootFolderId, 'root1');
    assert.equal(result.docPaths.size, 0);
    assert.equal(result.filePaths.size, 0);
  });

  it('handles non-array rootFolder (single object)', () => {
    const rootFolder = {
      _id: 'root1',
      name: '',
      docs: [{ _id: 'doc1', name: 'main.tex' }],
      fileRefs: [],
      folders: [],
    };

    const result = flattenTree(rootFolder);

    assert.equal(result.rootFolderId, 'root1');
    assert.equal(result.docPaths.get('doc1'), 'main.tex');
  });

  it('handles missing docs/fileRefs/folders arrays gracefully', () => {
    const rootFolder = [{
      _id: 'root1',
      name: '',
    }];

    const result = flattenTree(rootFolder);
    assert.equal(result.rootFolderId, 'root1');
    assert.equal(result.docPaths.size, 0);
    assert.equal(result.filePaths.size, 0);
  });
});
