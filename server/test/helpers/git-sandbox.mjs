// server/test/helpers/git-sandbox.mjs — real git repositories for the #203
// anchor tests (spec §4.2.8 A-cases), built under a tempDir() so cleanup is
// arranged, and run with an ISOLATED git configuration: the machine's system
// and global config (core.autocrlf, signing, hooks, default branch) cannot
// change what a test sees, so the same case behaves the same on a Windows dev
// box and on the Linux CI runner.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tempDir } from './tmpdir.mjs';

/** An env for git child processes that ignores system + global config. */
export function isolatedGitEnv(root) {
  const globalConfig = join(root, 'gitconfig-global');
  writeFileSync(globalConfig, '');
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_AUTHOR_NAME: 'Sandbox', GIT_AUTHOR_EMAIL: 'sandbox@example.invalid',
    GIT_COMMITTER_NAME: 'Sandbox', GIT_COMMITTER_EMAIL: 'sandbox@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
  };
}

export function runGit(cwd, env, args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}

/**
 * A working repo with a bare `origin`, on branch `main`.
 * @returns {{ root, env, repo, origin, git(args, cwd?), write(rel, content), commitAll(msg), push() }}
 */
export function makeGitSandbox(prefix = 'um-et203-git-') {
  const root = tempDir(prefix);
  const env = isolatedGitEnv(root);
  const repo = join(root, 'repo');
  const origin = join(root, 'origin.git');
  mkdirSync(repo);
  runGit(root, env, ['init', '--bare', '-b', 'main', origin]);
  runGit(repo, env, ['init', '-b', 'main']);
  runGit(repo, env, ['remote', 'add', 'origin', origin]);
  const sb = {
    root, env, repo, origin,
    git: (args, cwd = repo) => runGit(cwd, env, args),
    write(rel, content) {
      const p = join(repo, ...rel.split('/'));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
      return p;
    },
    commitAll(msg) {
      runGit(repo, env, ['add', '-A']);
      runGit(repo, env, ['commit', '-q', '-m', msg]);
      return runGit(repo, env, ['rev-parse', 'HEAD']).trim();
    },
    push() {
      runGit(repo, env, ['push', '-q', 'origin', 'HEAD:main']);
      runGit(repo, env, ['fetch', '-q', 'origin']);
    },
  };
  return sb;
}
