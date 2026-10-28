import { resolveNativeHelper } from '../dist/auth.js';
try {
  const helper = await resolveNativeHelper();
  console.error(`Native helper verified for ${process.platform}-${process.arch}: ${helper}`);
} catch {
  console.error('原生密钥/权限助手缺失或校验失败。请先运行 npm run build:native；不会打包缺少必要原生组件的正式发行版。');
  process.exitCode = 1;
}
