#!/usr/bin/env node
import { stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { configureApp, commitConfiguredApp, prepareCredentialDirectory, appDataDir } from './app-context.js';
import { Git, GitError, redact } from './git.js';
import { NativeAuthError } from './auth.js';
import { CredentialSession, currentSession, unlockSession } from './session.js';
import { migrateManagedKeys } from './managed-keys.js';
import { ProfileStore } from './profiles.js';
import { credentialsMenu } from './credentials.js';
import { which } from './process.js';
import { Cancelled, Console, EndOfInput, closeInput } from './ui.js';
import { diagnostics, setupWizard } from './setup.js';
import { profilesMenu, resolveBinding } from './profiles.js';
import { savePreferences, settingsMenu, startup } from './preferences.js';
import { chooseDirectory, clone, inspect, pull, saveAndPush, uploadLocal } from './workflows.js';

export const VERSION = '0.5.0';
export const HELP = `AutoGit 中文交互式 Git 助手 ${VERSION}

用法：autogit [--path <项目目录>] [--app-dir <AutoGit资料根目录>]
  --path       直接指定当前项目；不传时启动中文项目选择引导
  --app-dir    便携资料根目录；数据保存在它的 data/，不写外部位置指针
  --help, -h   显示帮助，不创建账号目录
  --version    显示版本

需要 Node.js 22+、Git 2.28+、兼容的 OpenSSH 和随包匹配平台的原生密钥/权限助手；运行不需要 Python。
通常只需输入 autogit：资料保存位置 → AutoGit 解锁密码 → 选择本次项目，无需目录参数。
首次自行设置独立 AutoGit 密码并确认（至少 12 个字符），不使用系统或 GitHub 账号密码。
Linux 和 Windows 均无需管理员配置系统认证；每次启动重新解锁，退出不保留解锁状态。
首次选择个人资料文件夹（确认密码后自动创建缺少目录）并单独保存恢复码；以后记住位置。
已有库可用原包装密码解密，在“使用设置”改密；忘记密码须使用离线恢复码。
npm 升级/卸载不会删除个人资料文件夹。
默认只在用户配置区保存含路径的 location.json；托管私钥和 Token 在个人文件夹内加密，公钥/署名/路径不加密。
主菜单按日常项目、远程传输、GitHub 协作、账号与资料、项目管理、查看与诊断分组。
`;
function expand(value: string): string { return resolve(value === '~' ? homedir() : /^~[/\\]/u.test(value) ? resolve(homedir(), value.slice(2)) : value); }
function expectedError(error: unknown): error is Error { return error instanceof GitError || error instanceof Error && 'code' in error; }
export function toolSummary(ui: Console): void {
  ui.text('工具检查：');
  for (const name of ['git', 'ssh', 'ssh-keygen', 'gh']) ui.text(`  ${name}${name === 'gh' ? '（可选）' : ''}：${which(name) ?? '未找到'}`);
}
export async function dispatch(ui: Console, directory: string, choice: number, onProjectSelected?: (directory: string) => void): Promise<string> {
  if (choice === 1) {
    const action = await ui.menu('日常项目', ['下载已有项目', '上传本地项目（新建公开/私有仓库或关联已有）', '保存修改并上传', '获取远程最新代码（仅安全快进）', '仅保存到本地（不上传）', '仅上传已有提交']);
    if (action === 1) return await clone(ui, directory) ?? directory;
    if (action === 2) {
      const selected = await chooseDirectory(ui, directory);
      onProjectSelected?.(selected);
      await uploadLocal(ui, selected, { selectDirectory: false });
      return selected;
    }
    if (action === 3) await saveAndPush(ui, directory);
    else if (action === 4) await pull(ui, directory);
    else if (action === 5) await saveAndPush(ui, directory, { upload: false });
    else if (action === 6) { const { push, projectGit } = await import('./workflows.js'); await push(ui, await projectGit(directory)); }
  } else if (choice === 2) {
    const { remotesMenu } = await import('./remotes.js'); await remotesMenu(ui, directory);
  } else if (choice === 3) {
    const { githubMenu } = await import('./github-repositories.js'); return await githubMenu(ui, directory) ?? directory;
  } else if (choice === 4) {
    const action = await ui.menu('账号与资料', ['账号与密钥（新建、导入、项目绑定）', 'HTTPS / GitHub 凭据（加密 Token）', '项目主机 / SSH alias / 代理', '使用设置（改密、锁定、资料位置与确认模式）', '账号资料备份 / 恢复 / 搬迁', '首次配置与依赖指引']);
    if (action === 1) await profilesMenu(ui, directory);
    else if (action === 2) await credentialsMenu(ui, directory);
    else if (action === 3) { const { hostsMenu } = await import('./hosts.js'); await hostsMenu(ui, directory); }
    else if (action === 4) await settingsMenu(ui);
    else if (action === 5) { const { backupMenu } = await import('./backup.js'); await backupMenu(ui); }
    else if (action === 6) {
      const step = await ui.menu('首次使用', ['在软件里管理账号和密钥（推荐）', '检查依赖与高级兼容配置']);
      if (step === 1) await profilesMenu(ui, directory); else if (step === 2) await setupWizard(ui, directory);
    }
  } else if (choice === 5) {
    const action = await ui.menu('项目管理', ['切换当前项目目录', '项目收藏与最近使用', '.gitignore / README / 许可证']);
    if (action === 1) return chooseDirectory(ui, directory);
    if (action === 2) { const { projectsMenu } = await import('./projects.js'); return await projectsMenu(ui, directory) ?? directory; }
    if (action === 3) { const { templatesMenu } = await import('./templates.js'); await templatesMenu(ui, directory); }
  } else if (choice === 6) {
    const action = await ui.menu('查看与诊断', ['查看状态、差异和只读历史', '检查配置和诊断问题']);
    if (action === 1) await inspect(ui, directory);
    else if (action === 2) await diagnostics(ui, directory);
  }
  return directory;
}
export async function runMenu(ui: Console, selected: string): Promise<void> {
  let directory = selected;
  const protectedSession = !!currentSession();
  for (;;) {
    if (protectedSession && (!currentSession() || currentSession()!.closed)) throw new Cancelled('会话已锁定，请重新启动 AutoGit 登录');
    ui.title('AutoGit 中文助手'); ui.text(`当前目录：${directory}`); ui.text(`账号资料：${appDataDir()}`);
    ui.text(ui.quick ? '快捷模式：选好任务后直接执行' : '详细模式：每一步确认');
    try {
      const binding = await resolveBinding(directory);
      ui.text(binding ? `软件账号：${binding.label}（预期 SSH 账号：${binding.github_login}）` : '软件账号：未绑定，可在“账号与密钥”选择。');
      const local = new Git(directory);
      if (!(await local.run(['rev-parse', '--is-inside-work-tree'], { check: false })).status) {
        const branch = await local.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { check: false });
        ui.text(branch.status ? '当前分支：游离 HEAD；请用外部 Git 工具处理后再保存或同步。' : `当前分支：${branch.stdout.toString('utf8').trim()}`);
        const operation = await local.operation(); if (operation) ui.text(`进行中状态：${operation}；AutoGit 不处理此类本地操作，请使用外部 Git 工具完成或中止。`);
      }
    } catch (error) { if (!expectedError(error)) throw error; ui.text(`配置提示：${redact(error.message)}`); }
    const choice = await ui.menu('你想做什么？', [
      '日常项目', '远程传输', 'GitHub 协作', '账号与资料', '项目管理', '查看与诊断',
    ], '退出');
    if (!choice) { ui.text('已退出，没有执行未选择的操作。'); return; }
    const previous = directory;
    try {
      directory = await dispatch(ui, directory, choice, selected => { directory = selected; });
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
export interface MainOptions { unlock?: typeof unlockSession }
export async function main(argv = process.argv.slice(2), ui = new Console(), options: MainOptions = {}): Promise<number> {
  let session: CredentialSession | undefined;
  try {
    let args;
    try { args = parseArgs({ args: argv, options: { path: { type: 'string' }, 'app-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' } }, strict: true, allowPositionals: false }).values; }
    catch (error) { ui.text(`参数错误：${String(error)}\n运行 autogit --help 查看用法。`); return 2; }
    if (args.help) { ui.text(HELP); return 0; }
    if (args.version) { ui.text(`autogit ${VERSION}`); return 0; }
    ui.requireSecretInput();
    await configureApp(ui, { appDir: args['app-dir'] === undefined ? undefined : expand(args['app-dir']), deferLocationCommit: true });
    session = await (options.unlock ?? unlockSession)(ui, appDataDir(), { allowCreate: true });
    const profiles = await new ProfileStore().list();
    if (session instanceof CredentialSession) {
      if (profiles.length) await migrateManagedKeys(ui, profiles);
      await prepareCredentialDirectory(undefined, session);
    }
    await commitConfiguredApp();
    toolSummary(ui);
    const preferences = await startup(ui);
    const { chooseStartupProject } = await import('./projects.js');
    const selected = args.path === undefined ? await chooseStartupProject(ui, process.cwd(), preferences.last_project) : expand(args.path);
    if (selected === undefined) { ui.text('已退出，未选择项目。'); return 0; }
    const directory = new Git(expand(selected)).directory;
    if (!(await stat(directory)).isDirectory()) throw new GitError(`目录不存在或不是文件夹：${directory}`);
    await savePreferences({ last_project: directory });
    if (!(await new Git(directory).run(['rev-parse', '--is-inside-work-tree'], { check: false })).status) {
      try { const { ProjectStore } = await import('./projects.js'); await new ProjectStore().touch(directory); }
      catch (error) { if (!expectedError(error)) throw error; ui.text(`最近项目记录未更新：${redact(error.message)}`); }
    }
    await runMenu(ui, directory);
  } catch (error) {
    if (error instanceof Cancelled || error instanceof EndOfInput) ui.text('\n已退出，没有继续执行当前操作。');
    else if (error instanceof NativeAuthError) {
      ui.text(`\n原生密钥/权限操作未完成：${redact(error.message)}。已停止，不会降低凭据保护。`);
      if (error.code === 'unavailable' || error.code === 'unsupported') ui.text('请检查随包的匹配平台原生助手及个人资料目录权限；无需系统密码认证或管理员配置。');
      return 1;
    }
    else if (expectedError(error)) { ui.text(`\n操作未完成：${redact(error.message)}`); return 1; }
    else { ui.text(`\n程序异常：${redact(String(error))}。已停止，请保留当前项目状态后报告问题。`); return 1; }
  } finally {
    const active = currentSession();
    try { await active?.close(); } finally { if (session !== active) await session?.close(); }
  }
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try { process.exitCode = await main(); } finally { closeInput(); }
}
