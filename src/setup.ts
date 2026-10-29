import { lstat, readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Git, GitError, redact } from './git.js';
import { runProcess, which } from './process.js';
import { Cancelled, Console } from './ui.js';
import { resolveBinding } from './profiles.js';
import { GithubClient } from './github.js';

export const KEYS_URL = 'https://github.com/settings/keys';
export const FINGERPRINTS_URL = 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints';
export function dependencies(ui: Console): void {
  ui.title('依赖检查（不自动安装）');
  for (const name of ['git', 'ssh-keygen', 'ssh', 'gh']) {
    const found = which(name), message = `${name}${name === 'gh' ? '（可选）' : name === 'git' ? '（必需）' : '（仅 SSH 模式需要）'}：${found ?? '未找到'}`;
    if (found) ui.text(message); else if (name === 'git') ui.error(message); else ui.warn(message);
  }
  ui.text('Windows：可使用用户级或便携 Git for Windows 自带的 OpenSSH；无需为 AutoGit 登录启用系统可选功能或请求管理员。把工具加入个人 PATH 后重新打开终端。');
  ui.text('Linux：使用已有 Git/OpenSSH、用户级工具环境或用户可用的安装方式；发行版包管理器是可选的依赖安装方式，不是 AutoGit 的管理员认证前置。');
  ui.text('github.com 个人账号原生建库及普通 Git 下载/上传不需要 gh；组织建库、GitHub Enterprise、PR / Issue / Release 等高级 GitHub 功能仍需要 GitHub CLI（gh）。本软件不自动安装。');
  ui.text('安装指引：https://cli.github.com/；Windows 可用官方安装包，Linux 按官方发行版指引安装。');
}
export async function configureIdentity(ui: Console, directory: string): Promise<boolean> {
  const git = new Git(directory);
  const current = { 'user.name': await git.config('user.name'), 'user.email': await git.config('user.email') };
  ui.title('高级兼容：修改外部 Git 署名（普通使用请选软件账号）');
  for (const [key, value] of Object.entries(current)) ui.text(`${key}：${JSON.stringify(value)}`);
  let scopes = ['--local', '--global'];
  try { await git.root(); } catch (error) { if (!(error instanceof GitError)) throw error; scopes = ['--global']; ui.warn('当前不是工作区，只能明确选全局或返回，不初始化仓库。'); }
  const choice = await ui.menu('外部身份作用域', scopes.map(scope => scope === '--local' ? '仅本仓库' : '全局（影响其他项目）'));
  if (!choice) return false;
  const scope = scopes[choice - 1];
  const changes: [string, string[], string][] = [];
  for (const [key, label] of [['user.name', '提交姓名'], ['user.email', '提交邮箱']] as const) {
    const result = await git.run(['config', scope, '--null', '--get-all', key], { check: false });
    if (![0, 1].includes(result.status)) throw new GitError('无法读取所选作用域，未写配置。');
    const old = result.stdout.toString('utf8').split('\0').slice(0, -1);
    if (old.length > 1) throw new GitError('身份配置有多个值，未自动覆盖。');
    const value = await ui.ask(label, old[0] ?? current[key]);
    if (/[\x00-\x1f\x7f]/u.test(value)) throw new GitError('姓名与邮箱不能含控制字符。');
    if (old[0] === value || scope === '--local' && !old.length && value === current[key]) continue;
    changes.push([key, old, value]);
  }
  if (!changes.length) { ui.text('身份没有变化，无需写入。'); return true; }
  for (const [key, old, value] of changes) ui.text(`${key}：${JSON.stringify(old[0] ?? '未设置')} → ${JSON.stringify(value)}`);
  if (!await ui.confirm('确认写入以上外部 Git 配置变更？')) return false;
  ui.text('逐项写入；中途失败时已完成项不会自动回滚。');
  for (const [key, , value] of changes) await git.run(['config', scope, '--', key, value]);
  ui.success('身份配置已写入。'); return true;
}
export async function publicKey(ui: Console, file: string, { managed = false } = {}): Promise<void> {
  if (!file.endsWith('.pub')) { ui.error('只接受 .pub 公钥文件，不会打开私钥。'); return; }
  let info;
  try { info = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { ui.error('找不到公钥；不会覆盖或自动恢复私钥。'); return; } throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 65536) { ui.error('公钥类型、链接或大小异常，不读取。'); return; }
  const publicText = (await readFile(file, 'utf8')).trim();
  if (!/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh.com|sk-ecdsa-sha2-nistp256@openssh.com) [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/u.test(publicText) || /[\x00-\x1f\x7f-\x9f]/u.test(publicText)) { ui.error('不是支持的单行 OpenSSH 公钥，不显示内容。'); return; }
  ui.text('下面是完整公钥，不是私钥，可复制到 GitHub；绝不要分享没有 .pub 后缀的文件。');
  ui.text(publicText); ui.text(`在正确账号下打开 ${KEYS_URL}，选择 New SSH key 添加公钥。`);
  ui.text(managed ? 'AutoGit 为绑定项目自动选钥，不需要手工编辑 SSH config 或启动 agent。' : '此为外部兼容路径，不修改 SSH config；非默认密钥可能需要手工配置。');
}
async function externalSshTest(ui: Console, directory: string): Promise<void> {
  if (!which('ssh')) throw new GitError('未找到 ssh。');
  ui.text('这是系统 SSH 测试，不代表 AutoGit 绑定账号或仓库写入权限。可能更新系统 known_hosts。');
  ui.text(`首次连接请独立核对主机指纹：${FINGERPRINTS_URL}；不确定就拒绝，不自动输入 yes。`);
  const result = await runProcess('ssh', ['-T', '-o', 'StrictHostKeyChecking=ask', 'git@github.com'], { cwd: directory, interactive: true });
  ui.warn(`SSH 退出码 ${result.status} 不足以判定认证成功。`);
  if (result.status === 1 && await ui.confirm("本次终端确实显示 Hi USER! You've successfully authenticated, but GitHub does not provide shell access.？")) ui.text('根据你的确认，本次系统 SSH 认证成功；不代表 Git 配置正确或拥有仓库写权限。');
  else ui.warn('未确认成功，请检查终端原始提示。');
}
async function sshWizard(ui: Console, directory: string): Promise<void> {
  for (;;) {
    const choice = await ui.menu('外部 SSH 兼容向导', ['查看默认 Ed25519 公钥', '查看默认 RSA 公钥', '指定已有 .pub 公钥', '生成外部默认 Ed25519 密钥（不覆盖）', '测试外部系统 SSH']);
    if (!choice) return;
    if (choice <= 3) { const file = choice === 3 ? await ui.ask('.pub 公钥路径') : join(homedir(), '.ssh', choice === 1 ? 'id_ed25519.pub' : 'id_rsa.pub'); const expanded = file === '~' ? homedir() : /^~[/\\]/u.test(file) ? join(homedir(), file.slice(2)) : file; await publicKey(ui, isAbsolute(expanded) ? expanded : resolve(directory, expanded)); }
    else if (choice === 5) await externalSshTest(ui, directory);
    else {
      const file = join(homedir(), '.ssh', 'id_ed25519');
      const absent = async () => { for (const name of [file, `${file}.pub`]) { try { await lstat(name); throw new GitError('默认私钥或公钥已存在，不覆盖。'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } } };
      await absent(); ui.text(`将生成外部默认密钥 ${JSON.stringify(file)}；口令只在原生工具输入，不会记录。`);
      if (!await ui.confirm('确认生成外部密钥？普通使用建议返回选软件账号。')) continue;
      await absent(); await mkdir(join(homedir(), '.ssh'), { recursive: true, mode: 0o700 });
      const result = await runProcess('ssh-keygen', ['-t', 'ed25519', '-f', file, '-C', 'GitHub'], { cwd: directory, interactive: true });
      if (!result.status) await publicKey(ui, `${file}.pub`); else ui.warn('生成未完成，请看原始提示，不自动重试或删除文件。');
    }
  }
}
export async function ghLogin(ui: Console, directory: string): Promise<void> {
  if (!which('gh')) { ui.warn('未找到 gh。github.com 个人账号可原生建库；组织建库、GitHub Enterprise、PR / Issue / Release 等高级功能仍需要 GitHub CLI：https://cli.github.com/。'); return; }
  await new GithubClient(directory).browserLogin(ui);
}
export async function diagnostics(ui: Console, directory: string): Promise<void> {
  ui.title('本地诊断（不联网，不读取私钥或令牌）'); dependencies(ui);
  const profile = await resolveBinding(directory);
  if (profile) { ui.text(`AutoGit 账号：${profile.label}\n提交署名：${profile.name} <${profile.email}>\n预期 GitHub 账号：${profile.github_login}（本次未联网验证）`); }
  else ui.warn('当前项目未绑定软件账号；GitHub SSH 操作前将要求选择。');
  const git = new Git(directory);
  ui.text('外部 Git 原有署名（软件绑定不会改写）：');
  for (const key of ['user.name', 'user.email']) ui.text(`${key}：${JSON.stringify(await git.config(key))}`);
  const overrides = ['GIT_SSH', 'GIT_SSH_COMMAND'].filter(name => process.env[name]);
  if (await git.config('core.sshCommand')) overrides.push('core.sshCommand');
  if (overrides.length) ui.warn(`存在外部 SSH 覆盖：${overrides.join('、')}（不显示内容）`);
  try { ui.text(`工作区：${JSON.stringify(await git.root())}`); } catch (error) { if (!(error instanceof GitError)) throw error; ui.warn('当前不是工作区，不初始化仓库。'); return; }
  ui.text('远程（已隐藏地址凭据和参数）：'); ui.text(redact(await git.value('remote', '-v')) || '未设置远程。');
  try { ui.text(`当前分支：${await git.branch()}`); } catch { ui.warn('当前分支不可解析或处于游离 HEAD。'); }
  const upstream = await git.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { check: false });
  if (upstream.status) ui.warn('未设置可解析上游。'); else ui.text(`上游：${upstream.stdout.toString('utf8').trim()}`);
  ui.text('本地诊断结束，没有进行网络认证。');
}
export async function setupWizard(ui: Console, directory: string): Promise<void> {
  const actions = [async () => dependencies(ui), () => configureIdentity(ui, directory), () => sshWizard(ui, directory), () => ghLogin(ui, directory), () => diagnostics(ui, directory), async () => {
    dependencies(ui); if (!which('git')) return;
    if (!await configureIdentity(ui, directory)) return;
    const choice = await ui.menu('外部认证方式', ['系统 SSH 向导', '可选 gh 浏览器登录', '暂不认证']);
    if (choice === 1) await sshWizard(ui, directory); else if (choice === 2) await ghLogin(ui, directory);
    ui.text('步骤结束；署名与认证相互独立，不代表拥有仓库写入权限。');
  }];
  for (;;) {
    const choice = await ui.menu('依赖与高级兼容配置（不是普通使用必经步骤）', ['检查依赖与安装指引', '配置外部 Git 提交身份', '外部 SSH 兼容向导', '可选 gh 浏览器登录', '仅本地诊断', '按步骤配置外部 Git']);
    if (!choice) return;
    try { await actions[choice - 1](); }
    catch (error) {
      if (error instanceof Cancelled) { if (error.warning) ui.warn(redact(error.message)); else ui.text('已返回，未确认项没有执行。'); }
      else if (error instanceof GitError || error instanceof Error && 'code' in error) ui.error(`操作未完成：${redact(String(error))}`);
      else throw error;
    }
  }
}
