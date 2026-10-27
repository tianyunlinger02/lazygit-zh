#!/usr/bin/env node
import { stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { configureApp, appDataDir } from './app-context.js';
import { Git, GitError, redact } from './git.js';
import { which } from './process.js';
import { Cancelled, Console, EndOfInput, closeInput } from './ui.js';
import { diagnostics, setupWizard } from './setup.js';
import { profilesMenu, resolveBinding } from './profiles.js';
import { loadPreferences, savePreferences, settingsMenu, startup } from './preferences.js';
import { stashMenu } from './stash.js';
import { branches, chooseDirectory, clone, inspect, pull, saveAndPush, uploadLocal } from './workflows.js';

export const VERSION = '0.5.0';
export const HELP = `AutoGit 中文交互式 Git 助手 ${VERSION}

用法：autogit [--path <项目目录>] [--app-dir <AutoGit资料根目录>]
  --path       选择当前 Git 项目；不传时恢复上次项目
  --app-dir    便携资料根目录；数据保存在它的 data/，不写外部位置指针
  --help, -h   显示帮助，不创建账号目录
  --version    显示版本

需要 Node.js 22+、Git 2.28+ 和兼容的 OpenSSH；运行不需要 Python。
首次启动选择个人 AutoGit 文件夹；npm 升级/卸载不会删除该文件夹。
默认只在用户配置区保存含路径的 location.json，密钥始终在个人文件夹内。
`;
function expand(value: string): string { return resolve(value === '~' ? homedir() : /^~[/\\]/u.test(value) ? resolve(homedir(), value.slice(2)) : value); }
function expectedError(error: unknown): error is Error { return error instanceof GitError || error instanceof Error && 'code' in error; }
export function toolSummary(ui: Console): void {
  ui.text('工具检查：');
  for (const name of ['git', 'ssh', 'ssh-keygen', 'gh']) ui.text(`  ${name}${name === 'gh' ? '（可选）' : ''}：${which(name) ?? '未找到'}`);
}
export async function dispatch(ui: Console, directory: string, choice: number): Promise<string> {
  if (choice === 1) {
    const step = await ui.menu('首次使用', ['在软件里管理账号和密钥（推荐）', '检查依赖与高级兼容配置']);
    if (step === 1) await profilesMenu(ui, directory); else if (step === 2) await setupWizard(ui, directory);
  } else if (choice === 2) return await clone(ui, directory) ?? directory;
  else if (choice === 3) return await uploadLocal(ui, directory) ?? directory;
  else if (choice === 4) await saveAndPush(ui, directory);
  else if (choice === 5) await pull(ui, directory);
  else if (choice === 6) await inspect(ui, directory);
  else if (choice === 7) await branches(ui, directory);
  else if (choice === 8) await diagnostics(ui, directory);
  else if (choice === 9) return chooseDirectory(ui, directory);
  else if (choice === 10) await profilesMenu(ui, directory);
  else if (choice === 11) await stashMenu(ui, directory);
  else if (choice === 12) await saveAndPush(ui, directory, { upload: false });
  else if (choice === 13) await settingsMenu(ui);
  else if (choice === 14) { const { push, projectGit } = await import('./workflows.js'); await push(ui, await projectGit(directory)); }
  else if (choice === 15) { const { destructiveMenu } = await import('./destructive.js'); await destructiveMenu(ui, directory); }
  else if (choice === 16) { const { remotesMenu } = await import('./remotes.js'); await remotesMenu(ui, directory); }
  else if (choice === 17) { const { operationsMenu } = await import('./operations.js'); await operationsMenu(ui, directory); }
  else if (choice === 18) { const { historyMenu } = await import('./history.js'); await historyMenu(ui, directory); }
  else if (choice === 19) { const { githubMenu } = await import('./github-repositories.js'); return await githubMenu(ui, directory) ?? directory; }
  else if (choice === 20) { const { projectsMenu } = await import('./projects.js'); return await projectsMenu(ui, directory) ?? directory; }
  else if (choice === 21) {
    const action = await ui.menu('项目工具', ['.gitignore / README / 许可证', 'worktree 多工作区', '子模块', 'Git LFS', '项目主机 / SSH alias / 代理', '账号资料备份 / 恢复 / 搬迁']);
    if (action === 1) { const { templatesMenu } = await import('./templates.js'); await templatesMenu(ui, directory); }
    else if (action === 2) { const { worktreesMenu } = await import('./worktrees.js'); return await worktreesMenu(ui, directory) ?? directory; }
    else if (action === 3) { const { submodulesMenu } = await import('./submodules.js'); return await submodulesMenu(ui, directory) ?? directory; }
    else if (action === 4) { const { lfsMenu } = await import('./lfs.js'); return await lfsMenu(ui, directory) ?? directory; }
    else if (action === 5) { const { hostsMenu } = await import('./hosts.js'); await hostsMenu(ui, directory); }
    else if (action === 6) { const { backupMenu } = await import('./backup.js'); await backupMenu(ui); }
  }
  return directory;
}
export async function runMenu(ui: Console, selected: string): Promise<void> {
  let directory = selected;
  for (;;) {
    ui.title('AutoGit 中文助手'); ui.text(`当前目录：${directory}`); ui.text(`账号资料：${appDataDir()}`);
    ui.text(ui.quick ? '快捷模式：选好任务后直接执行' : '详细模式：每一步确认');
    try {
      const binding = await resolveBinding(directory);
      ui.text(binding ? `软件账号：${binding.label}（预期 SSH 账号：${binding.github_login}）` : '软件账号：未绑定，可在“账号与密钥”选择。');
      const local = new Git(directory);
      if (!(await local.run(['rev-parse', '--is-inside-work-tree'], { check: false })).status) {
        const branch = await local.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { check: false });
        ui.text(branch.status ? '当前分支：游离 HEAD，可在操作中心继续或新建分支保存。' : `当前分支：${branch.stdout.toString('utf8').trim()}`);
        const operation = await local.operation(); if (operation) ui.text(`进行中状态：${operation}，请先在“分支与合并”处理。`);
      }
    } catch (error) { if (!expectedError(error)) throw error; ui.text(`配置提示：${redact(error.message)}`); }
    const choice = await ui.menu('你想做什么？', [
      '首次配置与软件内账号管理', '下载已有项目', '上传本地项目（新建公开/私有仓库或关联已有）', '保存修改并上传',
      '获取远程最新代码（仅安全快进）', '查看状态、差异和历史', '分支与合并（切换、跟踪、冲突、删除）',
      '检查配置和诊断问题', '切换当前项目目录', '账号与密钥（新建、导入、项目绑定）',
      '临时收起 / 恢复未完成的工作', '仅保存到本地（不上传）', '使用设置（快捷/详细确认、文件夹安全提示）',
      '仅上传已有提交', '撤销、还原和清理（含 reset / clean）', '远程与强推工具',
      '进行中的操作（revert / cherry-pick / rebase / bisect）', '历史与恢复（详情 / 搜索 / reflog）',
      'GitHub 协作（仓库 / PR / Issue / Release）', '项目收藏与最近使用', '项目工具（模板 / worktree / 子模块 / LFS / 备份）',
    ], '退出');
    if (!choice) { ui.text('已退出，没有执行未选择的操作。'); return; }
    const previous = directory;
    try {
      if (choice === 3) { directory = await chooseDirectory(ui, directory); await uploadLocal(ui, directory, { selectDirectory: false }); }
      else directory = await dispatch(ui, directory, choice);
    } catch (error) {
      if (error instanceof Cancelled) ui.text(`${error.message}。已返回菜单；之前完成的步骤会保留，未确认步骤不会执行。`);
      else if (expectedError(error)) ui.text(`\n操作未完成：${redact(error.message)}\n已返回主菜单，可以检查后重试。`);
      else throw error;
    } finally {
      if (directory !== previous) {
        try {
          await savePreferences({ last_project: directory });
          const { ProjectStore } = await import('./projects.js');
          if (!(await new Git(directory).run(['rev-parse', '--is-inside-work-tree'], { check: false })).status) await new ProjectStore().touch(directory);
        } catch (error) { if (!expectedError(error)) throw error; ui.text(`项目已切换，但记住目录失败：${redact(error.message)}`); }
      }
    }
  }
}
export async function main(argv = process.argv.slice(2), ui = new Console()): Promise<number> {
  try {
    let args;
    try { args = parseArgs({ args: argv, options: { path: { type: 'string' }, 'app-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' } }, strict: true, allowPositionals: false }).values; }
    catch (error) { ui.text(`参数错误：${String(error)}\n运行 autogit --help 查看用法。`); return 2; }
    if (args.help) { ui.text(HELP); return 0; }
    if (args.version) { ui.text(`autogit ${VERSION}`); return 0; }
    await configureApp(ui, { appDir: args['app-dir'] === undefined ? undefined : expand(args['app-dir']) });
    const remembered = args.path === undefined ? (await loadPreferences()).last_project : '';
    let directory = args.path === undefined ? process.cwd() : expand(args.path);
    if (args.path === undefined && remembered) { try { if ((await stat(remembered)).isDirectory()) directory = remembered; } catch { /* A moved project falls back to the current working directory. */ } }
    directory = new Git(expand(directory)).directory;
    if (!(await stat(directory)).isDirectory()) throw new GitError(`目录不存在或不是文件夹：${directory}`);
    toolSummary(ui); await startup(ui); await savePreferences({ last_project: directory });
    if (!(await new Git(directory).run(['rev-parse', '--is-inside-work-tree'], { check: false })).status) {
      try { const { ProjectStore } = await import('./projects.js'); await new ProjectStore().touch(directory); }
      catch (error) { if (!expectedError(error)) throw error; ui.text(`最近项目记录未更新：${redact(error.message)}`); }
    }
    await runMenu(ui, directory);
  } catch (error) {
    if (error instanceof Cancelled || error instanceof EndOfInput) ui.text('\n已退出，没有继续执行当前操作。');
    else if (expectedError(error)) { ui.text(`\n操作未完成：${redact(error.message)}`); return 1; }
    else { ui.text(`\n程序异常：${redact(String(error))}。已停止，请保留当前项目状态后报告问题。`); return 1; }
  }
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try { process.exitCode = await main(); } finally { closeInput(); }
}
