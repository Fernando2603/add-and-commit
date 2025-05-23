import * as core from '@actions/core';
import * as path from 'path';
import * as fs from 'node:fs';
import simpleGit, {FileStatusResult, Response} from 'simple-git';
import {checkInputs, getInput, logOutputs, setOutput} from './io';
import {log, matchGitArgs, parseInputArray} from './util';

const baseDir = path.join(process.cwd(), getInput('cwd') || '');
const git = simpleGit({baseDir});

const exitErrors: Error[] = [];

interface File extends FileStatusResult {
  size: number;
}

interface Chunk {
  files: string[];
  size: number;
}

core.info(`Running in ${baseDir}`);
(async () => {
  await checkInputs();

  core.startGroup('Internal logs');
  core.info('> Staging files...');

  const ignoreErrors =
    getInput('pathspec_error_handling') === 'ignore' ? 'pathspec' : 'none';

  // if (getInput('add')) {
  //   core.info('> Adding files...');
  //   await add(ignoreErrors);
  // } else core.info('> No files to add.');

  // if (getInput('remove')) {
  //   core.info('> Removing files...');
  //   await remove(ignoreErrors);
  // } else core.info('> No files to remove.');

  core.info('> Checking for changes in the git working tree...');
  const changedFiles = (await git.status(undefined, log)).files.length;
  // continue if there are any changes or if the allow-empty commit argument is included
  if (
    changedFiles > 0 ||
    matchGitArgs(getInput('commit') || '').includes('--allow-empty')
  ) {
    core.info(`> Found ${changedFiles} changed files.`);
    core.debug(
      `--allow-empty argument detected: ${matchGitArgs(
        getInput('commit') || '',
      ).includes('--allow-empty')}`,
    );

    await git
      .addConfig('user.email', getInput('author_email'), undefined, log)
      .addConfig('user.name', getInput('author_name'), undefined, log)
      .addConfig('author.email', getInput('author_email'), undefined, log)
      .addConfig('author.name', getInput('author_name'), undefined, log)
      .addConfig('committer.email', getInput('committer_email'), undefined, log)
      .addConfig('committer.name', getInput('committer_name'), undefined, log);
    core.debug(
      '> Current git config\n' +
        JSON.stringify((await git.listConfig()).all, null, 2),
    );

    let fetchOption: string | boolean;
    try {
      fetchOption = getInput('fetch', true);
    } catch {
      fetchOption = getInput('fetch');
    }
    if (fetchOption) {
      core.info('> Fetching repo...');
      await git.fetch(
        matchGitArgs(fetchOption === true ? '' : fetchOption),
        log,
      );
    } else core.info('> Not fetching repo.');

    const targetBranch = getInput('new_branch');
    if (targetBranch) {
      core.info('> Checking-out branch...');

      if (!fetchOption)
        core.warning(
          'Creating a new branch without fetching the repo first could result in an error when pushing to GitHub. Refer to the action README for more info about this topic.',
        );

      await git
        .checkout(targetBranch)
        .then(() => {
          log(undefined, `'${targetBranch}' branch already existed.`);
        })
        .catch(() => {
          log(undefined, `Creating '${targetBranch}' branch.`);
          return git.checkoutLocalBranch(targetBranch, log);
        });
    }

    const pullOption = getInput('pull');
    if (pullOption) {
      core.info('> Pulling from remote...');
      core.debug(`Current git pull arguments: ${pullOption}`);
      await git
        .fetch(undefined, log)
        .pull(undefined, undefined, matchGitArgs(pullOption), log);

      core.info('> Checking for conflicts...');
      const status = await git.status(undefined, log);

      if (!status.conflicted.length) {
        core.info('> No conflicts found.');
        // core.info('> Re-staging files...');
        // if (getInput('add')) await add(ignoreErrors);
        // if (getInput('remove')) await remove(ignoreErrors);
      } else
        throw new Error(
          `There are ${
            status.conflicted.length
          } conflicting files: ${status.conflicted.join(', ')}`,
        );
    } else core.info('> Not pulling from repo.');

    // handle git push limit 2000MB
    core.info('> Checking file(s)...');
    const status = await git.status({'--porcelain': null}, log);
    const files: File[] = await Promise.all(
      status.files.map(async file => {
        const filepath = path.resolve(baseDir, file.path);
        let filesize = 0;

        try {
          const stat = await fs.promises.stat(filepath);
          filesize = stat.size;
        } catch {
          filesize = 0;
        }

        return {
          path: file.path,
          size: filesize,
          index: file.index,
          working_dir: file.working_dir,
        };
      }),
    );

    const limit: number = 1800 * 1024 * 1024;

    core.info('> Building chunk(s)...');
    const chunks: Chunk[] = [];
    let current: Chunk = {files: [], size: 0};

    files.forEach(file => {
      if (current.size + file.size > limit) {
        chunks.push(current);
        current = {files: [], size: 0};
      }

      current.files.push(file.path);
      current.size += file.size;
    });

    if (current.files.length) {
      chunks.push(current);
    }

    core.info('> Creating commit...');
    const sha: string[] = [];

    for (const [index, chunk] of chunks.entries()) {
      core.info(
        `> Committing chunk ${index}, count: ${chunk.files.length}, size: ${chunk.size}`,
      );

      await git.add(chunk.files, log).catch((e: Error) => {
        if (
          e.message.includes('fatal: pathspec') &&
          e.message.includes('did not match any files')
        ) {
          if (ignoreErrors === 'pathspec') return;

          const peh = getInput('pathspec_error_handling'),
            err = new Error(
              `Add command did not match any file: git add ${chunk.files.join(' ')}`,
            );
          if (peh === 'exitImmediately') throw err;
          if (peh === 'exitAtEnd') {
            exitErrors.push(err);
            return;
          }
        } else {
          throw e;
        }
      });

      try {
        const data = await git.commit(
          getInput('message'),
          matchGitArgs(getInput('commit') || ''),
        );
        log(undefined, data);
        setOutput('committed', 'true');
        setOutput('commit_long_sha', data.commit);
        setOutput('commit_sha', data.commit.substring(0, 7));
        sha.push(data.commit);
      } catch (err) {
        core.setFailed(err instanceof Error ? err.message : String(err));
      }
    }

    if (getInput('tag')) {
      core.info('> Tagging commit...');

      if (!fetchOption)
        core.warning(
          'Creating a tag without fetching the repo first could result in an error when pushing to GitHub. Refer to the action README for more info about this topic.',
        );

      await git
        .tag(matchGitArgs(getInput('tag') || ''), (err, data?) => {
          if (data) setOutput('tagged', 'true');
          return log(err, data);
        })
        .then(data => {
          setOutput('tagged', 'true');
          return log(null, data);
        })
        .catch(err => core.setFailed(err));
    } else core.info('> No tag info provided.');

    let pushOption: string | boolean;
    try {
      pushOption = getInput('push', true);
    } catch {
      pushOption = getInput('push');
    }
    if (pushOption) {
      // If the options is `true | string`...
      core.info('> Pushing commit to repo...');

      if (pushOption === true) {
        core.info('> Pushing commit to repo...');
        const branch =
          getInput('new_branch') ||
          (await git.revparse(['--abbrev-ref', 'HEAD']));

        for (const commit of sha) {
          core.debug(`Running: git push origin ${commit}:${branch}`);

          await git.push(
            'origin',
            `${commit}:${branch}`,
            {'--set-upstream': null},
            (err, data?) => {
              if (data) setOutput('pushed', 'true');
              return log(err, data);
            },
          );
        }
      }

      if (getInput('tag')) {
        core.info('> Pushing tags to repo...');

        await git
          .pushTags('origin', matchGitArgs(getInput('tag_push') || ''))
          .then(data => {
            setOutput('tag_pushed', 'true');
            return log(null, data);
          })
          .catch(err => core.setFailed(err));
      } else core.info('> No tags to push.');
    } else core.info('> Not pushing anything.');

    core.endGroup();
    core.info('> Task completed.');
  } else {
    core.endGroup();
    core.info('> Working tree clean. Nothing to commit.');
  }
})()
  .then(() => {
    // Check for exit errors
    if (exitErrors.length === 1) throw exitErrors[0];
    else if (exitErrors.length > 1) {
      exitErrors.forEach(e => core.error(e));
      throw 'There have been multiple runtime errors.';
    }
  })
  .then(logOutputs)
  .catch(e => {
    core.endGroup();
    logOutputs();
    core.setFailed(e);
  });

async function add(ignoreErrors: 'all' | 'pathspec' | 'none' = 'none') {
  const input = getInput('add');
  if (!input) return [];

  const parsed = parseInputArray(input);
  const res: (string | void)[] = [];

  for (const args of parsed) {
    res.push(
      // Push the result of every git command (which are executed in order) to the array
      // If any of them fails, the whole function will return a Promise rejection
      await git
        .add(matchGitArgs(args), (err, data) =>
          log(ignoreErrors === 'all' ? null : err, data),
        )
        .catch((e: Error) => {
          // if I should ignore every error, return
          if (ignoreErrors === 'all') return;

          // if it's a pathspec error...
          if (
            e.message.includes('fatal: pathspec') &&
            e.message.includes('did not match any files')
          ) {
            if (ignoreErrors === 'pathspec') return;

            const peh = getInput('pathspec_error_handling'),
              err = new Error(
                `Add command did not match any file: git add ${args}`,
              );
            if (peh === 'exitImmediately') throw err;
            if (peh === 'exitAtEnd') exitErrors.push(err);
          } else throw e;
        }),
    );
  }

  return res;
}

async function remove(
  ignoreErrors: 'all' | 'pathspec' | 'none' = 'none',
): Promise<(void | Response<void>)[]> {
  const input = getInput('remove');
  if (!input) return [];

  const parsed = parseInputArray(input);
  const res: (void | Response<void>)[] = [];

  for (const args of parsed) {
    res.push(
      // Push the result of every git command (which are executed in order) to the array
      // If any of them fails, the whole function will return a Promise rejection
      await git
        .rm(matchGitArgs(args), (e, d) =>
          log(ignoreErrors === 'all' ? null : e, d),
        )
        .catch((e: Error) => {
          // if I should ignore every error, return
          if (ignoreErrors === 'all') return;

          // if it's a pathspec error...
          if (
            e.message.includes('fatal: pathspec') &&
            e.message.includes('did not match any files')
          ) {
            if (ignoreErrors === 'pathspec') return;

            const peh = getInput('pathspec_error_handling'),
              err = new Error(
                `Remove command did not match any file:\n  git rm ${args}`,
              );
            if (peh === 'exitImmediately') throw err;
            if (peh === 'exitAtEnd') exitErrors.push(err);
          } else throw e;
        }),
    );
  }

  return res;
}
