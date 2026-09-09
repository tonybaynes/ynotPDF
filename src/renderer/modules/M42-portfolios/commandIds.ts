/**
 * Command ids (M42), in their own file so the grid can run a command without importing the
 * manifest that mounts the grid.
 */

export const PORTFOLIO_COMMAND = {
  newPortfolio: 'portfolio.new',
  newFromFiles: 'portfolio.newFromFiles',
  addFiles: 'portfolio.addFiles',
  addFolderFromDisk: 'portfolio.addFolderFromDisk',
  newFolder: 'portfolio.newFolder',
  renameFolder: 'portfolio.renameFolder',
  removeFolder: 'portfolio.removeFolder',
  openFile: 'portfolio.openFile',
  removeFiles: 'portfolio.removeFiles',
  renameFile: 'portfolio.renameFile',
  describeFile: 'portfolio.describeFile',
  moveToFolder: 'portfolio.moveToFolder',
  moveUp: 'portfolio.moveUp',
  moveDown: 'portfolio.moveDown',
  replaceFile: 'portfolio.replaceFile',
  extractFile: 'portfolio.extract',
  extractSelected: 'portfolio.extractSelected',
  extractAll: 'portfolio.extractAll',
  addColumn: 'portfolio.addColumn',
  removeColumn: 'portfolio.removeColumn',
  setColumnValue: 'portfolio.setColumnValue',
  setView: 'portfolio.setView',
  setInitialFile: 'portfolio.setInitialFile',
  generateCover: 'portfolio.generateCover',
  coverFromFile: 'portfolio.coverFromFile',
  showFiles: 'portfolio.showFiles',
  showCover: 'portfolio.showCover',
  saveBack: 'portfolio.saveBack',
  convertToSinglePdf: 'portfolio.convertToSinglePdf',
} as const;
