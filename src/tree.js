'use strict';

/**
 * Flatten Overleaf's recursive rootFolder structure into flat path maps.
 *
 * Overleaf's project.rootFolder is a nested structure:
 * [{ _id, name, folders: [...], docs: [{_id, name}], fileRefs: [{_id, name}] }]
 */

function flattenTree(rootFolder) {
  const docPaths = new Map();   // docId → relativePath
  const pathDocs = new Map();   // relativePath → docId
  const filePaths = new Map();  // fileRefId → relativePath
  const pathFiles = new Map();  // relativePath → fileRefId
  const folderPaths = new Map(); // folderId → relativePath
  const pathFolders = new Map(); // relativePath → folderId
  let rootFolderId = null;

  function walk(folders, prefix) {
    if (!Array.isArray(folders)) return;

    for (const folder of folders) {
      const folderPath = prefix ? prefix + '/' + folder.name : folder.name;
      const currentPrefix = folder.name === 'rootFolder' || !prefix && !folder.name
        ? ''
        : folderPath;

      // Track folder IDs
      if (folder._id) {
        if (currentPrefix === '') {
          rootFolderId = folder._id;
        } else {
          folderPaths.set(folder._id, currentPrefix);
          pathFolders.set(currentPrefix, folder._id);
        }
      }

      // Process docs (editable text files)
      if (Array.isArray(folder.docs)) {
        for (const doc of folder.docs) {
          const docPath = currentPrefix ? currentPrefix + '/' + doc.name : doc.name;
          docPaths.set(doc._id, docPath);
          pathDocs.set(docPath, doc._id);
        }
      }

      // Process fileRefs (binary files: images, PDFs, etc.)
      if (Array.isArray(folder.fileRefs)) {
        for (const file of folder.fileRefs) {
          const filePath = currentPrefix ? currentPrefix + '/' + file.name : file.name;
          filePaths.set(file._id, filePath);
          pathFiles.set(filePath, file._id);
        }
      }

      // Recurse into subfolders
      if (Array.isArray(folder.folders)) {
        walk(folder.folders, currentPrefix);
      }
    }
  }

  // rootFolder is typically an array with one root element
  const folders = Array.isArray(rootFolder) ? rootFolder : [rootFolder];
  walk(folders, '');

  return { docPaths, pathDocs, filePaths, pathFiles, folderPaths, pathFolders, rootFolderId };
}

module.exports = { flattenTree };
