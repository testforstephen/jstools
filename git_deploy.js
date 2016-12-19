import gutil from 'gulp-util';
import fsHelper from './fs-helper';
import { spawn } from 'child_process';
import async from 'async';
import glob from 'glob';
import path from 'path';
import { cp, rm, mkdir, exec } from 'shelljs';
import _ from 'lodash';

// Check if the target branch exists in remote repository not not.
function checkBranchExists(gitUrl, branch) {
  const gitProcess = exec(`git ls-remote --heads ${gitUrl} ${branch}`);
  if (gitProcess.code === 0 && !gitProcess.stdout) {
    return false;
  }
  return true;
}

function git(args, options) {
  return function (skip, cb) {
    let callback = cb;
    let willSkip = !!(skip);
    if (typeof skip === 'function' && !cb) {
      callback = skip;
      willSkip = false;
    }

    let opts = args.join(' ');
    if (args.length && (args[0] === 'clone' || args[0] === 'push')) {
      // When print git command in console log, remove credential info from git url.
      opts = opts.replace(/:(\/|\\)(\/|\\)[^:]*:[^@]*@/, '://');
    }
    if (willSkip) {
      gutil.log(gutil.colors.yellow(`Skipping "git ${opts}" in ${options.cwd}`));
      callback(null, true);
    } else {
      gutil.log(gutil.colors.yellow(`Running "git ${opts}" in ${options.cwd}`));

      const cmd = spawn('git', args, options);
      let stdout = new Buffer('');
      let stderr = new Buffer('');
      if (cmd.stdout) {
        cmd.stdout.on('data', (buf) => {
          stdout = Buffer.concat([stdout, new Buffer(buf)]);
        });
      }
      if (cmd.stderr) {
        cmd.stderr.on('data', (buf) => {
          stderr = Buffer.concat([stderr, new Buffer(buf)]);
        });
      }
      cmd.on('close', (code) => {
        if (code === 0) {
          const output = stdout.toString();
          if (args.length && args[0] === 'status' && (!output || !output.trim())) {
            // if no changes to commit, then skip the next git commit/push steps;
            gutil.log(gutil.colors.yellow('No changes to commit, and skip the next git commit/push steps'));
            callback(null, true);
          } else {
            callback(null);
          }
        } else {
          gutil.log(`stdout: ${stdout.toString()}`);
          gutil.log(`stderr: ${stderr.toString()}`);
          gutil.log(`git exited with code ${code}`);
          callback(`Error: ${stderr.toString()}`);
        }
      });
    }
  };
}

function processGlobPatterns(patterns, ignorePatterns, options, ignoreIntermediate) {
  let result = [];
  // Iterate over flattened patterns array.
  _.flattenDeep(patterns).forEach((pattern) => {
    // Find all matching files for this pattern.
    const matches = glob.sync(pattern, options);
    // add matching files.
    result = _.union(result, matches);
  });

  // Iterate over flattened patterns array.
  _.flattenDeep(ignorePatterns).forEach((pattern) => {
    // Find all matching files for this pattern.
    const matches = glob.sync(pattern, options);
    // remove matching files.
    result = _.difference(result, matches);

    // Find parent directories of matching files/directories, and ignore them too.
    if (ignoreIntermediate) {
      const intermediates = [];
      matches.forEach((item) => {
        let dirname = path.dirname(item);
        while (dirname !== '.' && dirname !== '/' && dirname !== '\\') {
          if (_.includes(intermediates, dirname)) {
            break;
          } else {
            intermediates.push(dirname);
          }
          dirname = path.dirname(dirname);
        }
      });
      // remove intermediate directories.
      result = _.difference(result, intermediates);
    }
  });

  return result;
}

function copyIntoRepo(srcDir, srcIgnorePatterns, destDir, destIgnorePatterns) {
  return function (cb) {
    gutil.log(gutil.colors.yellow(`Copying ${srcDir} to ${destDir}`));

    // Remove files except .git folder.
    processGlobPatterns(['**/*'], destIgnorePatterns, { cwd: destDir, dot: true }, true).forEach((dest) => {
      let fullDest;
      if (process.platform === 'win32') {
        fullDest = path.join(destDir, dest).replace(/\\/g, '/');
      } else {
        fullDest = path.join(destDir, dest);
      }

      if (fsHelper.exists(fullDest)) {
        rm('-rf', fullDest);
      }
    });

    // Copy build outputs to the deploy directory.
    processGlobPatterns(['**/*'], srcIgnorePatterns, { cwd: srcDir, dot: true }).forEach((src) => {
      let fullDest;
      let fullSrc;
      if (process.platform === 'win32') {
        fullDest = path.join(destDir, src).replace(/\\/g, '/');
        fullSrc = path.join(srcDir, src).replace(/\\/g, '/');
      } else {
        fullDest = path.join(destDir, src);
        fullSrc = path.join(srcDir, src);
      }

      if (fsHelper.isDir(fullSrc)) {
        mkdir('-p', fullDest);
      } else {
        cp('-f', fullSrc, fullDest);
      }
    });

    cb();
  };
}

function postBuild(workingDir, postBuildFunc) {
  return function (cb) {
    if (postBuildFunc && typeof postBuildFunc === 'function') {
      gutil.log(gutil.colors.yellow(`Executing post-build commands at the directory ${workingDir}`));
      postBuildFunc(path.resolve(workingDir));
    }
    cb();
  };
}

export default function gitDeploy(options, done) {
  const deployOptions = _.assign(
    { message: 'autocommit',
      tag: false,
      tagMessage: 'autocommit',
      branch: 'master',
      srcIgnorePatterns: [],
      repoIgnorePatterns: []
    }, options);
  const sourceDir = deployOptions.src;
  const deployDir = deployOptions.tmp || 'tmp/deployDir';
  if (!fsHelper.isDir(sourceDir)) {
    done('The source directory to deploy is required.');
    return false;
  }
  if (!deployOptions.url) {
    done('The URL to a remote git repository is required.');
    return false;
  }

  let srcIgnorePatterns = deployOptions.srcIgnorePatterns;
  let repoIgnorePatterns = deployOptions.repoIgnorePatterns;
  if (Array.isArray(srcIgnorePatterns)) {
    srcIgnorePatterns.push('.git/**');
  } else {
    srcIgnorePatterns = ['.git/**', srcIgnorePatterns];
  }
  if (Array.isArray(repoIgnorePatterns)) {
    repoIgnorePatterns.push('.git/**');
  } else {
    repoIgnorePatterns = ['.git/**', repoIgnorePatterns];
  }

  if (fsHelper.exists(deployDir)) {
    rm('-rf', deployDir);
  }
  mkdir('-p', deployDir);

  const spawnOptions = {
    cwd: deployDir
  };
  // If target branch exists in repository, then using 'git clone -b <branch> <gitUrl>';
  // else using 'git clone <gitUrl>'
  let commands = [];
  if (checkBranchExists(deployOptions.url, deployOptions.branch)) {
    commands = [
      git(['clone', '-b', deployOptions.branch, deployOptions.url, '.'], spawnOptions),
      copyIntoRepo(sourceDir, srcIgnorePatterns, deployDir, repoIgnorePatterns),
      postBuild(deployDir, deployOptions.postBuild),
      git(['add', '--all'], spawnOptions),
      git(['status', '--porcelain'], spawnOptions)
    ];
  } else {
    commands = [
      git(['clone', deployOptions.url, '.'], spawnOptions),
      git(['checkout', '-B', deployOptions.branch], spawnOptions),
      copyIntoRepo(sourceDir, srcIgnorePatterns, deployDir, repoIgnorePatterns),
      postBuild(deployDir, deployOptions.postBuild),
      git(['add', '--all'], spawnOptions)
    ];
  }
  commands.push(git(['commit', '--allow-empty', `--message=${deployOptions.message}`], spawnOptions));
  if (deployOptions.tag) {
    commands.push(git(['tag', '-a', deployOptions.tag, '-m', deployOptions.tagMessage], spawnOptions));
  }
  commands.push(git(['push', '--prune', '--quiet', '--follow-tags', deployOptions.url, deployOptions.branch], spawnOptions));

  async.waterfall(commands, done);

  return true;
}
