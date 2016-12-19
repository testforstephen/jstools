import fs from 'fs';
import path from 'path';

const fsHelper = {};

fsHelper.exists = function (...params) {
  const filepath = path.join.apply(path, params);
  return filepath && fs.existsSync(filepath);
};

fsHelper.isFile = function (...params) {
  const filepath = path.join.apply(path, params);
  return fsHelper.exists(filepath) && fs.statSync(filepath).isFile();
};

fsHelper.isDir = function (...params) {
  const filepath = path.join.apply(path, params);
  return fsHelper.exists(filepath) && fs.statSync(filepath).isDirectory();
};

fsHelper.readJsonFile = function (file) {
  return JSON.parse(fs.readFileSync(file));
};

export default fsHelper;
