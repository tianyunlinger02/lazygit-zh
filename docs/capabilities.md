# AutoGit 功能与缺口台账

版本目标：**0.5.0**。本表区分“代码是否有可运行入口”和“在哪些环境实际验收过”。菜单存在、假工具测试或计划文字都不能替代实测。

## 已实现或本版补齐

| 用户任务 | 状态 | 入口与范围 | 关键边界 |
|---|---|---|---|
| 首次配置、多账号、项目独立密钥 | 已实现 | 1 / 10；生成、导入、编辑、绑定、换认证、删除 | SSH profile、提交署名和 API actor 分开；仅改显示标签保留绑定；不保存 GitHub 明文密码/token |
| 项目选择、收藏、最近使用 | 已实现 | 9 / 20；列表、搜索、收藏、移除、路径重映射 | 独立 `projects.json`；不按同名目录猜绑定 |
| 下载已有项目 | 已实现 | 2；GitHub、Enterprise、普通 Git、HTTPS、SSH alias | 托管 SSH、原生 SSH、HTTPS 由项目传输配置选择；可复用已有空目录、名称冲突局部重问；失败不删除已下载目录 |
| 初始化、提交、本地保存 | 已实现 | 3 / 4 / 12 | 新仓库默认 main；已有仓库不自动改名；保留部分暂存 |
| 取消暂存 | 0.5.0 新增 | 15；按文件恢复 index，支持空 HEAD、删除、重命名、特殊字节路径 | 工作区内容不变 |
| 文件还原 | 0.5.0 新增 | 15；HEAD/index/指定提交 → worktree/index/both | 选择范围、来源和丢弃影响；不顺带 clean |
| revert / cherry-pick | 0.5.0 新增 | 17；普通/合并提交 mainline、冲突继续/跳过/中止 | 单个或多个固定 OID / 明确区间；revert 创建反向提交，cherry-pick 复制提交 |
| 普通 push / 独立仅上传 | 已实现 / 0.5.0 新增入口 | 4 / 14 / 16 | 固定单完整 refspec、`--no-follow-tags`；普通失败不会自动 force |
| force push | 0.5.0 新增 | 16；`force-with-lease` 或无条件 `--force` | lease 从实际 push URL 查询目标 OID；目标/源 OID变化停止；不推标签 |
| pull / fetch / 上游 | 已实现，有边界 | 5 / 7 | pull 仅 ff-only；不自动 stash、merge、rebase；多个远程明确选择 |
| remote 管理 | 0.5.0 新增 | 16；查看、fetch/push 列表替换/逐项添加移除、改名、移除、删除远程分支 | 不暗改其他 upstream；传输每次只处理单地址，多地址可拆为独立远程；外部 include 配置需在来源修改 |
| 分支 | 已实现并扩展 | 7；新建、切换、跟踪、改名、删除已合并、强删未合并 | 允许携带 Git 能保留的修改，不强制 stash；真正覆盖由 Git 拒绝；其他 worktree 占用及远程分支删除分别处理 |
| 合并和冲突 | 已实现并扩展 | 7 / 17；merge、stage 选择、ours/theirs、删除一侧、继续/中止 | 可显式合并独立历史，一次影响确认；不自动判断代码逻辑；rebase/cherry-pick 的 ours/theirs 语义单独说明 |
| stash | 已实现，有边界 | 11 | 可包含未跟踪但不含 ignored；恢复失败保留现场，不冒充 merge 恢复 |
| rebase / bisect | 0.5.0 新增 | 17；变基开始/继续/跳过/中止、交互式 todo；手工 good/bad/skip/reset | 正确区分 rebase 与 am，允许合法 detached HEAD；不自动运行待测仓库命令 |
| reset | 0.5.0 新增 | 15；soft / mixed / hard | hard 可能删除阻挡 tracked 路径的 untracked/ignored；不强制先 stash/备份；托管 data 受保护 |
| clean | 0.5.0 新增 | 15；普通未跟踪、仅 ignored、两者；嵌套仓库二次 force 独立 | 预览与执行同 scope；clean 删除不能由 reflog 恢复；托管 data/私钥/known_hosts 不纳入普通项目清理 |
| 历史、详情、搜索、图、reflog | 0.5.0 新增 | 6 / 18 | 本地提交和远程缓存；reflog 可创建恢复分支，不是未提交内容备份 |
| .gitignore、README、许可证 | 0.5.0 新增 | 21 → 模板 | 规则/文件生成不自动提交；停止跟踪只改 index；忽略规则不能撤销历史泄露 |
| 大文件自动忽略 | 已实现 | 3 / 4 / 12；选择提交文件前默认检查 | 超过 50 MiB 的全新未跟踪普通文件自动追加精确 `.gitignore` 规则，无需确认、不使用 LFS；不删除文件、不改变已有跟踪/暂存；规则写入失败时只跳过对应文件 |
| worktree | 0.5.0 新增 | 21 | 创建、列表、切换、移动、锁定/解锁、移除、prune；不按 common-dir 猜 profile |
| 子模块 | 0.5.0 新增 | 21 | 添加、初始化、更新、状态、进入、移除；默认不递归改子模块工作区 |
| Git LFS | 0.5.0 新增 | 21 | 依赖外部 git-lfs；检测、track/untrack、status、fetch/pull/push；endpoint 与 Git remote 分开核对 |
| GitHub 个人/组织仓库 | 已实现并扩展 | 3 / 19 | 个人建库公开/私有；组织 owner 与认证 actor 分开；空仓库不隐式加 README |
| GitHub 仓库列表、搜索、查看、fork | 0.5.0 新增 | 19 | fork 不隐式 clone/add-remote；明确 source/upstream/push 目标 |
| SSH 公钥授权 | 0.5.0 新增 | 19 | 只读取明确 `.pub`，通过 gh 上传；不读取私钥；授权不等于仓库写权限 |
| Pull Request / Review | 0.5.0 新增 | 19 | 列表、查看正文/差异/评论、创建、checkout、评论、review、合并、关闭/重开；checkout 重名可另名/仅切换/显式重建 |
| Issues | 0.5.0 新增 | 19 | 列表、查看、创建、编辑、评论、关闭/重开 |
| 标签和 Release | 0.5.0 新增 | 19 | 单标签 refspec；Release 创建/编辑/发布/查看、附件上传/下载/删除；本地下载可换名/显式覆盖，失败保留原件；覆盖和删 tag 明确列出 |
| 仓库管理 | 0.5.0 新增 | 19 | 可见性、改名、删除、协作者/团队权限操作；服务端与本地 remote 分开报告 |
| 主机和传输 | 0.5.0 新增 | 21 | GitHub.com、Enterprise、通用 Git；托管 SSH、原生 SSH、HTTPS；alias/端口/代理/跳板由明确模式控制 |
| 资料备份、恢复、搬迁 | 0.5.0 新增 | 21 | `manifest.json + files/`、完整性校验、路径/链接/硬链接检查、staging 后切换；默认保留源 |
| 快捷模式 | 已实现并调整 | 13 | 日常只读/提交/同步少确认；破坏性写入一次摘要硬确认 |

## 高级操作的确认规则

- 普通 push/pull 不会因为失败自动升级为 force、merge 或 rebase。
- 强推、hard reset、clean、强删分支、远程删分支、仓库删除/改名/可见性修改、资料替换/删除源等操作都可执行；它们先显示目标、OID、范围和影响，再一次 `confirm`。
- 选择“无条件 force”就是选择无条件 force，不会被软件改成 lease；lease 查询失败也不能被当作“远端不存在”。
- reset/clean 不要求用户先 stash 或备份。可选恢复分支或备份会准确说明只包含哪些 Git 对象/文件，不能把 reflog 或 SHA-256 说成未提交内容恢复或加密。

## 仍有范围边界

这些不是因为“担心安全”而隐藏的拒绝，而是服务/平台或实现边界：

- 通用 Git 服务支持 Git 传输；非 GitHub 的专有 PR、Issue、Review、Release API 需要对应 provider，不能把 GitHub API 换域名冒充通用。
- GitHub/Enterprise 的权限、分支保护、SSO/组织审批由服务器决定，AutoGit 不绕过；失败保留已完成步骤和恢复入口。
- 不复制 Git/gh 的每一个冷门参数；高级菜单覆盖本台账列出的完整日常闭环。
- hooks、filters、ProxyCommand、外部凭据/签名工具可能有自己的副作用；AutoGit 不把不可信仓库变成沙箱。
- LFS 需要用户自行安装外部 `git-lfs`；AutoGit 不自动下载安装程序。大文件自动忽略是独立的 `.gitignore` 规则，不调用、不安装、不配置 Git LFS。worktree/子模块检出跳过 LFS 自动下载，需在对应仓库明确拉取 LFS 对象。
- 交互式 rebase 使用原生 todo 编辑器；`am` 支持恢复已有操作，不提供新的邮件补丁导入向导。GitHub 差异展示上限 16 MiB、附件单文件上限 64 MiB，不是 GitHub 所有参数和接口的复制。

## 资料与 schema

- AutoGit 资料仍在独立文件夹，不进入 npm 包；profiles/bindings schema 2、settings schema 1 保持兼容。
- 新增 `projects.json`、`hosts.json` 和备份目录使用独立 schema 1，不把收藏/主机配置硬塞入既有 settings。
- 备份可以包含免口令托管私钥；备份是未加密文件，SHA-256 只用于完整性检查。外部 gh token/config、机器 location pointer 不在备份范围内。
- 项目移动后必须明确旧根→新根映射；不按目录名猜账号。SSH 程序绝对路径跨系统可能需要重新选择。

## 环境验收

源码交付目录只保留当前版本的一套正式证据。0.5.0 的集中验收以 `artifacts/verification-0.5.0.txt`、`artifacts/release-0.5.0.json` 和对应测试日志为准，由 `npm run verify` 更新；这些报告不随 npm 包安装。按实际结果记录通过与跳过：

- Linux / Node 22 的本地 bare、fake gh、PTY、真实 CLI：可验证离线功能闭环；
- Windows、Node 24、真实 GitHub/Enterprise 登录、组织权限、PR/Issue/Release、真实 LFS 服务、SSH alias/代理/跳板：没有实测记录就保持“未验证”；
- 不读取个人私钥/token/外部 gh 配置，不进行真实 GitHub 写操作；不公开发布 npm；不默默替换既有全局安装。

每次新增功能必须同步入口、取消、失败恢复、离线测试、实际环境证据和本台账；不能只因为菜单里出现一项就标成完成。
